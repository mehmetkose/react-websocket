import { MessageError } from 'react-websocket/core';
import { clientEntry, on, type Handle } from 'remix/component';
import { listen, watchSnapshot } from '../../live/public/bindings.ts';
import { live } from '../../live/public/live.ts';
import type { ClientMessage } from '../../live/public/protocol.ts';

type Chaos = Extract<ClientMessage, { type: 'chaos' }>['action'];

const time = () => new Date().toLocaleTimeString([], { hour12: false });
let eventId = 0;

export const Connection = clientEntry(import.meta.url, function Connection(handle: Handle) {
  // Re-renders on status changes and on every message (for `lastMessage`).
  const snapshot = watchSnapshot(handle, live);
  let events: { id: number; text: string }[] = [];
  const log = (text: string) => {
    events = [{ id: ++eventId, text: `${time()}  ${text}` }, ...events].slice(0, 8);
    void handle.update();
  };

  // Event listeners don't re-render by themselves; `log` does.
  listen(handle, live, 'open', () => log('open'));
  listen(handle, live, 'close', ({ code, reason }) =>
    log(`close ${code}${reason ? `: ${reason}` : ''}`)
  );
  listen(handle, live, 'error', error =>
    log(
      error instanceof MessageError
        ? `MessageError: ${error.message}`
        : error instanceof Error
          ? `error: ${error.message}`
          : 'socket error'
    )
  );

  const chaos = (action: Chaos) => {
    live.send({ type: 'chaos', action });
  };

  return () => {
    const { status, attempt, lastMessage } = snapshot();
    return (
      <>
        <dl class="facts">
          <dt>Status</dt>
          <dd>
            {status}
            {attempt > 0 && ` (attempt ${attempt})`}
          </dd>
          <dt>Last message</dt>
          <dd>{lastMessage ? lastMessage.type : '–'}</dd>
        </dl>
        <div class="row">
          <button type="button" mix={on('click', () => live.reconnect())}>
            Reconnect
          </button>
          <button type="button" mix={on('click', () => live.close())}>
            Close
          </button>
        </div>
        <p class="label">Make the server misbehave</p>
        <div class="row">
          <button type="button" mix={on('click', () => chaos('drop'))}>
            Drop the connection
          </button>
          <button type="button" mix={on('click', () => chaos('silence'))}>
            Go silent
          </button>
          <button type="button" mix={on('click', () => chaos('refuse'))}>
            Refuse me
          </button>
          <button type="button" mix={on('click', () => chaos('garbage'))}>
            Send bad data
          </button>
        </div>
        <ol class="log">
          {events.map(event => (
            <li key={event.id}>{event.text}</li>
          ))}
        </ol>
      </>
    );
  };
});

/**
 * Waits for `ready`, the promise a React component passes to `use()` to suspend. It resolves
 * when the first connection opens and stays resolved through reconnects. It rejects after
 * `close()` or when the client gives up, and reconnecting makes it pending again.
 */
export const FirstConnection = clientEntry(
  import.meta.url,
  function FirstConnection(handle: Handle) {
    let text = 'Waiting for the first connection…';
    const wait = () => {
      live.ready
        .then(
          () => {
            text = `First connected at ${time()}. Reconnects don’t make ready pending again.`;
          },
          (error: Error) => {
            text = `ready rejected: ${error.message}. Reconnect to wait again.`;
            const off = live.subscribe(() => {
              if (live.getSnapshot().status === 'closed') return;
              off();
              wait();
            });
            handle.signal.addEventListener('abort', off, { once: true });
          }
        )
        .then(() => {
          if (!handle.signal.aborted) void handle.update();
        });
    };
    // Coming back from the About page, the connection is already open and this updates at once.
    handle.queueTask(wait);
    return () => <p class="muted">{text}</p>;
  }
);
