'use client';

/**
 * ServerRingHero — line-art hero animation for react-websocket.
 *
 * A hub server sits in the middle of a ring of client servers. Traffic is
 * asynchronous and overlapping: clients broadcast through the hub to everyone,
 * relay messages to one other client, send ping/pong heartbeats, and now and
 * then drop their link and reconnect with a handshake.
 *
 *  - Zero dependencies (React only), one <canvas>, ~60fps.
 *  - Lines use the CSS `color` of the wrapper, so it follows light/dark themes.
 *  - Messages use `accent`, or the CSS variable --rws-accent, or Rspress's
 *    --rp-c-brand, in that order. Heartbeats and reconnect handshakes have
 *    their own colours (`heartbeat` / --rws-heartbeat, `handshake` / --rws-handshake).
 *  - Click or tap a client to make it broadcast; click the hub to broadcast.
 *  - Pauses offscreen; respects prefers-reduced-motion (static until clicked).
 *  - SSR-safe: nothing touches the DOM until the component mounts.
 *
 * `mountServerRing(element, options)` is exported too, so the same animation
 * can be mounted without React (e.g. from a non-React page).
 */

import { useEffect, useRef } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export type ServerRingTraffic = 'broadcast' | 'relay' | 'ping' | 'reconnect';

export type ServerRingEvent =
  /** A client (or the hub, from = -1) sends a message that every connected client receives. */
  | { type: 'broadcast'; from: number; message: string }
  /** A client sends a message through the hub to one other client. */
  | { type: 'relay'; from: number; to: number; message: string }
  /** Heartbeat: a client pings the hub and gets a pong back. */
  | { type: 'ping'; client: number }
  /** A client's link drops, then it reconnects with a handshake. */
  | { type: 'reconnect'; client: number };

export interface ServerRingOptions {
  /** Client servers on the ring, 3–12. Default 8. */
  nodes?: number;
  /** Colour of messages and flashes. Lines use the CSS `color`. */
  accent?: string;
  /** Colour of ping/pong heartbeats. Defaults to --rws-heartbeat, then a green. */
  heartbeat?: string;
  /** Colour of reconnect handshakes and dropped links. Defaults to --rws-handshake, then a rose. */
  handshake?: string;
  /** Camera elevation in degrees, 20–80. Default 50. */
  tilt?: number;
  /** Camera roll in degrees. Default -14. */
  roll?: number;
  /** Ring rotation in degrees per second. Default 3.5. */
  rotationSpeed?: number;
  /** Message speed multiplier: 2 is twice as fast, 0.5 half. Default 1. */
  speed?: number;
  /** Average seconds between automatic events; events overlap freely. Default 0.45. */
  interval?: number;
  /** Relative weights of automatic traffic. Default { broadcast: 3, relay: 2, ping: 3, reconnect: 0.6 }. */
  traffic?: Partial<Record<ServerRingTraffic, number>>;
  /** Payloads cycled through and reported to `onSend`. */
  messages?: string[];
  /** Click or tap servers to send messages. Default true. */
  interactive?: boolean;
  /** Faint background stars. Default true. */
  stars?: boolean;
  /** Freeze the animation. */
  paused?: boolean;
  /** Called when a message is sent, by a broadcast or a relay (client is -1 for a hub broadcast). */
  onSend?: (client: number, message: string) => void;
  /** Called for every event: broadcasts, relays, pings and reconnects. */
  onEvent?: (event: ServerRingEvent) => void;
}

export interface ServerRingController {
  update(options: ServerRingOptions): void;
  /** Broadcast from a client now. Omit for a random client; -1 for the hub. */
  send(client?: number): void;
  /** Send from one client to another through the hub. Omitted ends are random. */
  relay(from?: number, to?: number): void;
  /** Heartbeat from a client: ping to the hub, pong back. */
  ping(client?: number): void;
  /** Drop a client's link and let it reconnect. */
  reconnect(client?: number): void;
  destroy(): void;
}

export interface ServerRingHeroProps extends ServerRingOptions {
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  /** Receives the controller, e.g. to call `controller.current?.send()` from a button. */
  controller?: MutableRefObject<ServerRingController | null>;
}

export function ServerRingHero({
  className,
  style,
  'aria-label': ariaLabel,
  controller,
  ...options
}: ServerRingHeroProps) {
  const host = useRef<HTMLDivElement>(null);
  const ctrl = useRef<ServerRingController | null>(null);
  const nodes = options.nodes ?? 8;

  useEffect(() => {
    if (!host.current) return;
    const c = mountServerRing(host.current, options);
    ctrl.current = c;
    if (controller) controller.current = c;
    return () => {
      c.destroy();
      ctrl.current = null;
      if (controller) controller.current = null;
    };
    // Geometry depends only on `nodes`; everything else is live-updated below.
    // eslint-disable-next-line react/exhaustive-deps
  }, [nodes]);

  useEffect(() => {
    ctrl.current?.update(options);
  });

  return (
    <div
      ref={host}
      className={className}
      role="img"
      aria-label={
        ariaLabel ??
        'Illustration: client servers around a central server exchange messages, broadcasts, heartbeats and reconnects.'
      }
      style={{ position: 'relative', width: '100%', aspectRatio: '7 / 6', ...style }}
    />
  );
}

export default ServerRingHero;

