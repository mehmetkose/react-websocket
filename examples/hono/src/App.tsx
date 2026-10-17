import { Suspense, use, useState, type FormEvent, type ReactNode } from 'react';
import { useWebSocket, useWebSocketEvent, useWebSocketState } from 'react-websocket';
import { live, room } from './live';

function Status() {
  const { status, attempt, close, reconnect } = useWebSocket(live);
  const me = useWebSocketState(room, state => state.me);
  return (
    <p className="row">
      <span className="status" data-status={status}>
        {status}
        {status === 'reconnecting' ? ` (attempt ${attempt})` : ''}
      </span>
      {me && <span className="muted">You are {me}</span>}
      <button onClick={reconnect}>Reconnect</button>
      <button onClick={() => close()}>Close</button>
    </p>
  );
}

function Online() {
  // Re-renders only when the list changes, not on every chat message.
  const online = useWebSocketState(room, state => state.online);
  return (
    <p className="muted">
      {online.length} online: {online.join(', ')}
    </p>
  );
}

function Messages() {
  const messages = useWebSocketState(room, state => state.messages);
  if (messages.length === 0) return <p className="muted">No messages yet.</p>;
  return (
    <ul>
      {messages.map(message => (
        <li key={message.id}>
          <span className="muted">
            {new Date(message.at).toLocaleTimeString()} {message.from}
          </span>{' '}
          {message.text}
        </li>
      ))}
    </ul>
  );
}

function Composer() {
  const [text, setText] = useState('');
  const [queued, setQueued] = useState(0);
  // Queued messages go out right after `open` listeners run.
  useWebSocketEvent(live, 'open', () => setQueued(0));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    // Sent now if open; otherwise queued and sent in order on reconnect.
    if (!live.send({ type: 'chat', text })) setQueued(count => count + 1);
    setText('');
  }

  return (
    <form className="row" onSubmit={submit}>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Say something" />
      <button>Send</button>
      {queued > 0 && <span className="muted">{queued} queued until the connection is back</span>}
    </form>
  );
}

function Connected({ children }: { children: ReactNode }) {
  use(live.ready); // suspends until the first connection opens, and not again on reconnects
  return children;
}

export default function App() {
  return (
    <>
      <Status />
      <Suspense fallback={<p className="muted">Waiting for the server…</p>}>
        <Connected>
          <Online />
          <Messages />
        </Connected>
      </Suspense>
      <Composer />
    </>
  );
}
