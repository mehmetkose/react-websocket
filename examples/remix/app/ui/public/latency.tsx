import { clientEntry, ref, type Handle } from 'remix/component';
import { watchLatency } from '../../live/public/bindings.ts';
import { latency } from '../../live/public/live.ts';

const ms = (value: number | undefined) => (value === undefined ? '–' : `${Math.round(value)} ms`);

export const Latency = clientEntry(import.meta.url, function Latency(handle: Handle) {
  // Re-renders about once per ping (every 2 s), not every frame.
  const measured = watchLatency(handle, latency);
  return () => {
    const { rtt, offset } = measured();
    return (
      <dl class="facts">
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
  };
});

/** Updates every frame by writing to the DOM directly, without re-rendering. */
function Clock(handle: Handle<{ now: () => number }>) {
  return () => (
    <span
      class="mono"
      mix={ref((node, signal) => {
        let frame = 0;
        const tick = () => {
          const time = new Date(handle.props.now());
          node.textContent = `${time.toLocaleTimeString([], { hour12: false })}.${String(time.getMilliseconds()).padStart(3, '0')}`;
          frame = requestAnimationFrame(tick);
        };
        tick();
        signal.addEventListener('abort', () => cancelAnimationFrame(frame), { once: true });
      })}
    />
  );
}
