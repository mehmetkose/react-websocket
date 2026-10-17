# useWebSocketLatency

Read round-trip time and server clock offset from [`createWebSocketLatency`](./create-websocket-latency.md).

```ts
function useWebSocketLatency(latency: WebSocketLatency): Latency;
```

## Usage

```tsx
import { useWebSocketLatency } from 'react-websocket';
import { latency } from './latency';

function Ping() {
  const { rtt } = useWebSocketLatency(latency);
  return <span>{rtt === undefined ? '–' : `${Math.round(rtt)} ms`}</span>;
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `latency` | `WebSocketLatency` | From `createWebSocketLatency` |

## Returns

[`Latency`](./create-websocket-latency.md#latency): `{ rtt, offset }`, both in ms, both `undefined` until the first pong.

## Behavior

- **Renders.** It re-renders when a measurement changes, about once per ping interval.
- **Connection.** It holds the client connection while mounted, like the other hooks.
- **Server rendering.** On the server and during hydration, both values are `undefined`.
- **Server time.** For the server's clock, call `latency.serverNow()` where you need it, such as in a timer or animation frame, instead of rendering `offset`.
