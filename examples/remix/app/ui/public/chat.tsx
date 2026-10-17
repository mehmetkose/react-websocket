import { clientEntry, on, type Handle } from 'remix/component';
import { listen } from '../../live/public/bindings.ts';
import { live } from '../../live/public/live.ts';
import type { ServerMessage } from '../../live/public/protocol.ts';

type ChatMessage = Extract<ServerMessage, { type: 'chat' }>;

export const Chat = clientEntry(import.meta.url, function Chat(handle: Handle) {
  let messages: ChatMessage[] = [];
  let queued = 0;

  listen(handle, live, 'message', message => {
    if (message.type !== 'chat') return;
    messages = [...messages, message].slice(-20);
    void handle.update();
  });
  // Queued messages go out right after `open` listeners run.
  listen(handle, live, 'open', () => {
    queued = 0;
    void handle.update();
  });

  return () => (
    <>
      <ul class="chat">
        {messages.map(message => (
          <li key={message.id}>
            <span class="muted">{message.from}</span> {message.text}
          </li>
        ))}
      </ul>
      <form
        class="row"
        mix={on('submit', event => {
          event.preventDefault();
          const form = event.currentTarget;
          const text = String(new FormData(form).get('text') ?? '').trim();
          if (!text) return;
          // Sent now if open; otherwise queued (up to `queue.limit`) and sent on reconnect.
          if (!live.send({ type: 'chat', text })) queued++;
          form.reset();
          void handle.update();
        })}
      >
        <input name="text" placeholder="Say something" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
      {queued > 0 && <p class="note">{queued} queued until the connection is back</p>}
    </>
  );
});
