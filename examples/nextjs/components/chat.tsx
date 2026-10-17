'use client';

import { useState, type FormEvent } from 'react';
import { useWebSocketEvent } from 'react-websocket';
import { live } from '@/lib/live';
import type { ServerMessage } from '@/lib/protocol';

type ChatMessage = Extract<ServerMessage, { type: 'chat' }>;

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [queued, setQueued] = useState(0);

  useWebSocketEvent(live, 'message', message => {
    if (message.type === 'chat') setMessages(list => [...list, message].slice(-20));
  });
  // Queued messages go out right after `open` listeners run.
  useWebSocketEvent(live, 'open', () => setQueued(0));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    // Sent now if open; otherwise queued (up to `queue.limit`) and sent on reconnect.
    if (!live.send({ type: 'chat', text })) setQueued(count => count + 1);
    setText('');
  }

  return (
    <>
      <ul className="chat">
        {messages.map(message => (
          <li key={message.id}>
            <span className="muted">{message.from}</span> {message.text}
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={submit}>
        <input
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="Say something"
        />
        <button>Send</button>
      </form>
      {queued > 0 && <p className="note">{queued} queued until the connection is back</p>}
    </>
  );
}
