# Chaos testing

On your machine the network never fails. The server is a few milliseconds away, nothing drops, and every message arrives whole. So the code that handles a bad network, such as reconnecting, the send queue, heartbeat timeouts and invalid messages, rarely runs before your users hit it.

`react-websocket/chaos` makes the network bad on purpose. It's a `WebSocket` class that wraps the real one and adds latency, lost and corrupt messages, and refused, dropped and stalled connections. You pass it as the [`WebSocket`](../api/options.md#websocket) option, so the client, your server and your app stay the same.

## Set up

Create one chaos class and pass it to your clients in development:

```ts
// sockets.ts
import { createWebSocket } from 'react-websocket';
import { createChaosWebSocket } from 'react-websocket/chaos';

export const Chaos = createChaosWebSocket({
  latency: [50, 400], // each message takes 50–400 ms each way
  loss: 0.02, // 2% of messages are lost
  drop: [20_000, 60_000], // every connection drops after 20–60 s
  logger: console.warn
});

export const live = createWebSocket('wss://api.example.com/live', {
  json: true,
  WebSocket: import.meta.env.DEV ? Chaos : undefined
});
```

`import.meta.env.DEV` is replaced with `false` in a production build, so the bundler removes the chaos class along with the condition. Use a condition the bundler can evaluate. A runtime flag works too, but it keeps the class (about 2 kB) in your bundle.

With Next.js and other server-rendering frameworks, also check for a browser, so the server never sees the option:

```ts
const chaos = process.env.NODE_ENV === 'development' && typeof window !== 'undefined';

export const live = createWebSocket(url, { WebSocket: chaos ? Chaos : undefined });
```

