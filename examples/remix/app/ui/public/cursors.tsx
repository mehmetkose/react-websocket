import { clientEntry, on, type Handle } from 'remix/component';
import { watchState } from '../../live/public/bindings.ts';
import { live, peers } from '../../live/public/live.ts';

const COLORS = ['#e5484d', '#30a46c', '#0090ff', '#f76b15', '#8e4ec6', '#12a594'];

export const Cursors = clientEntry(import.meta.url, function Cursors(handle: Handle) {
  // Re-renders only when the peers change, not on every message.
  const others = watchState(handle, peers);
  let color: string | null = null;

  function pick(next: string) {
    color = next;
    void handle.update();
    // Keyed: change it several times while offline and only the last choice is sent.
    live.send({ type: 'color', color: next }, { key: 'color' });
  }

  return () => {
    const cursors = Object.entries(others());
    return (
      <>
        <div
          class="pad"
          mix={on('pointermove', event => {
            const box = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - box.left) / box.width;
            const y = (event.clientY - box.top) / box.height;
            // Volatile: a position is stale by the time a reconnect finishes, so it's dropped,
            // not queued.
            live.send({ type: 'cursor', x, y }, { volatile: true });
          })}
        >
          {cursors.map(([id, cursor]) => (
            <span
              key={id}
              class="cursor"
              title={id}
              style={{
                left: `${cursor.x * 100}%`,
                top: `${cursor.y * 100}%`,
                backgroundColor: cursor.color
              }}
            />
          ))}
          {cursors.length === 0 && (
            <span class="muted">Open this page in another tab and move the pointer there.</span>
          )}
        </div>
        <div class="row">
          <span class="muted">Your color:</span>
          {COLORS.map(swatch => (
            <button
              key={swatch}
              type="button"
              class="swatch"
              aria-label={swatch}
              aria-pressed={swatch === color ? 'true' : 'false'}
              style={{ background: swatch }}
              mix={on('click', () => pick(swatch))}
            />
          ))}
        </div>
      </>
    );
  };
});
