---
description: 'WebSocketDevtools from react-websocket/devtools: an overlay that shows each WebSocket client''s status, queue, buffer, messages, round-trip time, topics, feeds, outbox, presence and runs.'
---

# WebSocketDevtools

A panel in a corner of the page that shows what each WebSocket client is doing: its status and reconnect attempts, what's queued and buffered, how many messages it received, and the round-trip time, topics, feeds, outbox, presence and runs of the helpers that use it.

```ts
function WebSocketDevtools(props: {
  sources?: readonly unknown[];
  open?: boolean;
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
}): ReactElement | null;
```

Available only from `react-websocket/devtools`, about 1.8 kB min+gzip, separate from the main entry's size.

## Usage

Render it in development only, so it stays out of your production bundle:

```tsx
import { lazy, Suspense } from 'react';
import { live, topics, latency } from './live';

const WebSocketDevtools = lazy(() =>
  import('react-websocket/devtools').then(module => ({ default: module.WebSocketDevtools }))
);

export function App() {
  return (
    <>
      <Main />
      {import.meta.env.DEV && (
        <Suspense>
          <WebSocketDevtools sources={[live, topics, latency]} />
        </Suspense>
      )}
    </>
  );
}
```

A button in the corner shows how many clients there are, with a dot for the worst status among them. Click it to see each client:

| Row | |
| --- | --- |
| status | `idle`, `connecting`, `open`, `reconnecting (attempt n)` or `closed` |
| queued | Messages waiting in the send queue for the socket to open |
| buffered | Bytes waiting in the browser's send buffer (`bufferedAmount`) |
| received | Messages received since the panel mounted |
| rtt | From a [latency tracker](./create-websocket-latency.md) in `sources` |
| topics, feeds | The topics held by [topics](./create-websocket-topics.md) and [feeds](./create-websocket-feeds.md) in `sources`, with each feed's last number |
| outbox, presence, runs | Waiting messages, peers, and streaming runs from those helpers in `sources` |

## Props

| Prop | Type | |
| --- | --- | --- |
| `sources` | `unknown[]` | Clients from `createWebSocket`, and topics, feeds, latency trackers, outboxes, presence and runs created on them, which are shown with their client. Optional: the clients that `useWebSocket(url)` shares are listed by themselves, in development |
| `open` | `boolean` | Start with the panel open. Default `false` |
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | Which corner. Default `'bottom-right'` |

## Behavior

- **Refresh.** It re-renders twice a second, and counts messages from the moment it mounts.
- **Server rendering.** It renders nothing on the server and during hydration.
- **In production builds,** the clients `useWebSocket(url)` shares aren't listed by themselves; pass their `client` in `sources`.
