---
description: 'createChaosWebSocket creates a WebSocket class that injects network faults, for development. Available only from react-websocket/chaos.'
---

# createChaosWebSocket

Create a `WebSocket` class that injects network faults, to pass as the [`WebSocket`](./options.md#websocket) option during development.

```ts
function createChaosWebSocket(options?: {
  WebSocket?: typeof WebSocket;
  seed?: number;
  logger?: (message: string, ...details: unknown[]) => void;
  enabled?: boolean;
  latency?: number | [min: number, max: number];
  loss?: number | { in?: number; out?: number };
  refuse?: number;
  drop?: number | [min: number, max: number] | false;
  stall?: number | [min: number, max: number] | false;
  corrupt?: number;
}): ChaosWebSocket;
```

Available only from `react-websocket/chaos`. It has no React dependency and doesn't import the client.

## Usage

```ts
import { createWebSocket } from 'react-websocket';
import { createChaosWebSocket } from 'react-websocket/chaos';

export const Chaos = createChaosWebSocket({ latency: [50, 400], drop: [20_000, 60_000] });

export const live = createWebSocket('wss://api.example.com/live', {
  WebSocket: import.meta.env.DEV ? Chaos : undefined
});

Chaos.stall(); // later: from a dev panel, a shortcut or the console
```

The guide is [Chaos testing](../guide/chaos.md).

## Parameters

Durations are in ms. A `[min, max]` range picks a uniformly random value each time it's used. Probabilities are from `0` to `1`.

| Option | Type | |
| --- | --- | --- |
| `WebSocket` | `typeof WebSocket` | Optional. The implementation to wrap, such as a mock or the `ws` package. Default: the global `WebSocket`, in browsers only |
| `seed` | `number` | Optional. Makes the random faults repeatable. Default: unseeded (`Math.random`) |
| `logger` | `(message, ...details) => void` | Optional. Called for every injected fault, e.g. `console.warn` |
| `enabled` | `boolean` | Optional. `false` turns the random faults off without forgetting them. Default `true` |
| `latency` | `number \| [min, max]` | Optional. One-way delay for the handshake, every incoming message and every send. Order is kept. Default `0` |
| `loss` | `number \| { in?, out? }` | Optional. Probability that a message is lost, in both directions or per direction. Default `0` |
| `refuse` | `number` | Optional. Probability that a connection attempt fails before opening. Default `0` |
| `drop` | `number \| [min, max] \| false` | Optional. Each open connection drops after this long. Default `false` |
| `stall` | `number \| [min, max] \| false` | Optional. Each open connection goes silent after this long. Default `false` |
| `corrupt` | `number` | Optional. Probability that an incoming message is cut short and garbled. Default `0` |

## Returns

`ChaosWebSocket`: a class you can pass anywhere a `typeof WebSocket` is expected, with these static methods. Each acts on every connection the class made and is still open or connecting:

| Method | |
| --- | --- |
| `configure(faults)` | Merge new fault options into the current ones (every option above except `WebSocket`, `seed` and `logger`). Changing `drop`, `stall` or `enabled` restarts the timers of open connections |
| `drop(code?, reason?)` | Drop every connection now: `error`, then `close` with code `1006`. With a code, a clean close as if the server sent it, with no `error` |
| `stall()` | Make every open connection go silent |
| `inject(data)` | Deliver `data` to every open connection as if the server had sent it, after any `latency`. Never lost or corrupted |

The methods work whether the random faults are `enabled` or not. Each call to `createChaosWebSocket` returns a new class with its own faults and connections.

## Behavior

- **Faults**
  - **`latency`** delays each event in order, each in its own task.
  - **`refuse`** fires `error`, then `close` with code `1006`, without creating the real socket. It never fires synchronously from the constructor.
  - **`drop`** fires `error`, then `close` with code `1006`. It closes the real socket with `4999 'chaos'`.
  - **`stall`** keeps `readyState` at `OPEN` and discards everything in both directions. The real socket's `close` event is swallowed. Closing a stalled socket closes the real one with your code at once, and fires `close` with code `1006` a task later.
  - **`corrupt`** cuts text at a random point and appends U+FFFD, so it never parses as JSON. It cuts an `ArrayBuffer` or `Blob` short. Any other data becomes `'�'`.
  - **`drop` and `stall` together:** the first to come wins. A stalled connection can still drop later.
- **Seeds.** Each connection gets its own random sequences, one for its lifecycle (refusal, open delay, lifetimes), one for incoming and one for outgoing messages. With the same `seed` and options, the nth connection gets the same faults no matter how much traffic earlier ones carried.
- **No faults, no delay.** With no faults set, or `enabled: false`, events pass through synchronously.
- **Like a browser**
  - `send()` throws `InvalidStateError` while connecting, and does nothing after `close()`.
  - `close()` throws `InvalidAccessError` for codes other than `1000` and `3000`–`4999`.
  - `bufferedAmount` includes sends held back by `latency` and anything sent into a stall.
- **Not on the server.** Without the `WebSocket` option and outside a browser, constructing it throws, so a client using it fails as during any [server render](../guide/ssr.md).
- **Not a `WebSocket`.** `instanceof WebSocket` is `false`. Events have the chaos socket as their `target`.

## Types

```ts
/** A duration in ms, or [min, max] for a uniformly random one each time. */
type ChaosRange = number | readonly [min: number, max: number];

/** The fault options, accepted by createChaosWebSocket and configure(). */
interface ChaosFaults {
  enabled?: boolean;
  latency?: ChaosRange;
  loss?: number | { in?: number; out?: number };
  refuse?: number;
  drop?: ChaosRange | false;
  stall?: ChaosRange | false;
  corrupt?: number;
}

/** ChaosFaults plus WebSocket, seed and logger. */
interface ChaosOptions extends ChaosFaults { /* … */ }

interface ChaosControls {
  configure(faults: ChaosFaults): void;
  drop(code?: number, reason?: string): void;
  stall(): void;
  inject(data: unknown): void;
}

type ChaosWebSocket = typeof WebSocket & ChaosControls;
```
