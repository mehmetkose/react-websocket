import { useState, type PointerEvent } from 'react';
import { useWebSocketState } from 'react-websocket';
import { live, peers } from '../lib/live';

const COLORS = ['#e5484d', '#30a46c', '#0090ff', '#f76b15', '#8e4ec6', '#12a594'];

export function Cursors() {
  // Re-renders only when the peers change, not on every message.
  const others = useWebSocketState(peers);
  const [color, setColor] = useState<string | null>(null);

  function move(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    // Volatile: a position is stale by the time a reconnect finishes, so it's dropped, not queued.
    live.send({ type: 'cursor', x, y }, { volatile: true });
  }

  function pick(next: string) {
    setColor(next);
    // Keyed: change it several times while offline and only the last choice is sent.
    live.send({ type: 'color', color: next }, { key: 'color' });
  }

  const ids = Object.keys(others);
  return (
    <>
      <div className="pad" onPointerMove={move}>
        {ids.map(id => (
          <span
            key={id}
            className="cursor"
            title={id}
            style={{
              left: `${others[id]!.x * 100}%`,
              top: `${others[id]!.y * 100}%`,
              backgroundColor: others[id]!.color
            }}
          />
        ))}
        {ids.length === 0 && (
          <span className="muted">Open this page in another tab and move the pointer there.</span>
        )}
      </div>
      <div className="row">
        <span className="muted">Your color:</span>
        {COLORS.map(swatch => (
          <button
            key={swatch}
            className="swatch"
            aria-label={swatch}
            aria-pressed={swatch === color}
            style={{ background: swatch }}
            onClick={() => pick(swatch)}
          />
        ))}
      </div>
    </>
  );
}
