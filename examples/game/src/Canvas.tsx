import { useEffect, useRef } from 'react';
import { useWebSocketStatus } from 'react-websocket';
import { game, settings, timeline } from './net';
import { ARENA, MAX_STEPS, RADIUS, STEP_MS, type Move, type Player } from './sim';

const KEYS: Record<string, [dx: -1 | 0 | 1, dy: -1 | 0 | 1]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  w: [0, -1],
  s: [0, 1]
};

function direction(held: Set<string>): Pick<Move, 'dx' | 'dy'> {
  let dx = 0;
  let dy = 0;
  for (const key of held) {
    dx += KEYS[key]![0];
    dy += KEYS[key]![1];
  }
  return { dx: Math.sign(dx) as Move['dx'], dy: Math.sign(dy) as Move['dy'] };
}

function draw(
  context: CanvasRenderingContext2D,
  players: Record<string, Player>,
  you: string | undefined,
  ghost: Player | undefined
) {
  context.clearRect(0, 0, ARENA.width, ARENA.height);
  for (const [id, player] of Object.entries(players)) {
    context.beginPath();
    context.arc(player.x, player.y, RADIUS, 0, 2 * Math.PI);
    context.fillStyle = player.color;
    context.fill();
    if (id === you) {
      context.lineWidth = 3;
      context.strokeStyle = '#111';
      context.stroke();
    }
  }
  // Where the server last saw you: prediction runs ahead of it by about one round trip.
  if (ghost) {
    context.beginPath();
    context.arc(ghost.x, ghost.y, RADIUS, 0, 2 * Math.PI);
    context.setLineDash([4, 4]);
    context.lineWidth = 2;
    context.strokeStyle = '#111';
    context.stroke();
    context.setLineDash([]);
  }
}

/** The arena. Everything here runs once per animation frame, outside React's renders. */
export function Canvas() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stats = useRef<HTMLParagraphElement>(null);
  useWebSocketStatus(game); // holds the connection while mounted

  useEffect(() => {
    const context = canvas.current!.getContext('2d')!;
    const held = new Set<string>();
    const down = (event: KeyboardEvent) => {
      if (!(event.key in KEYS)) return;
      held.add(event.key);
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => held.delete(event.key);
    const blur = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);

    let last = performance.now();
    let carry = 0;
    let dropped = 0;
    let frame = requestAnimationFrame(function loop(now) {
      // Fixed steps, whatever the display's refresh rate, sent as one input per frame.
      carry = Math.min(carry + now - last, MAX_STEPS * STEP_MS);
      last = now;
      const steps = Math.floor(carry / STEP_MS);
      carry -= steps * STEP_MS;
      const { dx, dy } = direction(held);
      if (steps && (dx || dy)) {
        const sent = timeline.input({ dx, dy, steps });
        if (sent === undefined && game.getSnapshot().status === 'open') dropped++;
      }

      const latest = timeline.latest()?.state;
      const others = settings.interpolate ? timeline.at() : latest;
      const mine = settings.predict ? timeline.predicted() : others;
      if (others && mine) {
        const you = mine.you;
        const players = { ...others.players };
        if (mine.players[you]) players[you] = mine.players[you];
        draw(context, players, you, settings.ghost ? latest?.players[you] : undefined);
      }

      // How far the render time is behind the newest snapshot. At 0 or below, `at()` has run
      // out of snapshots and holds still: raise the delay.
      const newest = timeline.latest()?.time;
      const rendered = timeline.renderTime();
      if (newest !== undefined && rendered !== undefined) {
        const margin = Math.round(newest - rendered);
        stats.current!.textContent = `Buffered ahead: ${margin} ms · Unconfirmed inputs: ${timeline.pending()} · Skipped inputs (congestion): ${dropped}`;
        stats.current!.dataset.starved = String(margin <= 0);
      }
      frame = requestAnimationFrame(loop);
    });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return (
    <>
      <canvas ref={canvas} width={ARENA.width} height={ARENA.height} />
      <p ref={stats} className="muted stats" />
    </>
  );
}