/* -------------------------------------------------------------------------- */
/* Scene constants                                                            */
/* -------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const CAM = 5; // camera distance — lower means stronger perspective
const RING = 1; // ring radius in scene units
const HUB_A = 0.27; // hub apothem
const HUB_H = 0.16; // hub half height
const MAST = HUB_H + 0.26; // top of the hub's antenna
const TUBE = 0.021; // link radius
const MARGIN = 0.022;
const WAVE_MAX = RING + 0.34; // how far the broadcast wave travels

// Message timings in seconds at speed 1.
const HOP = 0.22; // one trip along a link
const LEAD = 0.06; // a sender lights up before its message leaves
const TURN = 0.05; // hub turnaround before forwarding
const BEAT = 0.17; // one trip of a ping or a pong
const OFFLINE = 0.7; // how long a dropped link stays down before reconnecting
const RESTORE = 0.3; // a reconnected link fades back in
const DEFAULT_TRAFFIC: Record<ServerRingTraffic, number> = {
  broadcast: 3,
  relay: 2,
  ping: 3,
  reconnect: 0.6
};

const DEFAULT_MESSAGES = [
  '{"type":"ping"}',
  '{"op":"join","room":"lobby"}',
  '{"price":42.17}',
  '{"typing":true}',
  '{"cursor":[128,64]}',
  '"hello"'
];

// Half extents (tangential, vertical, radial) of the client server shapes.
const TYPES: [number, number, number][] = [
  [0.1, 0.16, 0.15], // tower
  [0.17, 0.085, 0.15], // rack slab
  [0.13, 0.13, 0.13], // storage cube
  [0.12, 0.19, 0.11] // tall blade chassis
];
const TYPE_ORDER = [0, 1, 2, 3, 1, 0, 3, 2, 2, 1, 0, 3];

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

type V3 = [number, number, number];
type RGB = [number, number, number];
type P2 = { p: number[]; c: boolean }; // polyline in face space
type Art = { lines: P2[]; leds: [number, number][] };
type Line3 = { p: Float32Array; c: boolean };
interface Face {
  poly: Float32Array;
  n: V3;
  c: V3;
  lines: Line3[];
}
interface Led {
  p: V3;
  face: number; // -1: always visible
  phase: number;
  freq: number;
}
interface Body {
  center: V3;
  faces: Face[];
  leds: Led[];
  extras: Line3[];
  reach: number;
}
interface Spoke {
  a: V3;
  b: V3;
}
/** What travels on a leg: a message, a heartbeat (ping/pong) or a reconnect handshake. */
const MSG = 0;
const BEAT_K = 1;
const SHAKE = 2;
type Kind = typeof MSG | typeof BEAT_K | typeof SHAKE;
/** One trip along one link. dir -1: client → hub, 1: hub → client. */
interface Leg {
  spoke: number;
  dir: number;
  t0: number;
  dur: number;
  kind: Kind;
}
/** A timed effect. kind 0: client lights up, 1: hub lights up, 2: broadcast wave. */
interface Fx {
  kind: 0 | 1 | 2;
  i: number;
  t0: number;
  k: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** Quick attack, slow decay envelope starting at t0. */
function env(t: number, t0: number, dur: number) {
  const x = (t - t0) / dur;
  if (x < 0 || x > 1) return 0;
  return x < 0.12 ? x / 0.12 : Math.pow(1 - (x - 0.12) / 0.88, 2);
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function comb(o: V3, u: V3, su: number, v?: V3, sv = 0, w?: V3, sw = 0): V3 {
  const r: V3 = [o[0] + u[0] * su, o[1] + u[1] * su, o[2] + u[2] * su];
  if (v) for (let i = 0; i < 3; i++) r[i] += v[i] * sv;
  if (w) for (let i = 0; i < 3; i++) r[i] += w[i] * sw;
  return r;
}
const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];

/* --- 2D face-art primitives (units are scene units on the face) ---------- */

const rect = (x0: number, y0: number, x1: number, y1: number): P2 => ({
  p: [x0, y0, x1, y0, x1, y1, x0, y1],
  c: true
});
const seg = (x0: number, y0: number, x1: number, y1: number): P2 => ({
  p: [x0, y0, x1, y1],
  c: false
});
function circle(cx: number, cy: number, r: number, n = 20): P2 {
  const p: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    p.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return { p, c: true };
}
function grid(x0: number, y0: number, x1: number, y1: number, cols: number, rows: number): P2[] {
  const out = [rect(x0, y0, x1, y1)];
  for (let i = 1; i < cols; i++) {
    const x = x0 + ((x1 - x0) * i) / cols;
    out.push(seg(x, y0, x, y1));
  }
  for (let j = 1; j < rows; j++) {
    const y = y0 + ((y1 - y0) * j) / rows;
    out.push(seg(x0, y, x1, y));
  }
  return out;
}
function cells(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cols: number,
  rows: number,
  gap: number
): P2[] {
  const out: P2[] = [];
  const w = (x1 - x0 - gap * (cols - 1)) / cols;
  const h = (y1 - y0 - gap * (rows - 1)) / rows;
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const x = x0 + i * (w + gap);
      const y = y0 + j * (h + gap);
      out.push(rect(x, y, x + w, y + h));
    }
  return out;
}
function slats(x0: number, y0: number, x1: number, y1: number, n: number, vertical: boolean): P2[] {
  const out: P2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    out.push(
      vertical
        ? seg(x0 + (x1 - x0) * t, y0, x0 + (x1 - x0) * t, y1)
        : seg(x0, y0 + (y1 - y0) * t, x1, y0 + (y1 - y0) * t)
    );
  }
  return out;
}
function fan(cx: number, cy: number, r: number): P2[] {
  const b = r + 0.008;
  const out = [
    rect(cx - b, cy - b, cx + b, cy + b),
    circle(cx, cy, r, 24),
    circle(cx, cy, r * 0.3, 12)
  ];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const p: number[] = [];
    for (const [rr, da] of [
      [0.3, 0],
      [0.65, 0.32],
      [0.95, 0.5]
    ])
      p.push(cx + Math.cos(a + da) * r * rr, cy + Math.sin(a + da) * r * rr);
    out.push({ p, c: false });
  }
  return out;
}

/* --- Face art ------------------------------------------------------------ */

/** Inner face (towards the hub): drive bays around the link socket. */
function frontArt(W: number, H: number): Art {
  const m = MARGIN;
  const s = 0.03;
  const cx = W / 2;
  const cy = H / 2;
  const lines: P2[] = [
    rect(cx - s, cy - s, cx + s, cy + s),
    circle(cx, cy, s * 0.55, 16),
    circle(cx, cy, s * 0.22, 10)
  ];
  const leds: [number, number][] = [];
  const stripY = Math.max(H * 0.66, cy + s) + 0.014;
  const hasStrip = H - m - stripY > 0.022;
  const top = hasStrip ? stripY - 0.012 : H - m;
  const ledCol = hasStrip ? 0 : 0.024;
  for (const [x0, x1] of [
    [m, cx - s - 0.012],
    [cx + s + 0.012, W - m - ledCol]
  ]) {
    if (x1 - x0 < 0.025) continue;
    const cols = Math.max(1, Math.round((x1 - x0) / 0.045));
    const rows = Math.max(2, Math.round((top - m) / 0.032));
    lines.push(...cells(x0, m, x1, top, cols, rows, 0.006));
  }
  if (hasStrip) {
    lines.push(rect(m, stripY, W * 0.56, H - m), ...slats(m, stripY, W * 0.56, H - m, 2, false));
    for (let i = 0; i < 3; i++) leds.push([W - m - 0.01 - i * 0.022, (stripY + H - m) / 2]);
  } else {
    for (let i = 0; i < 3; i++) leds.push([W - m - 0.009, H - m - 0.012 - i * 0.024]);
  }
  return { lines, leds };
}

