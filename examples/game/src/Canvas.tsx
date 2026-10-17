import { useEffect, useRef } from 'react';
import { useWebSocketStatus } from 'react-websocket';
import { game, settings, stream, timeline } from './net';
import { ARENA, MAX_STEPS, RADIUS, STEP_MS, move, type Move, type Player } from './sim';

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
    if (player.angle !== undefined) {
      context.beginPath();
      context.moveTo(player.x, player.y);
      context.lineTo(
        player.x + Math.cos(player.angle) * (RADIUS + 10),
        player.y + Math.sin(player.angle) * (RADIUS + 10)
      );
      context.lineWidth = 3;
      context.strokeStyle = player.color;
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
    const element = canvas.current!;
    const context = element.getContext('2d')!;
    const held = new Set<string>();
    let pointer: { x: number; y: number } | undefined;
    const down = (event: KeyboardEvent) => {
      if (!(event.key in KEYS)) return;
      held.add(event.key);
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => held.delete(event.key);
    const blur = () => held.clear();
    const aim = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      pointer = {
        x: ((event.clientX - rect.left) / rect.width) * ARENA.width,
        y: ((event.clientY - rect.top) / rect.height) * ARENA.height
      };
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    element.addEventListener('pointermove', aim);

    let last = performance.now();
    let carry = 0;
    let dropped = 0;
    // Steps taken but not sent yet, all in one direction. Sent every frame, or with
    // `settings.adaptive`, as fewer, bigger inputs at the rate the send-rate stream picks.
    let batch: Move = { dx: 0, dy: 0, steps: 0 };
    let sentAt = 0;

    function send(now: number) {
      if (!batch.steps) return;
      // An input that can't be sent is gone: the timeline doesn't predict it, so don't keep it.
      if (timeline.input(batch) === undefined && game.getSnapshot().status === 'open') dropped++;
      batch = { ...batch, steps: 0 };
      sentAt = now;
    }

    let frame = requestAnimationFrame(function loop(now) {
      // Fixed 60 Hz steps, whatever the display's refresh rate.
      carry = Math.min(carry + now - last, 5 * STEP_MS);
      last = now;
      const steps = Math.floor(carry / STEP_MS);
      carry -= steps * STEP_MS;
      const { dx, dy } = direction(held);
      if (dx !== batch.dx || dy !== batch.dy) {
        send(now);
        batch = { dx, dy, steps: 0 };
      }
      if (dx || dy) batch = { ...batch, steps: Math.min(MAX_STEPS, batch.steps + steps) };
      // Half a step early is on time: frames don't land exactly on the interval.
      const interval = settings.adaptive ? 1000 / stream.getSnapshot().rate - STEP_MS / 2 : 0;
      if (now - sentAt >= interval || batch.steps === MAX_STEPS) send(now);

      const latest = timeline.latest()?.state;
      const others = settings.interpolate ? timeline.at() : latest;
      const mine = settings.predict ? timeline.predicted() : others;
      if (others && mine) {
        const you = mine.you;
        const players = { ...others.players };
        let me = mine.players[you];
        if (me) {
          // Show the steps waiting to be sent too, so a lower send rate doesn't make you jerky.
          if (settings.predict && batch.steps) me = move(me, batch);
          // Aim from where you're drawn, streamed at the adaptive rate.
          if (pointer) {
            const angle = Math.atan2(pointer.y - me.y, pointer.x - me.x);
            me = { ...me, angle };
            stream.send({ type: 'aim', angle }, 'aim');
          }
          players[you] = me;
        }
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
      element.removeEventListener('pointermove', aim);
    };
  }, []);

  return (
    <>
      <canvas ref={canvas} width={ARENA.width} height={ARENA.height} />
      <p ref={stats} className="muted stats" />
    </>
  );
}
