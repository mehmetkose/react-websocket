---
layout: home

hero:
  name: react-websocket
  text: WebSockets for React, done right
  tagline: One hook. Shared connections, automatic reconnects, typed messages and Suspense, for React 18 and 19. Zero dependencies, about 2.5 kB.
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
  - icon: 🔌
    title: Shared connections
    details: Every component using the same URL shares one socket. StrictMode, <Activity> and route transitions never open duplicates.
  - icon: 🔁
    title: Reconnects for you
    details: Exponential backoff with jitter, an immediate retry when the network or tab comes back, and optional heartbeats to detect dead links.
  - icon: 📬
    title: Send before you're connected
    details: Messages sent while connecting or reconnecting are queued and delivered in order once the socket opens.
  - icon: 🧩
    title: Typed messages
    details: Parse JSON, plug in your own codec, or validate with zod, valibot or arktype through Standard Schema. Types are inferred.
  - icon: ⏳
    title: Suspense-ready
    details: use(client.ready) waits for the first connection, then stays out of the way. Reconnects never flash a fallback.
  - icon: 🌐
    title: SSR and Server Components
    details: Never connects during a server render, hydrates without mismatches, and ships a 'use client' entry for Next.js.
---

## At a glance

```tsx
import { useWebSocket } from 'react-websocket';

type Price = { symbol: string; price: number };

function Ticker() {
  const { status, lastMessage, send } = useWebSocket<Price, { subscribe: string }>(
    'wss://api.example.com/prices',
    { json: true, onOpen: () => send({ subscribe: 'ACME' }) }
  );

  if (status !== 'open') return <p>{status}…</p>;
  return <p>ACME: {lastMessage?.price ?? '—'}</p>;
}
```

That's the whole setup. Read the [getting started guide](./guide/getting-started.md) next.
