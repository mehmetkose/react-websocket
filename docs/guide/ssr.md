---
title: 'WebSockets in Next.js and SSR'
description: 'Use WebSockets in Next.js (App Router), React Router, Remix and Astro: nothing connects during server rendering, and hydration doesn''t mismatch.'
---

# Server rendering and Next.js

react-websocket works in server-rendered apps (Next.js, React Router, Remix, Astro, or your own `renderToPipeableStream` setup) without any configuration. This page explains what happens on the server, how hydration works, and how to structure a Next.js App Router project.

## What happens on the server

- **Nothing connects.** The client only uses the global `WebSocket` when `window` exists. Node 22+ has a global `WebSocket`, but it is never used during a server render.
- **Hooks render `idle`.** `useWebSocket` returns `{ status: 'idle', lastMessage: undefined, attempt: 0 }` and `useWebSocketStatus` returns `'idle'`. Effects don't run on the server, so no connection is attempted.
- **`client.ready` rejects.** There's nothing to wait for on the server. See [below](#suspense-on-the-server).
- **No shared state leaks between requests.** On the server, `useWebSocket(url)` doesn't put clients in the shared URL registry, so one request's client is never reused by another.

On the client, the first render also reports `idle`, matching the server HTML, so hydration never mismatches. The connection starts after hydration, when effects run.

## `'use client'`

The package's main entry is marked `'use client'`, because hooks only work in Client Components. You can't call `useWebSocket` in a Server Component, the same as `useState`. Put WebSocket code in a Client Component and render that from your Server Components.

`react-websocket/core` (no hooks) has no directive. You can import `createWebSocket` from it anywhere, including modules that Server Components import, but it only connects in a browser. Define shared clients with it. Both entries share one runtime, so a client from `core` works with the hooks, and `instanceof MessageError` holds whichever entry you import it from.

## Next.js App Router

Define shared clients in their own module:

```ts
// app/lib/notifications.ts
import { createWebSocket } from 'react-websocket/core'; // no 'use client': safe to import anywhere

export type Notification = { id: string; title: string };

export const notifications = createWebSocket<Notification>(
  'wss://api.example.com/notifications',
  { json: true }
);
```

Use them from a Client Component:

```tsx
// app/components/notification-bell.tsx
'use client';

import { useState } from 'react';
import { useWebSocketEvent, useWebSocketStatus } from 'react-websocket';
import { notifications, type Notification } from '../lib/notifications';

export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const status = useWebSocketStatus(notifications);
  useWebSocketEvent(notifications, 'message', n => setItems(list => [n, ...list]));

  return (
    <button aria-label={`${items.length} notifications`} data-status={status}>
      🔔 {items.length}
    </button>
  );
}
```

And render that from a Server Component, such as a layout:

```tsx
// app/layout.tsx (a Server Component)
import { NotificationBell } from './components/notification-bell';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <NotificationBell />
        </header>
        {children}
      </body>
    </html>
  );
}
```

The server sends the bell with `0` items and `data-status="idle"`. After hydration it connects and updates.

:::tip Environment-specific URLs
In Next.js, only `NEXT_PUBLIC_*` environment variables reach the browser. Use something like `process.env.NEXT_PUBLIC_WS_URL` for the URL, or pass a [`url` function](./authentication.md) that builds it at connection time.
:::

## Suspense on the server

`client.ready` rejects during a server render. If a component calls `use(chat.ready)` there, React treats the rejection like any error thrown during SSR inside a `<Suspense>` boundary: it emits that boundary's fallback in the HTML and renders the subtree on the client. React reports this as a recoverable error (in `onRecoverableError` on the client, and in `onError` on the server).

```tsx
<Suspense fallback={<p>Connecting…</p>}>
  <Room /> {/* calls use(chat.ready) */}
</Suspense>
```

Without a `<Suspense>` boundary above it, the server render fails, so always wrap components that call `use(chat.ready)`.

### Client-only subtrees with `browser()`

React 19.3 added `browser()` to `react-dom`. `use(browser())` states explicitly that a component is browser-only. During SSR it makes the nearest `<Suspense>` boundary send its fallback; in the browser it doesn't suspend at all. Unlike relying on `ready` rejecting, the intent is clear in your code and in React's diagnostics. Call it before `use(chat.ready)`:

```tsx
'use client';

import { use } from 'react';
import { browser } from 'react-dom';
import { chat } from '../lib/chat';

export function Room() {
  use(browser('Live chat needs a WebSocket')); // React 19.3+
  use(chat.ready);
  return <Messages />;
}
```

`browser(reason?)` takes an optional `reason`: a string, or a function the server renderer calls lazily. React uses it as the `cause` of the recoverable error it reports when it defers the subtree to the browser, so your logs say why.

## Hydration and StrictMode

As of React 19.3, StrictMode double-invokes effects during hydration too, just as it does for client-rendered roots. react-websocket closes connections a tick after the last release, so the simulated unmount and remount reuse one socket. Hydrating a StrictMode tree opens exactly one connection. See [StrictMode, Activity and lifecycle](./lifecycle.md).

## Connecting outside the browser

To connect from Node (a script, a worker, a test), pass an implementation explicitly with the [`WebSocket`](../api/options.md#websocket) option, such as Node's global `WebSocket` or the `ws` package. Without `window`, that is the only way the client connects. See [Without React](./without-react.md).

## See also

- [Suspense](./suspense.md)
- [Without React](./without-react.md)
- [Troubleshooting](../troubleshooting.md)
- [Build live notifications](../recipes/live-notifications.md): a notification bell in a layout, with a cache that doesn't break hydration
