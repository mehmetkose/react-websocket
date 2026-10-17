import { clientEntry, type Handle } from 'remix/component';
import { watchState, watchStatus } from '../../live/public/bindings.ts';
import { live, me } from '../../live/public/live.ts';

/**
 * Re-renders only when the status or the name changes, not on every message. It's in the header
 * of every page, so client navigation keeps it mounted, and it holds the connection open while
 * one page's cards leave and the next page's hydrate.
 */
export const StatusBadge = clientEntry(import.meta.url, function StatusBadge(handle: Handle) {
  const status = watchStatus(handle, live);
  const name = watchState(handle, me);
  return () => (
    <span class="status">
      <span class="badge" data-status={status()}>
        {status()}
      </span>
      {status() === 'open' && name() && <span class="muted">as {name()}</span>}
    </span>
  );
});
