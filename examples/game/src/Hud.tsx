import { useSyncExternalStore } from 'react';
import { useWebSocketLatency, useWebSocketState, useWebSocketStatus } from 'react-websocket';
import { game, latency, roster, timeline } from './net';

const ms = (value: number | undefined) => (value === undefined ? '–' : `${Math.round(value)} ms`);

// `latest` changes when the timeline notifies, so it's safe to read through
// useSyncExternalStore. `at()` and `predicted()` change with time and aren't.
const getAck = () => timeline.latest()?.ack;

/** Status, ping and the player list. Renders a few times a second at most. */
export function Hud() {
  const status = useWebSocketStatus(game);
  const { rtt, offset } = useWebSocketLatency(latency);
  const ack = useSyncExternalStore(timeline.subscribe, getAck, () => undefined);
  const players = useWebSocketState(roster);

  return (
    <section className="hud">
      <p className="row">
        <span className="status" data-status={status}>
          {status}
        </span>
        <span>Ping {ms(rtt)}</span>
        <span className="muted">
          Server clock {offset === undefined ? '–' : `${offset > 0 ? '+' : ''}${ms(offset)}`}
        </span>
        <span className="muted">Confirmed input #{ack ?? '–'}</span>
      </p>
      <ul className="row roster">
        {players.map(player => (
          <li key={player.id}>
            <span className="dot" style={{ background: player.color }} />
            {player.you ? 'you' : player.bot ? `${player.id} (bot)` : player.id}
          </li>
        ))}
      </ul>
    </section>
  );
}
