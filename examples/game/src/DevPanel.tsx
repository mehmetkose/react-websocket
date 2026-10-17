import { useState } from 'react';
import type { ChaosRange } from 'react-websocket/chaos';
import { Chaos, settings } from './net';

// One-way delays: a round trip takes about twice as long.
const PRESETS: Record<string, ChaosRange> = {
  LAN: 0,
  Good: 30,
  Mobile: [60, 120],
  Bad: [100, 300]
};

/** Network faults (through react-websocket/chaos) and rendering switches, to compare. */
export function DevPanel() {
  const [network, setNetwork] = useState('LAN');
  const [loss, setLoss] = useState({ in: 0, out: 0 });
  const [view, setView] = useState(settings);

  function pick(name: string) {
    setNetwork(name);
    Chaos.configure({ latency: PRESETS[name]! });
  }

  function lose(direction: 'in' | 'out', on: boolean) {
    const next = { ...loss, [direction]: on ? 0.05 : 0 };
    setLoss(next);
    Chaos.configure({ loss: next });
  }

  function change(patch: Partial<typeof settings>) {
    Object.assign(settings, patch); // read by the render loop on the next frame
    setView({ ...settings });
  }

  return (
    <section className="panel">
      <fieldset>
        <legend>Network</legend>
        <div className="row">
          {Object.keys(PRESETS).map(name => (
            <label key={name}>
              <input
                type="radio"
                name="network"
                checked={network === name}
                onChange={() => pick(name)}
              />
              {name}
            </label>
          ))}
        </div>
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={loss.out > 0}
              onChange={e => lose('out', e.target.checked)}
            />
            Lose 5% of my inputs
          </label>
          <label>
            <input
              type="checkbox"
              checked={loss.in > 0}
              onChange={e => lose('in', e.target.checked)}
            />
            Lose 5% of snapshots
          </label>
        </div>
        <div className="row">
          <button onClick={() => Chaos.drop()}>Drop the connection</button>
          <button onClick={() => Chaos.stall()}>Stall it</button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Rendering</legend>
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={view.interpolate}
              onChange={e => change({ interpolate: e.target.checked })}
            />
            Interpolate others
          </label>
          <label>
            <input
              type="checkbox"
              checked={view.predict}
              onChange={e => change({ predict: e.target.checked })}
            />
            Predict my moves
          </label>
          <label>
            <input
              type="checkbox"
              checked={view.ghost}
              onChange={e => change({ ghost: e.target.checked })}
            />
            Show where the server has me
          </label>
        </div>
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={view.autoDelay}
              onChange={e => change({ autoDelay: e.target.checked })}
            />
            Automatic delay
          </label>
          <label>
            Delay {view.delay} ms
            <input
              type="range"
              min={0}
              max={300}
              step={10}
              value={view.delay}
              disabled={view.autoDelay}
              onChange={e => change({ delay: Number(e.target.value) })}
            />
          </label>
        </div>
      </fieldset>
    </section>
  );
}
