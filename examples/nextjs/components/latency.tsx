'use client';

import { useEffect, useRef } from 'react';
import { useWebSocketLatency } from 'react-websocket';
import { latency } from '@/lib/live';

const ms = (value: number | undefined) => (value === undefined ? '–' : `${Math.round(value)} ms`);

export function Latency() {
  // Re-renders about once per ping (every 2 s), not every frame.
  const { rtt, offset } = useWebSocketLatency(latency);
  return (
    <dl className="facts">
      <dt>Round trip</dt>
      <dd>{ms(rtt)}</dd>
      <dt>Server clock offset</dt>
      <dd>{ms(offset)}</dd>
      <dt>Server time</dt>
      <dd>
        <Clock now={latency.serverNow} />
      </dd>
      <dt>Your time</dt>
      <dd>
        <Clock now={Date.now} />
      </dd>
    </dl>
  );
}

/** Updates every frame by writing to the DOM directly, without re-rendering. */
function Clock({ now }: { now: () => number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const time = new Date(now());
      if (ref.current) {
        ref.current.textContent = `${time.toLocaleTimeString([], { hour12: false })}.${String(time.getMilliseconds()).padStart(3, '0')}`;
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [now]);
  return <span ref={ref} className="mono" />;
}
