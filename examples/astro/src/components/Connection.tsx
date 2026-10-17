import { Suspense, use, useState } from 'react';
import { MessageError, useWebSocket, useWebSocketEvent } from 'react-websocket';
import { live } from '../lib/live';
import type { ClientMessage } from '../lib/protocol';

type Chaos = Extract<ClientMessage, { type: 'chaos' }>['action'];

const time = () => new Date().toLocaleTimeString([], { hour12: false });
let eventId = 0;

export function Connection() {
  // Re-renders on status changes and on every message (for `lastMessage`).
  const { status, attempt, lastMessage, send, close, reconnect } = useWebSocket(live);
  const [events, setEvents] = useState<{ id: number; text: string }[]>([]);
  const log = (text: string) => {
    const entry = { id: ++eventId, text: `${time()}  ${text}` };
    setEvents(list => [entry, ...list].slice(0, 8));
  };

  // Event listeners don't re-render by themselves and always see the latest state.
  useWebSocketEvent(live, 'open', () => log('open'));
  useWebSocketEvent(live, 'close', ({ code, reason }) =>
    log(`close ${code}${reason ? `: ${reason}` : ''}`)
  );
  useWebSocketEvent(live, 'error', error =>
    log(
      error instanceof MessageError
        ? `MessageError: ${error.message}`
        : error instanceof Error
          ? `error: ${error.message}`
          : 'socket error'
    )
  );

  const chaos = (action: Chaos) => send({ type: 'chaos', action });

  return (
    <>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          {status}
          {attempt > 0 && ` (attempt ${attempt})`}
        </dd>
        <dt>Last message</dt>
        <dd>{lastMessage ? lastMessage.type : '–'}</dd>
      </dl>
      <div className="row">
        <button onClick={reconnect}>Reconnect</button>
        <button onClick={() => close()}>Close</button>
      </div>
      <p className="label">Make the server misbehave</p>
      <div className="row">
        <button onClick={() => chaos('drop')}>Drop the connection</button>
        <button onClick={() => chaos('silence')}>Go silent</button>
        <button onClick={() => chaos('refuse')}>Refuse me</button>
        <button onClick={() => chaos('garbage')}>Send bad data</button>
      </div>
      <ol className="log">
        {events.map(event => (
          <li key={event.id}>{event.text}</li>
        ))}
      </ol>
    </>
  );
}

/**
 * A `client:only` island: Astro never renders it on the server, where there is nothing to wait
 * for. Each island is its own React root, so the Suspense boundary lives inside it.
 */
export function FirstConnection() {
  return (
    <Suspense fallback={<p className="muted">Waiting for the first connection…</p>}>
      <OpenedAt />
    </Suspense>
  );
}

/**
 * Suspends until the first connection opens. `ready` stays resolved through reconnects, so
 * this never flashes back to the fallback on a network blip. Coming back from another page
 * remounts it, and it renders straight away: the connection is already open.
 */
function OpenedAt() {
  use(live.ready);
  const [renderedAt] = useState(time);
  return (
    <p className="muted">
      Rendered at {renderedAt}, once <code>ready</code> resolved. Reconnects don’t suspend it again.
    </p>
  );
}
