# Suspense

With React 19, a component can wait for a connection with `use(client.ready)` and let the nearest `<Suspense>` boundary show a fallback in the meantime. This page covers how `ready` behaves, how to handle failures with an error boundary, and how to use it outside React.

## Waiting for the first connection

```tsx
import { Suspense, use } from 'react';
import { createWebSocket, useWebSocketStatus } from 'react-websocket';

export const chat = createWebSocket<{ user: string; text: string }>('wss://api.example.com/chat', {
  json: true
});

function Room() {
  use(chat.ready); // suspends until the socket has opened
  const status = useWebSocketStatus(chat);
  return <p>Connected ({status})</p>;
}

export function ChatPage() {
  return (
    <Suspense fallback={<p>Connecting…</p>}>
      <Room />
    </Suspense>
  );
}
```

Reading `chat.ready` starts an idle client, so `Room` doesn't need another hook to trigger the connection. While anyone is waiting on `ready`, the client won't close the attempt, even if no hook holds it yet. Once it opens, it waits a few seconds for a hook (such as `useWebSocket` in the retried render) to hold it, and closes if none does. So a render that reads `ready` and is then abandoned doesn't leave a socket open.

`use()` needs React 19. On React 18, show a loading state from `status` instead.

## How `ready` behaves

`ready` is a promise that resolves once the socket has **opened**:

| Situation | `ready` |
| --- | --- |
| Idle, connecting, or first attempt failed and retrying | Pending |
| Opened at least once | Resolved |
| Dropped and reconnecting automatically, after having opened | **Still resolved** |
| Gave up reconnecting (`maxAttempts`, `shouldReconnect`) | Rejected |
| `close()` was called | Rejected |
| During a server render | Rejected |
| After `connect()` or `reconnect()` following a rejection | A new pending promise |
| After every hook unmounted (status back to `idle`) | A new pending promise |

The same promise object is returned until its state changes, and it carries the `status`/`value`/`reason` fields React reads. So `use()` doesn't suspend again when the socket is already open, and it doesn't create a new promise on every render.

### Why `ready` stays resolved while reconnecting

`ready` answers "has this connection been established?", not "is the socket open at this instant?". If a reconnect made it pending again, every component that called `use(chat.ready)` would suspend on its next render, and React would replace content the user was already looking at with the fallback spinner on every network blip.

The React docs warn about exactly this for external stores: store updates [can't be marked as non-blocking transitions](https://react.dev/reference/react/useSyncExternalStore#caveats), so suspending on them "will trigger the nearest Suspense fallback, replacing already-rendered content on screen with a loading spinner, which typically makes a poor UX."

So Suspense covers the **first** connection, and `status` covers everything after it. Show reconnects inline:

```tsx
function Room() {
  use(chat.ready);
  const status = useWebSocketStatus(chat);
  return (
    <>
      {status === 'reconnecting' && <div role="status">Reconnecting…</div>}
      <Messages />
    </>
  );
}
```

Messages you `send()` while reconnecting are queued, so they don't need the socket to be open. See [the send queue](./reconnecting.md#the-send-queue).

## Handling failure with an error boundary

When the client gives up, or `close()` is called, `ready` rejects. A component that calls `use(chat.ready)` then throws to the nearest error boundary on its next render. Offer a retry that calls `reconnect()`, which makes `ready` pending again:

```tsx
import { Suspense } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { chat } from './chat';

export function ChatPage() {
  return (
    <ErrorBoundary
      fallbackRender={({ resetErrorBoundary }) => (
        <p>
          Couldn’t connect.{' '}
          <button
            onClick={() => {
              chat.reconnect();
              resetErrorBoundary();
            }}
          >
            Try again
          </button>
        </p>
      )}
    >
      <Suspense fallback={<p>Connecting…</p>}>
        <Room />
      </Suspense>
    </ErrorBoundary>
  );
}
```

`ready` rejects with an `Error` describing the last close, for example `WebSocket closed (code 1006)`, or `WebSocket was closed` after `close()`. If a [`url` function](./authentication.md) failed on the last attempt, it rejects with that error.

::: tip Bound the retries
With the default `maxAttempts: Infinity`, the client keeps retrying a server that is down, so the error boundary shows only after `close()`, a `false` from `shouldReconnect`, or a constructor error. Set `reconnect: { maxAttempts: n }` if you want the error state to appear after a while.
:::

## Outside React

`ready` is an ordinary promise:

```ts
import { chat } from './chat';

await chat.ready; // starts the connection if idle
console.log('connected');
```

Reading `ready` starts the connection but doesn't hold it like a hook does: if nothing holds it, it closes a few seconds after opening. Call `chat.connect()` if the connection should stay open independently of components. See [Shared clients](./shared-clients.md#keeping-a-connection-open-with-connect).

You don't need to `await ready` before calling `send()`. Messages sent earlier are queued and sent on open.

## On the server

During a server render, `ready` rejects (there is no socket to wait for). React treats that as an error in the nearest `<Suspense>` boundary: it sends the fallback in the HTML and renders that subtree on the client instead. On React 19.3+, `use(browser())` expresses the same intent more cleanly. See [Server rendering](./ssr.md#client-only-subtrees-with-browser).

## See also

- [`WebSocketClient.ready`](../api/types.md#websocketclient)
- [Reconnecting and heartbeats](./reconnecting.md)
- [Server rendering and Next.js](./ssr.md)