/** Outer face (away from the hub): fans, PSU, ports — differs per type. */
function backArt(type: number, W: number, H: number): Art {
  const m = MARGIN;
  const lines: P2[] = [];
  const leds: [number, number][] = [];
  if (type === 0) {
    const r = Math.min(W - 2 * m, H * 0.5) / 2 - 0.01;
    lines.push(...fan(W / 2, H - m - r - 0.01, r));
    const py = H * 0.3;
    lines.push(
      rect(m, m, W - m, py),
      ...slats(m, m, W * 0.6, py, 6, true),
      rect(W * 0.68, m + 0.014, W - m - 0.012, py - 0.014)
    );
    for (let i = 0; i < 3; i++)
      lines.push(rect(m + i * 0.03, py + 0.02, m + i * 0.03 + 0.022, py + 0.034));
    leds.push([W - m - 0.012, py + 0.027], [W - m - 0.032, py + 0.027]);
  } else if (type === 1) {
    const r = H / 2 - m - 0.014;
    let x = m + r + 0.008;
    lines.push(...fan(x, H / 2, r));
    x += 2 * r + 0.02;
    lines.push(...fan(x, H / 2, r));
    x += r + 0.018;
    if (W - m - x > 0.02)
      lines.push(...cells(x, m, W - m, H - m - 0.026, W - m - x > 0.045 ? 2 : 1, 3, 0.006));
    leds.push([W - m - 0.01, H - m - 0.012], [W - m - 0.03, H - m - 0.012]);
  } else if (type === 2) {
    lines.push(...grid(m, H * 0.48, W * 0.58, H - m, 5, 4));
    const r = Math.min(0.045, (W * 0.42 - m) / 2 - 0.012);
    lines.push(...fan(W * 0.79, H * 0.74, r));
    for (let i = 0; i < 2; i++) lines.push(rect(m, m + i * 0.045, W - m, m + i * 0.045 + 0.026));
    for (let i = 0; i < 3; i++) leds.push([W - m - 0.01 - i * 0.02, H * 0.4]);
  } else {
    const h = 0.048;
    const gap = 0.012;
    let y = H - m;
    for (let i = 0; i < 4; i++) {
      lines.push(
        rect(m, y - h, W - m, y),
        seg(m + 0.03, y - h + 0.01, m + 0.03, y - 0.01),
        ...slats(W * 0.55, y - h, W - m - 0.01, y, 3, true)
      );
      leds.push([m + 0.015, y - h / 2]);
      y -= h + gap;
    }
    if (y - m > 0.03) lines.push(...grid(m, m, W - m, y - 0.004, 6, 3));
  }
  return { lines, leds };
}

/** Lid: a seam, a hatched vent panel and either slats or a small dish. */
function topArt(type: number, W: number, H: number, rnd: () => number): Art {
  const m = MARGIN;
  const lines: P2[] = [];
  const leds: [number, number][] = [];
  const split = H * (rnd() < 0.5 ? 0.4 : 0.6);
  lines.push(seg(m, split, W - m, split));
  const low = rnd() < 0.5;
  const [hy0, hy1] = low ? [m, split - 0.012] : [split + 0.012, H - m];
  const [oy0, oy1] = low ? [split + 0.012, H - m] : [m, split - 0.012];
  const hx1 = W - m - (rnd() < 0.5 ? 0 : W * 0.3);
  lines.push(
    ...grid(
      m,
      hy0,
      hx1,
      hy1,
      Math.max(2, Math.round((hx1 - m) / 0.026)),
      Math.max(2, Math.round((hy1 - hy0) / 0.026))
    )
  );
  const my = (oy0 + oy1) / 2;
  if (type === 2) {
    const r = Math.min(W - 2 * m, oy1 - oy0) * 0.38;
    lines.push(
      circle(W / 2, my, r, 22),
      circle(W / 2, my, r * 0.45, 14),
      seg(W / 2 - r, my, W / 2 + r, my)
    );
  } else {
    lines.push(...slats(m, oy0, W * 0.62, oy1, 3, false));
    leds.push([W - m - 0.012, my]);
  }
  return { lines, leds };
}

/** Side panels: a seam, a rail, vent slats. */
function sideArt(W: number, H: number, rnd: () => number): Art {
  const m = MARGIN;
  const left = rnd() < 0.5;
  const xs = W * (left ? 0.36 : 0.64);
  const lines: P2[] = [seg(xs, m, xs, H - m), rect(m, m, W - m, m + 0.018)];
  const [vx0, vx1] = left ? [xs + 0.016, W - m - 0.006] : [m + 0.006, xs - 0.016];
  lines.push(...slats(vx0, H * 0.55, vx1, H - m - 0.01, 5, true));
  if (H > 0.3)
    lines.push(...grid(left ? m : xs + 0.016, H * 0.18, left ? xs - 0.016 : W - m, H * 0.45, 2, 3));
  return { lines, leds: [] };
}

/** Hub sides: three rack units, a link socket in the middle one. */
function hubSideArt(W: number, H: number): Art {
  const m = MARGIN;
  const s = 0.028;
  const cx = W / 2;
  const cy = H / 2;
  const u = H / 3;
  const lines: P2[] = [rect(cx - s, cy - s, cx + s, cy + s), circle(cx, cy, s * 0.55, 16)];
  const leds: [number, number][] = [];
  for (let k = 1; k < 3; k++) lines.push(seg(m, u * k, W - m, u * k));
  for (let k = 0; k < 3; k++) {
    leds.push([m + 0.012, u * k + u / 2]);
    lines.push(seg(W - m - 0.012, u * k + 0.014, W - m - 0.012, u * (k + 1) - 0.014));
  }
  const x0 = m + 0.028;
  const x1 = W - m - 0.03;
  if (x1 - x0 > 0.06) {
    lines.push(
      ...cells(x0, 0.016, x1, u - 0.016, Math.max(2, Math.round((x1 - x0) / 0.03)), 1, 0.006)
    );
    lines.push(...slats(x0, 2 * u + 0.008, x1, H - 0.008, 3, false));
    if (cx - s - 0.012 - x0 > 0.015)
      lines.push(...slats(x0, u + 0.016, cx - s - 0.012, 2 * u - 0.016, 3, true));
    if (x1 - (cx + s + 0.012) > 0.015)
      lines.push(...slats(cx + s + 0.012, u + 0.016, x1, 2 * u - 0.016, 3, true));
  }
  return { lines, leds };
}

function addFace(
  body: Body,
  O: V3,
  U: V3,
  V: V3,
  W: number,
  H: number,
  n: V3,
  art: Art,
  rnd: () => number
) {
  const map = (p: number[]) => {
    const out = new Float32Array((p.length / 2) * 3);
    for (let i = 0, j = 0; i < p.length; i += 2, j += 3) {
      const x = p[i];
      const y = p[i + 1];
      out[j] = O[0] + U[0] * x + V[0] * y;
      out[j + 1] = O[1] + U[1] * x + V[1] * y;
      out[j + 2] = O[2] + U[2] * x + V[2] * y;
    }
    return out;
  };
  const fi = body.faces.length;
  const d = 0.011;
  const lines: Line3[] = [{ p: map([d, d, W - d, d, W - d, H - d, d, H - d]), c: true }];
  for (const l of art.lines) lines.push({ p: map(l.p), c: l.c });
  for (const [x, y] of art.leds) {
    const q = map([x, y]);
    body.leds.push({
      p: [q[0], q[1], q[2]],
      face: fi,
      phase: rnd() * TAU,
      freq: 0.6 + rnd() * 2.2
    });
  }
  const c = map([W / 2, H / 2]);
  body.faces.push({ poly: map([0, 0, W, 0, W, H, 0, H]), n, c: [c[0], c[1], c[2]], lines });
}

