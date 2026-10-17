// The game's rules, shared by the server and the client. The client predicts your moves with
// the same `move()` the server applies, so the two agree unless an input is lost.

/** The server applies inputs and sends snapshots this often: 20 times a second. */
export const TICK_MS = 50;
/** One input step. The client samples the keys 60 times a second. */
export const STEP_MS = 1000 / 60;
/** Steps one input may carry: 200 ms, enough for the lowest adaptive send rate (5 a second). */
export const MAX_STEPS = 12;
/**
 * Steps the server allows each player per tick: a little above real time (3), so a late burst of
 * inputs catches up, up to `BURST` steps at once. Nobody moves much faster than real time.
 */
export const STEPS_PER_TICK = 4;
export const BURST = 24;

export const ARENA = { width: 640, height: 400 };
export const RADIUS = 12;
const SPEED = 0.24; // px per ms

export interface Player {
  x: number;
  y: number;
  color: string;
  /** Where the player aims, in radians. */
  angle?: number;
  bot?: boolean;
}

/** A direction held for `steps` steps. */
export interface Move {
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  steps: number;
}

/** What the timeline keeps: every player, and which one is you. */
export interface World {
  you: string;
  players: Record<string, Player>;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function move(player: Player, input: Move): Player {
  // Diagonals aren't faster.
  const distance = (SPEED * STEP_MS * input.steps) / (Math.hypot(input.dx, input.dy) || 1);
  return {
    ...player,
    x: clamp(player.x + input.dx * distance, RADIUS, ARENA.width - RADIUS),
    y: clamp(player.y + input.dy * distance, RADIUS, ARENA.height - RADIUS)
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Blend two snapshots. A player who just joined appears where they are instead of sliding in. */
export function lerpWorld(from: World, to: World, t: number): World {
  const players: Record<string, Player> = {};
  for (const [id, end] of Object.entries(to.players)) {
    const start = from.players[id] ?? end;
    players[id] = { ...end, x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t) };
  }
  return { you: to.you, players };
}

const COLORS = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#b56576', '#6d597a'];

export function spawn(n: number): Player {
  return {
    x: ARENA.width / 2 + ((n * 97) % 200) - 100,
    y: ARENA.height / 2 + ((n * 61) % 120) - 60,
    color: COLORS[n % COLORS.length]!
  };
}

/** Bots circle the arena, so one tab already shows other players moving. */
export const BOTS = 3;

export function botAt(i: number, time: number): Player {
  const angle = (time / 1000) * (0.6 + i * 0.25) + i * 2;
  const radius = 70 + i * 45;
  return {
    x: ARENA.width / 2 + Math.cos(angle) * radius,
    y: ARENA.height / 2 + Math.sin(angle) * radius * 0.7,
    color: '#8d99ae',
    bot: true
  };
}
