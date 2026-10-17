---
pageType: home
titleSuffix: 'React WebSocket hook with auto-reconnect'
description: 'A WebSocket hook for React 18 and 19: shared connections, auto-reconnect, a send queue, typed messages and Suspense. Zero dependencies, about 3 kB.'

hero:
  name: react-websocket
  text: WebSockets for React, done right
  tagline: One hook. Shared connections, automatic reconnects, typed messages and Suspense, for React 18 and 19. Zero dependencies, about 3 kB min+gzip.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why react-websocket?
      link: /guide/
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: Shared connections
    details: Every component using the same URL shares one socket. StrictMode, &lt;Activity&gt; and route transitions never open duplicates.
  - title: Reconnects for you
    details: Exponential backoff with jitter, an immediate retry when the network or tab comes back, and optional heartbeats to detect dead links.
  - title: Send before you're connected
    details: Messages sent while connecting or reconnecting are queued and delivered in order once the socket opens.
  - title: Typed messages
    details: Parse JSON, plug in your own codec, or validate with zod, valibot or arktype through Standard Schema. Types are inferred.
  - title: Suspense-ready
    details: With React 19, use(client.ready) waits for the first connection, then stays out of the way. Reconnects never flash a fallback.
  - title: SSR and Server Components
    details: Never connects during a server render, hydrates without mismatches, and ships a 'use client' entry for Next.js.
---

## At a glance

```sh
npm install react-websocket
```

```tsx
import { useWebSocket } from 'react-websocket';

type Price = { symbol: string; price: number };

function Ticker() {
  const { status, lastMessage, send } = useWebSocket<Price, { subscribe: string }>(
    'wss://api.example.com/prices',
    {
      json: true,
      // Runs after every (re)connect, by which time `send` is assigned.
      onOpen: () => send({ subscribe: 'ACME' })
    }
  );

  if (status !== 'open') return <p>{status}…</p>;
  return <p>ACME: {lastMessage?.price ?? '—'}</p>;
}
```

That's the whole setup. Read the [getting started guide](./guide/getting-started.mdx) next.

## Works with your stack

react-websocket uses the standard `WebSocket` API, so any WebSocket server works: Node's `ws`, Hono, Django Channels, Tornado, Go, Phoenix or Cloudflare Durable Objects. In the browser it runs in a Vite app or in a server-rendered framework such as [Next.js, React Router or Astro](./guide/ssr.md), and [`react-websocket/core`](./guide/without-react.md) brings the same client to code without React.

The repository has runnable [examples](https://github.com/mehmetkose/react-websocket/tree/main/examples) for Next.js, Astro, Remix, Hono and Tornado.