function circle3(r: number, y: number, n: number): Line3 {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    p[i * 3] = Math.cos(a) * r;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = Math.sin(a) * r;
  }
  return { p, c: true };
}

function buildScene(N: number) {
  const k = N > 8 ? Math.sqrt(8 / N) : 1;
  const rnd = mulberry32(7 + N);
  const up: V3 = [0, 1, 0];
  const clients: Body[] = [];
  const spokes: Spoke[] = [];

  for (let i = 0; i < N; i++) {
    const al = (i / N) * TAU;
    const r: V3 = [Math.cos(al), 0, Math.sin(al)];
    const t: V3 = [-Math.sin(al), 0, Math.cos(al)];
    const type = TYPE_ORDER[i % TYPE_ORDER.length];
    const [a, b, c] = TYPES[type].map(v => v * k) as V3;
    const C = comb([0, 0, 0], r, RING);
    const body: Body = { center: C, faces: [], leds: [], extras: [], reach: Math.hypot(a, c) };
    addFace(
      body,
      comb(C, r, c, t, -a, up, -b),
      t,
      up,
      2 * a,
      2 * b,
      r,
      backArt(type, 2 * a, 2 * b),
      rnd
    );
    addFace(
      body,
      comb(C, r, -c, t, a, up, -b),
      neg(t),
      up,
      2 * a,
      2 * b,
      neg(r),
      frontArt(2 * a, 2 * b),
      rnd
    );
    addFace(
      body,
      comb(C, up, b, t, -a, r, -c),
      t,
      r,
      2 * a,
      2 * c,
      up,
      topArt(type, 2 * a, 2 * c, rnd),
      rnd
    );
    addFace(
      body,
      comb(C, t, a, r, c, up, -b),
      neg(r),
      up,
      2 * c,
      2 * b,
      t,
      sideArt(2 * c, 2 * b, rnd),
      rnd
    );
    addFace(
      body,
      comb(C, t, -a, r, -c, up, -b),
      r,
      up,
      2 * c,
      2 * b,
      neg(t),
      sideArt(2 * c, 2 * b, rnd),
      rnd
    );
    if (type === 3) {
      // a short whip antenna on the tall chassis
      const base = comb(C, up, b, t, a * 0.5, r, c * 0.4);
      body.extras.push({
        p: new Float32Array([...base, base[0], base[1] + 0.09, base[2]]),
        c: false
      });
      body.leds.push({
        p: [base[0], base[1] + 0.09, base[2]],
        face: -1,
        phase: rnd() * TAU,
        freq: 1.4
      });
    }
    clients.push(body);
    spokes.push({ a: comb([0, 0, 0], r, HUB_A), b: comb(C, r, -c) });
  }

  // Hub: an N-sided rack core with a mast on top.
  const hub: Body = { center: [0, 0, 0], faces: [], leds: [], extras: [], reach: HUB_A };
  const Rc = HUB_A / Math.cos(Math.PI / N);
  const Wf = 2 * HUB_A * Math.tan(Math.PI / N);
  for (let i = 0; i < N; i++) {
    const al = (i / N) * TAU;
    const a0 = al - Math.PI / N;
    addFace(
      hub,
      [Rc * Math.cos(a0), -HUB_H, Rc * Math.sin(a0)],
      [-Math.sin(al), 0, Math.cos(al)],
      up,
      Wf,
      2 * HUB_H,
      [Math.cos(al), 0, Math.sin(al)],
      hubSideArt(Wf, 2 * HUB_H),
      rnd
    );
  }
  const ngon = (scale: number) => {
    const p = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU - Math.PI / N;
      p[i * 3] = Rc * scale * Math.cos(a);
      p[i * 3 + 1] = HUB_H;
      p[i * 3 + 2] = Rc * scale * Math.sin(a);
    }
    return p;
  };
  const topLines: Line3[] = [
    { p: ngon(0.94), c: true },
    { p: ngon(0.78), c: true },
    circle3(0.12, HUB_H, 32),
    circle3(0.075, HUB_H, 24)
  ];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const r0 = 0.135;
    const r1 = HUB_A * 0.74;
    topLines.push({
      p: new Float32Array([
        r0 * Math.cos(a),
        HUB_H,
        r0 * Math.sin(a),
        r1 * Math.cos(a),
        HUB_H,
        r1 * Math.sin(a)
      ]),
      c: false
    });
  }
  hub.faces.push({ poly: ngon(1), n: up, c: [0, HUB_H, 0], lines: topLines });
  hub.extras.push(
    { p: new Float32Array([0, HUB_H, 0, 0, MAST, 0]), c: false },
    circle3(0.05, MAST - 0.07, 24)
  );
  hub.leds.push({ p: [0, MAST, 0], face: -1, phase: 0, freq: 2 });

  return { clients, spokes, hub };
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

