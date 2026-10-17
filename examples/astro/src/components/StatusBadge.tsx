import { useWebSocketState, useWebSocketStatus } from 'react-websocket';
import { live, me } from '../lib/live';

/**
 * Re-renders only when the status or the name changes, not on every message. The layout
 * persists this island across page navigations, so it holds the connection open while the page
 * swaps: the name only changes when the socket really reconnects.
 */
export function StatusBadge() {
  const status = useWebSocketStatus(live);
  const name = useWebSocketState(me);
  return (
    <span className="status">
      <span className="badge" data-status={status}>
        {status}
      </span>
      {status === 'open' && name && <span className="muted">as {name}</span>}
    </span>
  );
}
