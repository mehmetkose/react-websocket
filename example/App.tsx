import { Suspense, use, useState, type FormEvent, type ReactNode } from 'react';
import { createWebSocket, useWebSocket, useWebSocketEvent } from '../src';

const URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8888/live';

interface ChatMessage {
  text: string;
  at: number;
}

// One shared connection for the whole app; the server broadcasts every message to all clients.
const live = createWebSocket<ChatMessage, ChatMessage>(URL, {
  json: true,
  logger: console.debug
});

function Composer() {
  const [text, setText] = useState('');
  const { status, send, close, reconnect, attempt } = useWebSocket(live);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text) return;
    send({ text, at: Date.now() }); // queued if we're not connected yet
    setText('');
  }

  return (
    <>
      <p>
        Status:{' '}
        <span className="status" data-status={status}>
          {status}
          {status === 'reconnecting' ? ` (attempt ${attempt})` : ''}
        </span>{' '}
        <button onClick={reconnect}>Reconnect</button> <button onClick={() => close()}>Close</button>
      </p>
      <form onSubmit={submit}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Say something" />{' '}
        <button>Send</button>
      </form>
    </>
  );
}

function Log() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Appends without this component subscribing to every status change.
  useWebSocketEvent(live, 'message', message => setMessages(list => [...list, message].slice(-50)));
  return (
    <ul>
      {messages.map(m => (
        <li key={m.at + m.text}>
          {new Date(m.at).toLocaleTimeString()} — {m.text}
        </li>
      ))}
    </ul>
  );
}

function Connected({ children }: { children: ReactNode }) {
  use(live.ready); // suspends until the first connection opens
  return children;
}

export default function App() {
  return (
    <>
      <Composer />
      <Suspense fallback={<p>Waiting for the server…</p>}>
        <Connected>
          <Log />
        </Connected>
      </Suspense>
    </>
  );
}
