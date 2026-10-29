import { Suspense, use, useState, type FormEvent, type ReactNode } from 'react';
import {
  useWebSocket,
  useWebSocketEvent,
  useWebSocketState,
  useWebSocketStatus,
  type CloseInfo
} from 'react-websocket';
import { OUTDATED } from './protocol';
import { chat, live, Refused, room } from './live';

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

/** What the server asked for when it closed the connection, if anything. */
function ServerNotice() {
  const status = useWebSocketStatus(live);
  const [last, setLast] = useState<CloseInfo>();
  // `close` listeners run after the status has changed.
  useWebSocketEvent(live, 'close', setLast);
  if (status === 'closed' && last?.code === OUTDATED) {
    return (
      <p role="alert" className="row">
        A new version is available. <button onClick={() => location.reload()}>Reload</button>
      </p>
    );
  }
  if (status === 'reconnecting' && last?.code === 1013) {
    return (
      <p role="status" className="muted">
        The room is full. Trying again in about {last.reason} seconds.
      </p>
    );
  }
  return null;
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

interface Pending {
  key: string;
  text: string;
  state: 'sending' | 'refused' | 'unconfirmed';
  reason?: string;
}

function Composer() {
  const [text, setText] = useState('');
  // Messages the server hasn't posted. A posted message leaves the list: the room shows it.
  const [pending, setPending] = useState<Pending[]>([]);
  const offline = useWebSocketStatus(live) !== 'open';

  function update(key: string, change?: Partial<Pending>) {
    setPending(list =>
      change
        ? list.map(item => (item.key === key ? { ...item, ...change } : item))
        : list.filter(item => item.key !== key)
    );
  }

  // A retry passes the same key, so the server posts the message once.
  async function post(text: string, key: string) {
    update(key, { state: 'sending' });
    try {
      await chat.request({ key, text });
      update(key);
    } catch (error) {
      // A refusal is the server's answer. Anything else (a timeout, a lost connection) means
      // it may or may not have the message.
      update(
        key,
        error instanceof Refused
          ? { state: 'refused', reason: error.message }
          : { state: 'unconfirmed' }
      );
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const key = crypto.randomUUID();
    setPending(list => [...list, { key, text, state: 'sending' }]);
    // Sent now if open; otherwise queued and sent in order on reconnect.
    post(text, key);
    setText('');
  }

  return (
    <>
      <form className="row" onSubmit={submit}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Say something" />
        <button>Send</button>
      </form>
      {pending.length > 0 && (
        <ul className="pending">
          {pending.map(item => (
            <li key={item.key} className="row">
              <span className="text">{item.text}</span>
              {item.state === 'sending' && (
                <span className="muted">
                  {offline ? 'waiting for the connection…' : 'sending…'}
                </span>
              )}
              {item.state === 'refused' && (
                <>
                  <span role="alert">Not posted: {item.reason}</span>
                  <button onClick={() => update(item.key)}>Dismiss</button>
                </>
              )}
              {item.state === 'unconfirmed' && (
                <>
                  <span role="alert">No answer from the server.</span>
                  <button onClick={() => post(item.text, item.key)}>Try again</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
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
      <ServerNotice />
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
