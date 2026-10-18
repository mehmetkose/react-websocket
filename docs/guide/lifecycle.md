---
title: 'WebSockets with StrictMode and Activity'
description: 'How react-websocket keeps one WebSocket per URL under React StrictMode, <Activity>, route changes and transitions, without useEffectEvent or useCallback.'
---

# StrictMode, Activity and lifecycle

A connection should follow what's on screen without opening duplicate sockets or reconnecting needlessly. This page explains how react-websocket behaves under StrictMode, `<Activity>`, route changes and transitions, and why you don't need `useEffectEvent` or `useCallback` for handlers.

## How a connection is held

Each hook that uses a connection holds it from an effect: `useWebSocket`, `useWebSocketEvent` and `useWebSocketStatus` acquire it when their effect mounts and release it in the effect's cleanup. The connection opens on the first hold and closes **one tick after** the last release, unless `connect()` was called. See [Shared clients](./shared-clients.md#connection-lifetime).

Most of what follows is a consequence of that one-tick delay.

## StrictMode

In development, `<StrictMode>` mounts each component, simulates an unmount, and mounts it again, to surface effects that don't clean up. The release from the simulated unmount and the hold from the remount happen in the same tick, so the socket is never closed in between:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App /> {/* one socket per URL, not two */}
  </StrictMode>
);
```

React 19.3 also double-invokes effects while **hydrating** server-rendered HTML under StrictMode. The same mechanism applies: hydrating opens one connection.

## `<Activity>`

[`<Activity>`](https://react.dev/reference/react/Activity) (React 19.2+) hides part of the tree while keeping its state. React's guidance is to think of hidden content as unmounted: it **destroys the hidden subtree's effects** and re-creates them when it becomes visible.

So hiding releases the connection, and showing reconnects:

```tsx
import { Activity, useState } from 'react';
import { useWebSocket } from 'react-websocket';

function LivePrices() {
  const { status, lastMessage } = useWebSocket<string>('wss://api.example.com/prices');
  return (
    <p>
      {status}: {lastMessage ?? '—'}
    </p>
  );
}

export function Tabs() {
  const [tab, setTab] = useState<'prices' | 'settings'>('prices');
  return (
    <>
      <button onClick={() => setTab('prices')}>Prices</button>
      <button onClick={() => setTab('settings')}>Settings</button>
      <Activity mode={tab === 'prices' ? 'visible' : 'hidden'}>
        <LivePrices />
      </Activity>
      <Activity mode={tab === 'settings' ? 'visible' : 'hidden'}>
        <Settings />
      </Activity>
    </>
  );
}
```

- **Hidden:** if nothing outside the hidden subtree holds the connection, it closes. A hidden tab doesn't keep a socket open or receive messages it can't show.
- **Visible again:** the effects re-run and the connection opens again.
- **Pre-rendered while hidden:** content rendered for the first time inside a hidden `<Activity>` doesn't mount effects, so it doesn't connect until it's shown.

What survives depends on how you share the connection:

| | After hide → show |
| --- | --- |
| `useWebSocket(url)` | The component keeps its client: `lastMessage` is kept, and shows immediately while it reconnects. If another component opened the URL meanwhile, it shows that one's instead |
| Module-level client (`createWebSocket`) | Same client: `lastMessage` is kept, and shows immediately while it reconnects |

### Keeping a connection open while hidden

To keep receiving while a subtree is hidden (to keep a cache warm, or to count unread messages), hold the connection from **outside** the `<Activity>`:

```tsx
import { Activity } from 'react';
import { useWebSocketStatus } from 'react-websocket';
import { chat } from './chat';

export function ChatTab({ visible }: { visible: boolean }) {
  useWebSocketStatus(chat); // held here, outside the Activity, so hiding doesn't close it
  return (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      <ChatRoom />
    </Activity>
  );
}
```

Or call `chat.connect()` to keep it open for the whole session, until `chat.close()`.

## Route changes

When a navigation unmounts one route and mounts another in the same commit, any connection both routes use survives: the old route's release and the new route's hold happen within the same tick. A connection only the old route used closes.

Changing a URL argument closes the old connection and opens the new one:

```tsx
function Room({ roomId }: { roomId: string }) {
  const { lastMessage } = useWebSocket(`wss://api.example.com/rooms/${roomId}`);
  // …
}
```

If the URL comes from user input, debounce it so you don't connect on every keystroke.

## Handlers see the latest props and state

`onOpen`, `onMessage`, `onClose` and `onError`, and the listener you pass to `useWebSocketEvent`, always see the component's latest props and state. Changing them never reconnects or re-subscribes:

```tsx
function Room({ roomId, muted }: { roomId: string; muted: boolean }) {
  useWebSocket(`wss://api.example.com/rooms/${roomId}`, {
    onMessage: message => {
      if (!muted) playSound(); // reads the current `muted`; toggling it doesn't reconnect
      addMessage(message);
    }
  });
  // …
}
```

This is the behaviour React 19.2's [`useEffectEvent`](https://react.dev/reference/react/useEffectEvent) gives effect code, and the React docs use this very case, a chat connection whose handler reads a `muted` flag, as their example. react-websocket does it internally (in a way that also works on React 18), so:

- **Don't** wrap handlers in `useCallback` to keep the connection stable. It already is.
- **Don't** wrap them in `useEffectEvent`. Effect Events must not be passed to other hooks, and you don't need one here.
- Do write handlers inline, closing over whatever props and state you need.

The only things that change the connection are the URL (and `protocols`), `enabled`, and passing a different client.

`send`, `close` and `reconnect` returned by `useWebSocket` keep the same identity across renders, so they are safe in dependency arrays and as props to memoized children.

## Transitions and View Transitions

Updates from the socket (`status`, `lastMessage`) come from an external store, and React always applies them as **urgent** updates. They can't be marked as transitions. That's the right default for live data: it shows immediately and never animates.

If a message triggers expensive, non-urgent work, such as filtering a large list or switching views, put that state update in a transition yourself:

```tsx
import { startTransition, useState } from 'react';
import { useWebSocketEvent } from 'react-websocket';
import { feed, type Tick } from './feed';

function Dashboard() {
  const [latest, setLatest] = useState<Tick | null>(null);
  const [history, setHistory] = useState<Tick[]>([]);

  useWebSocketEvent(feed, 'message', tick => {
    setLatest(tick); // urgent: the ticker updates immediately
    startTransition(() => setHistory(list => [...list, tick])); // non-urgent: the big chart can lag
  });
  // …
}
```

The same applies to React 19.3's `<ViewTransition>`, which only animates updates made inside a transition, a Suspense reveal or `useDeferredValue`. Socket updates won't animate on their own, which is what you want for a stream of messages. Wrap the specific update you want to animate in `startTransition`.

For more on high-frequency streams, see [Performance](./performance.md).

## See also

- [Shared clients](./shared-clients.md)
- [Server rendering and Next.js](./ssr.md#hydration-and-strictmode)
- [`useWebSocket`](../api/use-websocket.md)
