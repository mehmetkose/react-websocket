---
title: 'Migrating from react-websocket v2'
description: 'Upgrade from the react-websocket v2 <Websocket> component to v3 hooks: every v2 prop and method mapped to v3, and the behaviour changes.'
---

# Migrating from v2

v2 was a class component that rendered an empty `<div>` and exposed methods through a ref. v3 replaces it with hooks and a standalone client. This page maps every v2 prop and method to v3 and lists the behaviour changes.

## Before and after

```jsx
// v2
import Websocket from 'react-websocket';

class ProductDetail extends React.Component {
  state = { count: 90 };

  handleData = data => {
    const result = JSON.parse(data);
    this.setState(({ count }) => ({ count: count + result.movement }));
  };

  render() {
    return (
      <div>
        Count: <strong>{this.state.count}</strong>
        <button onClick={() => this.refWebSocket.sendMessage('refresh')}>Refresh</button>
        <Websocket
          url="wss://api.example.com/live/product/12345/"
          onMessage={this.handleData}
          reconnectIntervalInMilliSeconds={5000}
          debug
          ref={ws => (this.refWebSocket = ws)}
        />
      </div>
    );
  }
}
```

```tsx
// v3
import { useState } from 'react';
import { useWebSocket } from 'react-websocket';

function ProductDetail() {
  const [count, setCount] = useState(90);
  const { send } = useWebSocket<{ movement: number }, string>(
    'wss://api.example.com/live/product/12345/',
    {
      parse: data => JSON.parse(data as string), // incoming only; outgoing strings are sent as-is
      onMessage: ({ movement }) => setCount(c => c + movement),
      reconnect: { minDelay: 5000, maxDelay: 5000, jitter: 0 },
      logger: console.debug
    }
  );

  return (
    <div>
      Count: <strong>{count}</strong>
      <button onClick={() => send('refresh')}>Refresh</button>
    </div>
  );
}
```

`parse` decodes incoming messages only, so `send('refresh')` sends the raw string `refresh`, as v2's `sendMessage` did. Don't reach for `json: true` here: it also `JSON.stringify`s outgoing messages, so `send('refresh')` would send `"refresh"` (with quotes). Use `json: true` when your server expects JSON in both directions.

## Mapping

| v2 | v3 |
| --- | --- |
| `import Websocket from 'react-websocket'` | `import { useWebSocket } from 'react-websocket'` |
| `<Websocket url onMessage />` | `useWebSocket(url, { onMessage })` |
| `ref.sendMessage(msg)` | `const { send } = useWebSocket(...)`; `send(msg)` |
| `onOpen()` | `onOpen(event)` |
| `onClose(code, reason)` | `onClose({ code, reason, wasClean })` |
| `onError(event)` | `onError(error)`: the socket's error `Event`, or an `Error` |
| `onMessage(evt.data)` (raw data) | `onMessage(message, event)`: raw data by default; parsed with `json: true` |
| `reconnect={false}` | `reconnect: false` |
| `reconnectIntervalInMilliSeconds={n}` | `reconnect: { minDelay: n, maxDelay: n, jitter: 0 }` |
| `protocol="x"` | `protocols: 'x'` (or an array) |
| `debug` | `logger: console.debug` |
| `ref.open()` / `ref.close()` | `enabled: true/false`, or `reconnect()` / `close()` |

## Behaviour changes

**Shared connections.** In v2, every `<Websocket>` opened its own socket. In v3, all components using the same URL share one socket, opened when the first mounts and closed a tick after the last unmounts. Its options come from the component that created it. Use [`createWebSocket`](./guide/shared-clients.md) to define a connection's options once.

**Backoff with jitter.** v2 waited 1, 3, 7, 15, then 30 seconds between attempts, and never reset the count after a successful reconnect. v3 waits 1, 2, 4, 8, 16, then 30 seconds by default, shaves a random part off each delay so clients don't reconnect in lockstep, and resets after every successful open (v4 resets only once a connection has stayed open for 5 seconds; see [Migrating from v3](./migration-v3.md)). It also retries immediately when the browser comes back online or the tab becomes visible. See [Reconnecting](./guide/reconnecting.md).

**`onClose` receives an object.** `onClose(code, reason)` becomes `onClose({ code, reason, wasClean })`. It's called for every close, including ones that will be retried.

**`send` works before the socket is open.** v2's `sendMessage` threw if the socket wasn't open yet. v3 queues the message and sends it on connect. `send` returns `true` if it went out immediately. Set `queue: false` to drop instead.

**`close()` means closed.** In v2, `ref.close()` triggered a reconnect. In v3, `close()` stops reconnecting until you call `connect()` or `reconnect()`.

**The URL can change.** v2 ignored a new `url` prop. In v3, changing the URL closes the old connection and opens the new one.

**Server rendering works.** v2 created the socket in its constructor, which crashed during a server render. v3 never connects on the server and its hooks are marked `'use client'`.

**No wrapper element.** v2 rendered an empty `<div>`. Hooks render nothing.

**React 18 or later.** v2 supported React 16.8 and up; v3 requires React 18 or 19. Prop types are gone; types come from the TypeScript definitions included in the package.

## Gradual migration

If you can't convert every class component at once, wrap the hook in a small component with the v2 prop names:

```tsx
import { useWebSocket } from 'react-websocket';

type LegacyProps = {
  url: string;
  onMessage: (data: unknown) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  reconnect?: boolean;
};

export function LegacyWebsocket({ url, onMessage, onOpen, onClose, reconnect = true }: LegacyProps) {
  useWebSocket(url, {
    reconnect,
    onMessage,
    onOpen: () => onOpen?.(),
    onClose: ({ code, reason }) => onClose?.(code, reason)
  });
  return null;
}
```

For `sendMessage` from a class component, define the connection with [`createWebSocket`](./guide/shared-clients.md) and call `client.send()` directly; no ref is needed.