export function mountServerRing(
  container: HTMLElement,
  initial: ServerRingOptions = {}
): ServerRingController {
  let opts: ServerRingOptions = { ...initial };
  const N = clamp(Math.round(opts.nodes ?? 8), 3, 12);
  const canvas = document.createElement('canvas');
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx)
    return { update() {}, send() {}, relay() {}, ping() {}, reconnect() {}, destroy() {} };
  const ctx: CanvasRenderingContext2D = maybeCtx;

  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent'
  });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);

  const { clients, spokes, hub } = buildScene(N);
  const rndStars = mulberry32(99);
  const starField = Array.from({ length: 46 }, () => ({
    x: rndStars(),
    y: rndStars(),
    r: 0.4 + rndStars() * 0.7,
    a: 0.12 + rndStars() * 0.35,
    f: 0.3 + rndStars() * 1.2,
    ph: rndStars() * TAU
  }));

  // ---- state
  let cw = 0;
  let ch = 0;
  let dpr = 1;
  let S = 1; // pixels per scene unit
  let ox = 0;
  let oy = 0;
  let lw = 1;
  let time = 0;
  let theta = 0.35;
  let last = 0;
  let raf = 0;
  let onScreen = true;
  let frameNo = 0;
  let dirty = true;
  let mt = 0; // message clock, runs at `speed`
  let nextAuto = 0.4;
  let msgIdx = 0;
  let hover = -1;
  const legs: Leg[] = [];
  const fxs: Fx[] = [];
  const offFrom = new Float64Array(N).fill(-1); // link down from…
  const offTo = new Float64Array(N).fill(-1); // …until the handshake completes
  const hoverK = new Float32Array(N + 1); // last slot: hub
  const flash = new Float32Array(N);
  const packets: { s: number; dir: number; kind: Kind }[][] = spokes.map(() => []);
  const hits: { i: number; z: number; polys: number[][] }[] = [];
  let line: RGB = [230, 226, 240];
  let accent: RGB = [124, 240, 208];
  let beat: RGB = [126, 231, 135];
  let shake: RGB = [255, 126, 182];

  const reducedQuery =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!reducedQuery?.matches;
  const onReduced = () => {
    reduced = !!reducedQuery?.matches;
    dirty = true;
    kick();
  };
  reducedQuery?.addEventListener?.('change', onReduced);

  // ---- colours
  const scratch = document.createElement('canvas').getContext('2d');
  function parseColor(input: string | undefined, fallback: RGB): RGB {
    if (!scratch || !input) return fallback;
    scratch.fillStyle = '#010203';
    scratch.fillStyle = input.trim();
    const v = String(scratch.fillStyle);
    if (v === '#010203' && input.trim() !== '#010203') return fallback;
    if (v[0] === '#')
      return [
        parseInt(v.slice(1, 3), 16),
        parseInt(v.slice(3, 5), 16),
        parseInt(v.slice(5, 7), 16)
      ];
    const m = v.match(/[\d.]+/g);
    return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : fallback;
  }
  function readColors() {
    const cs = getComputedStyle(container);
    const nextLine = parseColor(cs.color, line);
    const nextAccent = parseColor(
      opts.accent ||
        cs.getPropertyValue('--rws-accent') ||
        cs.getPropertyValue('--rp-c-brand') ||
        '#7cf0d0',
      accent
    );
    // control-traffic defaults: bright on dark pages, deeper on light ones
    const darkPage = 0.299 * nextLine[0] + 0.587 * nextLine[1] + 0.114 * nextLine[2] > 140;
    const nextBeat = parseColor(
      opts.heartbeat ||
        cs.getPropertyValue('--rws-heartbeat') ||
        (darkPage ? '#7ee787' : '#1f8a3b'),
      beat
    );
    const nextShake = parseColor(
      opts.handshake ||
        cs.getPropertyValue('--rws-handshake') ||
        (darkPage ? '#ff7eb6' : '#c42a6a'),
      shake
    );
    const sig = (c: RGB[]) => c.map(v => v.join()).join('|');
    if (sig([nextLine, nextAccent, nextBeat, nextShake]) !== sig([line, accent, beat, shake]))
      dirty = true;
    line = nextLine;
    accent = nextAccent;
    beat = nextBeat;
    shake = nextShake;
  }
  const rgba = (c: RGB, a: number) =>
    `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;
  const mix = (a: RGB, b: RGB, t: number): RGB => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];

  // ---- camera
  let m0 = 1,
    m1 = 0,
    m2 = 0,
    m3 = 0,
    m4 = 1,
    m5 = 0,
    m6 = 0,
    m7 = 0,
    m8 = 1;
  function setCamera(th: number) {
    const tl = (clamp(opts.tilt ?? 50, 20, 80) * Math.PI) / 180;
    const rl = ((opts.roll ?? -14) * Math.PI) / 180;
    const cy = Math.cos(th),
      sy = Math.sin(th);
    const ct = Math.cos(tl),
      st = Math.sin(tl);
    const cr = Math.cos(rl),
      sr = Math.sin(rl);
    // M = Roll · Tilt · RotY(th)
    const t0 = cy,
      t1 = 0,
      t2 = sy;
    const t3 = -st * sy,
      t4 = ct,
      t5 = st * cy;
    m0 = cr * t0 - sr * t3;
    m1 = cr * t1 - sr * t4;
    m2 = cr * t2 - sr * t5;
    m3 = sr * t0 + cr * t3;
    m4 = sr * t1 + cr * t4;
    m5 = sr * t2 + cr * t5;
    m6 = -ct * sy;
    m7 = -st;
    m8 = ct * cy;
  }
  let px = 0,
    py = 0,
    pw = 1;
  function proj(x: number, y: number, z: number) {
    const cx = m0 * x + m1 * y + m2 * z;
    const cy = m3 * x + m4 * y + m5 * z;
    const cz = m6 * x + m7 * y + m8 * z;
    pw = CAM / (CAM + cz);
    px = ox + cx * pw * S;
    py = oy - cy * pw * S;
  }
  const depth = (x: number, y: number, z: number) => m6 * x + m7 * y + m8 * z;
  function facing(f: Face) {
    const n = f.n,
      c = f.c;
    const nx = m0 * n[0] + m1 * n[1] + m2 * n[2];
    const ny = m3 * n[0] + m4 * n[1] + m5 * n[2];
    const nz = m6 * n[0] + m7 * n[1] + m8 * n[2];
    const vx = m0 * c[0] + m1 * c[1] + m2 * c[2];
    const vy = m3 * c[0] + m4 * c[1] + m5 * c[2];
    const vz = m6 * c[0] + m7 * c[1] + m8 * c[2] + CAM;
    return {
      vis: nx * vx + ny * vy + nz * vz < 0,
      light: Math.max(0, -0.4 * nx + 0.8 * ny - 0.45 * nz)
    };
  }

  function fit() {
    setCamera(0);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    const sample = (x: number, y: number, z: number) => {
      const cx = m0 * x + m1 * y + m2 * z;
      const cy = m3 * x + m4 * y + m5 * z;
      const w = CAM / (CAM + m6 * x + m7 * y + m8 * z);
      x0 = Math.min(x0, cx * w);
      x1 = Math.max(x1, cx * w);
      y0 = Math.min(y0, cy * w);
      y1 = Math.max(y1, cy * w);
    };
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TAU;
      const c = Math.cos(a),
        s = Math.sin(a);
      for (const y of [-0.2, 0.22]) sample((RING + 0.24) * c, y, (RING + 0.24) * s);
      sample(WAVE_MAX * c, 0, WAVE_MAX * s);
    }
    sample(0, MAST + 0.04, 0);
    const pad = Math.max(6, Math.min(cw, ch) * 0.02);
    S = Math.max(1, Math.min((cw - 2 * pad) / (x1 - x0), (ch - 2 * pad) / (y1 - y0)));
    ox = cw / 2 - ((x0 + x1) / 2) * S;
    oy = ch / 2 + ((y0 + y1) / 2) * S;
    lw = clamp(S / 250, 0.7, 1.3);
  }

  function resize() {
    const r = container.getBoundingClientRect();
    cw = Math.max(1, r.width);
    ch = Math.max(1, r.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    fit();
    dirty = true;
    kick();
  }

  // ---- drawing helpers
  function path(p: Float32Array, closed: boolean) {
    for (let i = 0; i < p.length; i += 3) {
      proj(p[i], p[i + 1], p[i + 2]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (closed) ctx.closePath();
  }

  const visBuf: boolean[] = [];
  function drawBody(b: Body, fl: number, hl: number, index: number, core: number, dim = 1) {
    const vis = visBuf;
    vis.length = 0;
    const lights: number[] = [];
    for (const f of b.faces) {
      const r = facing(f);
      vis.push(r.vis);
      lights.push(r.light);
    }
    // knock out whatever is behind this body
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    b.faces.forEach((f, i) => vis[i] && path(f.poly, true));
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // faint shading for volume
    b.faces.forEach((f, i) => {
      if (!vis[i]) return;
      ctx.beginPath();
      path(f.poly, true);
      ctx.fillStyle = rgba(mix(line, accent, fl), (0.012 + 0.045 * lights[i] + 0.05 * fl) * dim);
      ctx.fill();
    });
    if (index >= 0) {
      const polys: number[][] = [];
      b.faces.forEach((f, i) => {
        if (!vis[i]) return;
        const q: number[] = [];
        for (let j = 0; j < f.poly.length; j += 3) {
          proj(f.poly[j], f.poly[j + 1], f.poly[j + 2]);
          q.push(px, py);
        }
        polys.push(q);
      });
      hits.push({ i: index, z: depth(b.center[0], b.center[1], b.center[2]), polys });
    }
    const edge = mix(line, accent, Math.min(1, fl * 0.9 + hl * 0.25));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.7 * lw;
    ctx.strokeStyle = rgba(edge, (0.4 + 0.2 * hl + 0.35 * fl) * dim);
    ctx.beginPath();
    b.faces.forEach((f, i) => {
      if (vis[i]) for (const l of f.lines) path(l.p, l.c);
    });
    ctx.stroke();
    ctx.lineWidth = 1.15 * lw;
    ctx.strokeStyle = rgba(edge, (0.88 + 0.12 * Math.max(hl, fl)) * dim);
    ctx.beginPath();
    b.faces.forEach((f, i) => vis[i] && path(f.poly, true));
    for (const l of b.extras) path(l.p, l.c);
    ctx.stroke();

    if (core > 0.01) {
      proj(0, HUB_H, 0);
      const g = ctx.createRadialGradient(px, py, 0, px, py, 0.2 * S * pw);
      g.addColorStop(0, rgba(accent, 0.55 * core));
      g.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      path(circle3(0.12, HUB_H, 28).p, true);
      ctx.fill();
    }

    for (const L of b.leds) {
      if (L.face >= 0 && !vis[L.face]) continue;
      proj(L.p[0], L.p[1], L.p[2]);
      const on = dim < 1 ? 0 : reduced ? 0.5 : Math.sin(time * L.freq + L.phase) > 0.55 ? 1 : 0;
      const r = Math.max(0.8, 1.3 * pw * lw);
      if (fl > 0.02) {
        const g = ctx.createRadialGradient(px, py, 0, px, py, r * 6);
        g.addColorStop(0, rgba(accent, 0.5 * fl));
        g.addColorStop(1, rgba(accent, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r * 6, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle =
        fl > 0.02
          ? rgba(mix(line, accent, fl), 0.3 + 0.7 * Math.max(on, fl))
          : rgba(line, (0.22 + 0.7 * on) * dim);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.fill();
    }
  }

  function tube(
    ax: number,
    ay: number,
    ra: number,
    bx: number,
    by: number,
    rb: number,
    closed: boolean,
    color: string
  ) {
    const dx = bx - ax,
      dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len,
      ny = dx / len;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(ax + nx * ra, ay + ny * ra);
    ctx.lineTo(bx + nx * rb, by + ny * rb);
    ctx.lineTo(bx - nx * rb, by - ny * rb);
    ctx.lineTo(ax - nx * ra, ay - ny * ra);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(ax + nx * ra, ay + ny * ra);
    ctx.lineTo(bx + nx * rb, by + ny * rb);
    if (closed) ctx.lineTo(bx - nx * rb, by - ny * rb);
    else ctx.moveTo(bx - nx * rb, by - ny * rb);
    ctx.lineTo(ax - nx * ra, ay - ny * ra);
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  function drawSpoke(i: number) {
    const { a, b } = spokes[i];
    const pk = packets[i];
    const level = linkLevel(i);
    // tint the link by what is travelling on it; a dropped link takes the handshake colour
    let tint: RGB = line;
    let glow = 0;
    if (pk.some(p => p.kind === MSG)) {
      tint = accent;
      glow = 0.65;
    } else if (pk.some(p => p.kind === SHAKE)) {
      tint = shake;
      glow = 0.55;
    } else if (level < 1) {
      tint = shake;
      glow = 0.55 * (1 - level);
    } else if (pk.some(p => p.kind === BEAT_K)) {
      tint = beat;
      glow = 0.45;
    }
    const color = rgba(
      mix(line, tint, glow),
      (0.72 + 0.2 * Math.min(1, glow / 0.45)) * (0.45 + 0.55 * level)
    );
    ctx.lineWidth = 0.95 * lw;
    if (level === 0) ctx.setLineDash([3, 4]); // link is down
    proj(a[0], a[1], a[2]);
    const ax = px,
      ay = py,
      aw = pw;
    proj(b[0], b[1], b[2]);
    tube(ax, ay, TUBE * aw * S, px, py, TUBE * pw * S, false, color);
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    for (const f of [0.14, 0.5, 0.86]) {
      const d = (f === 0.5 ? 0.034 : 0.02) / len;
      proj(a[0] + (b[0] - a[0]) * (f - d), 0, a[2] + (b[2] - a[2]) * (f - d));
      const cx0 = px,
        cy0 = py,
        cw0 = pw;
      proj(a[0] + (b[0] - a[0]) * (f + d), 0, a[2] + (b[2] - a[2]) * (f + d));
      tube(cx0, cy0, TUBE * 1.65 * cw0 * S, px, py, TUBE * 1.65 * pw * S, true, color);
    }
    ctx.setLineDash([]);
    for (const p of pk) drawPacket(a, b, p.s, p.dir, p.kind);
  }

  /** Messages are glowing accent dots; heartbeats and handshakes are small hollow rings in their own colours. */
  function drawPacket(a: V3, b: V3, s: number, dir: number, kind: Kind) {
    const data = kind === MSG;
    const c = kind === MSG ? accent : kind === BEAT_K ? beat : shake;
    const s0 = clamp(s - dir * (data ? 0.45 : 0.22), 0, 1);
    proj(a[0] + (b[0] - a[0]) * s0, 0, a[2] + (b[2] - a[2]) * s0);
    const tx = px,
      ty = py;
    proj(a[0] + (b[0] - a[0]) * s, 0, a[2] + (b[2] - a[2]) * s);
    const hx = px,
      hy = py,
      k = pw * lw;
    if (Math.hypot(hx - tx, hy - ty) > 1) {
      const g = ctx.createLinearGradient(tx, ty, hx, hy);
      g.addColorStop(0, rgba(c, 0));
      g.addColorStop(1, rgba(c, data ? 0.95 : 0.75));
      ctx.strokeStyle = g;
      ctx.lineWidth = (data ? 2.2 : 1.5) * k;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    }
    const glowR = (data ? 13 : 10) * k;
    const gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, glowR);
    gr.addColorStop(0, rgba(c, data ? 0.5 : 0.4));
    gr.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(hx, hy, glowR, 0, TAU);
    ctx.fill();
    if (data) {
      ctx.fillStyle = rgba(mix(accent, [255, 255, 255], 0.55), 1);
      ctx.beginPath();
      ctx.arc(hx, hy, 2.3 * k, 0, TAU);
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4 * k, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 1.4 * lw;
      ctx.strokeStyle = rgba(c, 1);
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4 * k, 0, TAU);
      ctx.stroke();
    }
  }

  type Item = { z: number; draw: () => void };
  const items: Item[] = [];

  /** Split a horizontal circle into arcs so each sorts with the bodies around it. */
  function ringArcs(
    cx: number,
    cz: number,
    radius: number,
    y: number,
    offset: number,
    segs: number,
    style: (ctx: CanvasRenderingContext2D) => void
  ) {
    const per = 6;
    for (let s = 0; s < segs; s++) {
      const pts = new Float32Array((per + 1) * 3);
      for (let j = 0; j <= per; j++) {
        const a = offset + ((s + j / per) / segs) * TAU;
        pts[j * 3] = cx + Math.cos(a) * radius;
        pts[j * 3 + 1] = y;
        pts[j * 3 + 2] = cz + Math.sin(a) * radius;
      }
      const mid = per >> 1;
      const z = depth(pts[mid * 3], y, pts[mid * 3 + 2]);
      items.push({
        z,
        draw: () => {
          style(ctx);
          ctx.beginPath();
          path(pts, false);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      });
    }
  }

  // ---- frame
  function render(dt: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    setCamera(theta);

    if (opts.stars !== false) {
      for (const s of starField) {
        const tw = reduced ? 1 : 0.65 + 0.35 * Math.sin(time * s.f + s.ph);
        ctx.fillStyle = rgba(line, s.a * tw * 0.8);
        ctx.beginPath();
        ctx.arc(s.x * cw, s.y * ch, s.r, 0, TAU);
        ctx.fill();
      }
    }

    // apply message timelines
    flash.fill(0);
    for (const p of packets) p.length = 0;
    let hubFlash = 0;
    const waves: number[] = [];
    for (const l of legs) {
      const q = (mt - l.t0) / l.dur;
      if (q < 0 || q > 1) continue;
      const e = easeInOutQuad(q);
      packets[l.spoke].push({ s: l.dir < 0 ? 1 - e : e, dir: l.dir, kind: l.kind });
    }
    for (const f of fxs) {
      if (f.kind === 0) flash[f.i] = Math.max(flash[f.i], env(mt, f.t0, 0.3) * f.k);
      else if (f.kind === 1) hubFlash = Math.max(hubFlash, env(mt, f.t0, 0.4) * f.k);
      else {
        const q = (mt - f.t0) / 0.45;
        if (q >= 0 && q <= 1) waves.push(q);
      }
    }

    // hover easing
    for (let i = 0; i <= N; i++) {
      const target = hover === i || (i === N && hover === -2) ? 1 : 0;
      hoverK[i] += (target - hoverK[i]) * Math.min(1, dt * 14 || 1);
    }

    items.length = 0;
    hits.length = 0;
    ringArcs(0, 0, 0.62, 0, 0, 12, c => {
      c.lineWidth = 0.8 * lw;
      c.strokeStyle = rgba(line, 0.2);
      c.setLineDash([2, 4]);
    });
    for (const q of waves) {
      const r = HUB_A + (WAVE_MAX - HUB_A) * easeOut(q);
      const a = Math.pow(1 - q, 1.4);
      ringArcs(0, 0, r, 0, 0, 24, c => {
        c.lineWidth = 1.5 * lw;
        c.strokeStyle = rgba(accent, 0.75 * a);
      });
      if (r * 0.84 > HUB_A)
        ringArcs(0, 0, r * 0.84, 0, 0, 24, c => {
          c.lineWidth = 0.8 * lw;
          c.strokeStyle = rgba(accent, 0.35 * a);
        });
    }
    clients.forEach((b, i) => {
      items.push({
        z: depth(b.center[0], b.center[1], b.center[2]),
        draw: () => drawBody(b, flash[i], hoverK[i], i, 0, 0.45 + 0.55 * linkLevel(i))
      });
      const s = spokes[i];
      items.push({
        z: depth((s.a[0] + s.b[0]) / 2, 0, (s.a[2] + s.b[2]) / 2),
        draw: () => drawSpoke(i)
      });
    });
    items.push({
      z: 0,
      draw: () => drawBody(hub, hubFlash * 0.9, hoverK[N], -1, Math.max(hubFlash, hoverK[N] * 0.35))
    });
    items.sort((p, q) => q.z - p.z);
    for (const it of items) it.draw();
  }

  function frame(now: number) {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    const live = !opts.paused;
    if (live) {
      time += dt;
      mt += dt * clamp(opts.speed ?? 1, 0.1, 10);
      if (!reduced) theta += dt * (((opts.rotationSpeed ?? 3.5) * Math.PI) / 180);
    }
    if (frameNo++ % 30 === 0) readColors();
    if (live && !reduced && mt >= nextAuto) {
      autoEvent();
      // exponential gaps: events arrive independently and overlap
      nextAuto = mt + Math.max(0.06, -Math.log(1 - Math.random()) * (opts.interval ?? 0.45));
    }
    for (let k = legs.length - 1; k >= 0; k--) if (mt > legs[k].t0 + legs[k].dur) legs.splice(k, 1);
    for (let k = fxs.length - 1; k >= 0; k--) if (mt > fxs[k].t0 + 0.6) fxs.splice(k, 1);
    const busy = legs.length > 0 || fxs.length > 0 || clients.some((_, i) => linkLevel(i) < 1);
    const animating = live && (!reduced || busy);
    const hovering = hoverK.some(
      (v, i) => Math.abs(v - (hover === i || (i === N && hover === -2) ? 1 : 0)) > 0.01
    );
    if (animating || hovering || dirty) {
      render(dt);
      dirty = false;
    }
    if (onScreen && (animating || hovering)) raf = requestAnimationFrame(frame);
    else last = 0;
  }
  function kick() {
    if (!raf && onScreen) raf = requestAnimationFrame(frame);
  }

  // ---- traffic
  const isDown = (i: number) => mt >= offFrom[i] && mt < offTo[i];
  /** 0 while a link is down, ramping back to 1 after it reconnects. */
  function linkLevel(i: number) {
    if (isDown(i)) return 0;
    const since = mt - offTo[i];
    return offTo[i] >= 0 && since >= 0 && since < RESTORE ? since / RESTORE : 1;
  }
  const online = () => clients.map((_, i) => i).filter(i => !isDown(i));
  const pick = (pool: number[]): number | undefined =>
    pool[Math.floor(Math.random() * pool.length)];
  const usable = (i: number | undefined): i is number =>
    i !== undefined && i >= 0 && i < N && !isDown(i);
  /** Deliver a message down link j at time t; if j is offline then, queue it until the handshake finishes. */
  function deliver(j: number, t: number) {
    let t0 = t;
    if (offTo[j] > t && offFrom[j] <= t + HOP) {
      const queued = legs.filter(l => l.spoke === j && l.kind === MSG && l.t0 >= offTo[j]).length;
      t0 = offTo[j] + 0.04 + queued * 0.12;
    }
    legs.push({ spoke: j, dir: 1, t0, dur: HOP, kind: MSG });
  }
  function nextMessage() {
    const msgs = opts.messages?.length ? opts.messages : DEFAULT_MESSAGES;
    return msgs[msgIdx++ % msgs.length];
  }

  /** client → hub → every connected client (the sender included). -1 broadcasts from the hub. */
  function broadcast(client?: number) {
    const from = client === -1 ? -1 : usable(client) ? client : pick(online());
    if (from === undefined) return;
    const msg = nextMessage();
    let t = mt;
    if (from >= 0) {
      fxs.push({ kind: 0, i: from, t0: t, k: 1 });
      legs.push({ spoke: from, dir: -1, t0: t + LEAD, dur: HOP, kind: MSG });
      t += LEAD + HOP;
    }
    fxs.push({ kind: 1, i: -1, t0: t, k: 1 }, { kind: 2, i: -1, t0: t + TURN, k: 1 });
    for (let j = 0; j < N; j++) deliver(j, t + TURN);
    opts.onSend?.(from, msg);
    opts.onEvent?.({ type: 'broadcast', from, message: msg });
    kick();
  }

  /** client → hub → one other client (queued if that client is offline). */
  function relay(a?: number, b?: number) {
    const pool = online();
    if (!pool.length || N < 2) return;
    const from = usable(a) ? a : pick(pool)!;
    const valid = (i: number | undefined): i is number =>
      i !== undefined && i >= 0 && i < N && i !== from;
    const to = valid(b) ? b : pick(clients.map((_, i) => i).filter(i => i !== from))!;
    const msg = nextMessage();
    fxs.push({ kind: 0, i: from, t0: mt, k: 1 });
    legs.push({ spoke: from, dir: -1, t0: mt + LEAD, dur: HOP, kind: MSG });
    const t = mt + LEAD + HOP;
    fxs.push({ kind: 1, i: -1, t0: t, k: 0.5 });
    deliver(to, t + TURN);
    opts.onSend?.(from, msg);
    opts.onEvent?.({ type: 'relay', from, to, message: msg });
    kick();
  }

  /** Heartbeat: ping up to the hub, pong back down. */
  function ping(client?: number) {
    const i = usable(client) ? client : pick(online());
    if (i === undefined) return;
    legs.push(
      { spoke: i, dir: -1, t0: mt, dur: BEAT, kind: BEAT_K },
      { spoke: i, dir: 1, t0: mt + BEAT + 0.03, dur: BEAT, kind: BEAT_K }
    );
    opts.onEvent?.({ type: 'ping', client: i });
    kick();
  }

  /**
   * The link drops (anything on it is lost), stays down for a moment, then a
   * handshake brings it back. Messages sent to it meanwhile are queued.
   */
  function reconnect(client?: number) {
    const i = usable(client) ? client : pick(online());
    if (i === undefined) return;
    for (let k = legs.length - 1; k >= 0; k--) if (legs[k].spoke === i) legs.splice(k, 1);
    const back = mt + OFFLINE;
    offFrom[i] = mt;
    offTo[i] = back + 2 * HOP + TURN;
    legs.push(
      { spoke: i, dir: -1, t0: back, dur: HOP, kind: SHAKE },
      { spoke: i, dir: 1, t0: back + HOP + TURN, dur: HOP, kind: SHAKE }
    );
    opts.onEvent?.({ type: 'reconnect', client: i });
    kick();
  }

  function autoEvent() {
    const w = { ...DEFAULT_TRAFFIC, ...opts.traffic };
    const weights = [
      w.broadcast,
      w.relay,
      w.ping,
      clients.some((_, i) => isDown(i)) ? 0 : w.reconnect
    ].map(v => Math.max(0, v || 0));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    let r = Math.random() * total;
    if ((r -= weights[0]) < 0) broadcast();
    else if ((r -= weights[1]) < 0) relay();
    else if (r < weights[2]) ping();
    else reconnect();
  }

  // ---- pointer
  function hitTest(x: number, y: number) {
    const sorted = [...hits].sort((a, b) => a.z - b.z);
    for (const h of sorted)
      for (const p of h.polys) {
        let inside = false;
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
          const xi = p[i],
            yi = p[i + 1],
            xj = p[j],
            yj = p[j + 1];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return h.i;
      }
    proj(0, 0, 0);
    if (Math.hypot(x - px, y - py) < (HUB_A + 0.04) * S * pw) return -2;
    return -1;
  }
  const local = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const onMove = (e: PointerEvent) => {
    if (opts.interactive === false) return;
    const [x, y] = local(e);
    const h = hitTest(x, y);
    if (h !== hover) {
      hover = h;
      canvas.style.cursor = h !== -1 ? 'pointer' : '';
      kick();
    }
  };
  const onLeave = () => {
    hover = -1;
    canvas.style.cursor = '';
    kick();
  };
  const onClick = (e: MouseEvent) => {
    if (opts.interactive === false) return;
    const [x, y] = local(e);
    const h = hitTest(x, y);
    if (h >= 0) {
      if (!isDown(h)) broadcast(h);
    } else if (h === -2) broadcast(-1);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);

  // ---- observers
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
          onScreen = entry.isIntersecting;
          if (onScreen) {
            dirty = true;
            kick();
          } else if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
            last = 0;
          }
        })
      : null;
  io?.observe(container);
  // Re-read colours as soon as the page theme flips (class / data-theme / OS setting).
  const onTheme = () => {
    readColors();
    dirty = true;
    kick();
  };
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(onTheme) : null;
  mo?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style']
  });
  const schemeQuery =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  schemeQuery?.addEventListener?.('change', onTheme);
  readColors();
  resize();

  return {
    update(next) {
      opts = { ...opts, ...next };
      readColors();
      fit();
      dirty = true;
      kick();
    },
    send: broadcast,
    relay,
    ping,
    reconnect,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
      mo?.disconnect();
      schemeQuery?.removeEventListener?.('change', onTheme);
      reducedQuery?.removeEventListener?.('change', onReduced);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.remove();
    }
  };
}