With hooks, pass it the same way: `useWebSocket(url, { WebSocket: Chaos })`. Hooks that share a URL share one client, and its [options come from the first one to render](./shared-clients.md#by-url), so give every hook for that URL the same class.

## Faults

Every fault is off until you set it.

| Option | What happens | What it tests |
| --- | --- | --- |
| `latency: 200` or `[50, 400]` | The handshake, every incoming message and every send is delayed by this many ms. Order is kept. A round trip takes twice as long | Loading states, request timeouts, a heartbeat `timeout` shorter than the round trip |
| `loss: 0.05` or `{ in, out }` | Each message is lost with this probability, in both directions or only one | Missing updates, request `TimeoutError`, resyncing |
| `refuse: 0.3` | Each connection attempt fails before opening, with `error` and then `close` code `1006`. The server never sees it | Backoff, `attempt`, `maxAttempts`, Suspense fallbacks on `ready` |
| `drop: [10_000, 30_000]` | Each open connection dies after a random time in this range, with `error` and then `close` code `1006` | The reconnecting UI, the send queue, topic resubscribes, requests dropped by a disconnect |
| `stall: [10_000, 30_000]` | Each open connection goes silent after a random time in this range. Nothing arrives, sends vanish, `readyState` stays `OPEN`, and no `close` event fires | [`heartbeat.timeout`](./reconnecting.md#heartbeats) |
| `corrupt: 0.05` | Each incoming message is cut short with this probability. Text gets U+FFFD appended, so it never parses as JSON | `onError` with a [`MessageError`](../api/types.md#messageerror) |

A stall is what happens when a laptop sleeps or a NAT forgets the connection: the socket is dead but nothing says so. Without a heartbeat `timeout`, the client stays `open` forever, and `send()` keeps returning `true` while every message disappears. Try `stall` once on any app that stays open for long.

## Trigger faults on demand

Random faults show you how the app copes over time. To look at one case, trigger it yourself. The class has static methods that act on every connection it made:

| Method | |
| --- | --- |
| `Chaos.drop()` | Drop every connection now: `error`, then `close` with code `1006` |
| `Chaos.drop(code, reason)` | Close every connection as the server would, e.g. `drop(4001, 'unauthorized')`. A clean close, with no `error` |
| `Chaos.stall()` | Make every open connection go silent |
| `Chaos.inject(data)` | Deliver `data` as if the server had sent it, after any latency |
| `Chaos.configure(faults)` | Change the faults while running |

A small panel during development:

```tsx
import { Chaos } from './sockets';

export function ChaosPanel() {
  return (
    <div className="chaos-panel">
      <button onClick={() => Chaos.drop()}>Drop</button>
      <button onClick={() => Chaos.stall()}>Stall</button>
      <button onClick={() => Chaos.inject('{"type":"price","price":"cheap"}')}>Bad message</button>
      <label>
        <input type="checkbox" onChange={event => Chaos.configure({ latency: event.target.checked ? 1000 : 0 })} />
        Slow network
      </label>
    </div>
  );
}
```

Or expose it on the console with `globalThis.chaos = Chaos` and type `chaos.drop()` while you watch the UI.

Some cases worth trying:

- **A server outage.** Refuse every attempt, drop the connection, and see how the app looks after a few backoff rounds:

  ```ts
  Chaos.configure({ refuse: 1 });
  Chaos.drop();
  setTimeout(() => Chaos.configure({ refuse: 0 }), 30_000);
  ```

- **Rejected credentials.** `Chaos.drop(4001, 'unauthorized')` tests your [`shouldReconnect`](./reconnecting.md#giving-up) and [authentication](./authentication.md) handling.
- **A message your server doesn't send yet.** `inject` takes any string or binary data. It isn't lost or corrupted, so you can try a new message type, or a valid message that fails your `schema`.

`configure` merges into the current faults, so `configure({ loss: 0.1 })` leaves `latency` alone. Each option is replaced whole: `configure({ loss: { in: 0.1 } })` replaces an earlier `{ out }`. Changing `drop`, `stall` or `enabled` restarts the timers of open connections. `configure({ enabled: false })` turns off every random fault without forgetting the settings. The methods work whether it's enabled or not.

## Reproducible runs

Pass a `seed` to get the same faults every time. Each connection has its own random sequence, so whether the third connection is refused, or when it drops, doesn't depend on how much traffic the first two carried. Faults on messages repeat when the same messages arrive in the same order.

A random seed per session, logged, lets you replay a run that went wrong:

```ts
const seed = Number(sessionStorage.getItem('chaos-seed') ?? Date.now() % 1e6);
sessionStorage.setItem('chaos-seed', String(seed));
console.info('chaos seed', seed);

export const Chaos = createChaosWebSocket({ seed, refuse: 0.2, drop: [10_000, 30_000] });
```

The client's own reconnect jitter is random too. Set `reconnect: { jitter: 0 }` when you need exact timing.

## In tests

The chaos class can wrap a [mock `WebSocket`](./testing.md#a-copy-paste-mock), so your tests can check how the app recovers. With fake timers:

```ts
import { createWebSocket } from 'react-websocket/core';
import { createChaosWebSocket } from 'react-websocket/chaos';
import { MockImpl, MockWebSocket } from './mock-websocket';

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('reconnects when a stalled connection misses a heartbeat', () => {
  const Chaos = createChaosWebSocket({ WebSocket: MockImpl });
  const client = createWebSocket('ws://test/live', {
    WebSocket: Chaos,
    heartbeat: { interval: 1000, pong: 'pong', timeout: 500 },
    reconnect: { jitter: 0 }
  });
  client.connect();
  MockWebSocket.last.open();

  Chaos.stall();
  vi.advanceTimersByTime(1500); // the ping goes unanswered
  expect(client.getSnapshot().status).toBe('reconnecting');
});
```

Without faults, the chaos class passes everything through synchronously, so `MockWebSocket.last.open()` opens the client right away. With `latency`, each event is delivered in its own task, as in a browser. Under fake timers, an event due at the same moment as the one before it arrives a millisecond later, so advance a little past the latency, or use `vi.advanceTimersToNextTimer()`.

## How it behaves

- **Events.** Your code sees the events a browser would fire: `error` before a `close` with code `1006`, no `open` after `close()`, and no messages after `close()`. `readyState` follows the connection as your app sees it, so it's `CONNECTING` until the delayed `open` arrives.
- **The server's side.** Refused attempts never reach the server. When a connection drops, the real connection is closed with code `4999` and reason `'chaos'`, so your server frees it and its logs say why. A stalled connection stays open on the server until your app closes it, and then the server sees your close code, such as `4000` for a heartbeat timeout.
- **Closing a stalled connection.** The close handshake can't finish, so the `close` event has code `1006`, one task later.
- **`bufferedAmount`** includes sends still held back by `latency` and anything sent into a stall, so it grows as it would on a real slow or dead connection.
- **It's not a `WebSocket`.** `client.socket instanceof WebSocket` is `false`. Everything else on the [`WebSocket`](https://developer.mozilla.org/docs/Web/API/WebSocket) interface works, including `addEventListener`.
- **Browsers only, unless you say otherwise.** With no `WebSocket` option, it wraps the global `WebSocket` in browsers. On a server (no `window`) it throws when constructed, so the client fails the way it does during any [server render](./ssr.md). Pass `WebSocket` explicitly to use it in Node or a worker.

## Limits

- **TCP doesn't lose single messages.** On an open connection, a WebSocket delivers every message, in order, or the connection dies. `loss` stands for messages lost around a dead connection: sent into a socket that was already half-open, or published by the server while the client was reconnecting. Use it to test that your app notices gaps and resyncs, not to model packet loss.
- **No bandwidth limit.** Latency is added per message, whatever its size.
- **No hung handshake.** A connection attempt either opens (after `latency`) or is refused.

## See also

- [`createChaosWebSocket`](../api/chaos.md): every option and method
- [Reconnecting and heartbeats](./reconnecting.md)
- [Testing](./testing.md)
