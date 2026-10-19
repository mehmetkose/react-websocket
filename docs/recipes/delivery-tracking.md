---
title: 'Build live delivery tracking on a map with React and WebSockets'
description: 'Live delivery tracking over WebSockets: a courier marker that glides between GPS fixes without React renders, an ETA on the server clock, and a courier app that sends its position at an adaptive rate and proof of delivery through an outbox.'
---

# Build live delivery tracking on a map

This guide builds both sides of a delivery: the customer's page with the courier moving on a map and an arrival time, and the courier's app that shares its position and the proof of delivery. Positions are easy to send. Making them look right, and getting them through a phone's connection, is the work:

1. **GPS comes once a second.** Moving the marker when a fix arrives makes it jump across the map once a second.
2. **A map at 60 fps isn't React's job.** Rendering the map component on every frame would be wasteful; on every fix, choppy.
3. **The customer's clock is wrong.** Phones are often seconds or minutes off, so an arrival time in the server's clock can't be counted down with `Date.now()`.
4. **The courier's connection comes and goes.** In a basement or a lift, positions pile up. Only the newest one matters when the signal comes back.
5. **The proof of delivery must arrive.** The photo is taken where the signal is worst, and the order isn't done until the server has it.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Everywhere | The messages |
| `track.ts`, `Tracking.tsx` | The customer's browser | The order's topic, the courier's timeline, the map and the ETA |
| `courier.ts`, `CourierApp.tsx` | The courier's phone | Positions and the proof of delivery |
| `server.ts` | Node | Orders, positions, the ETA and proofs |
| `geo.ts`, `simulate.ts` | Node | Distances, and a simulated courier for development |

## The protocol

```ts
// protocol.ts: imported by both apps and the server.
export type Position = { lat: number; lng: number };

export type Stage = 'preparing' | 'on-the-way' | 'arriving' | 'delivered';

export type Proof = { orderId: string; photo: string; at: number; position: Position | null };

export type TrackIn =
  // On `order:<id>`: where the courier is, at `time` on the server's clock.
  | { type: 'position'; orderId: string; time: number; position: Position }
  // On `order:<id>`: the stage, and the arrival time on the server's clock.
  | { type: 'status'; orderId: string; stage: Stage; eta?: number }
  | { type: 'pong'; id: number; time: number }
  // The server has the proof of delivery with this idempotency key.
  | { type: 'ack'; id: string };

export type TrackOut =
  | { type: 'subscribe' | 'unsubscribe'; topic: string }
  | { type: 'ping'; id: number }
  // From the driver's app.
  | { type: 'gps'; orderId: string; position: Position }
  | ({ type: 'delivered'; id: string } & Proof);
```

Each position carries the server's time when it arrived. The customer's page draws between positions by that time, not by when they reach the browser, so network jitter doesn't show.

## The customer's app

```ts
// track.ts: the customer's app.
import {
  createWebSocket,
  createWebSocketLatency,
  createWebSocketState,
  createWebSocketTopics
} from 'react-websocket';
import { createWebSocketTimeline } from 'react-websocket/timeline';
import type { Position, Stage, TrackIn, TrackOut } from './protocol';

export const track = createWebSocket<TrackIn, TrackOut>('wss://delivery.example.com/track', {
  json: true
});

export const orderTopics = createWebSocketTopics(track, {
  subscribe: topic => ({ type: 'subscribe', topic }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic })
});

// The server's clock: the customer's phone may be minutes off, and the ETA is in server time.
export const latency = createWebSocketLatency(track, {
  ping: id => ({ type: 'ping', id }),
  pong: message => (message.type === 'pong' ? message : undefined),
  interval: 10_000
});

export const statuses = createWebSocketState(track, {
  initialState: {} as Record<string, { stage: Stage; eta?: number }>,
  reduce: (all, message) =>
    message.type === 'status'
      ? { ...all, [message.orderId]: { stage: message.stage, eta: message.eta } }
      : all
});

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The courier's positions for one order, to draw between. */
export function courierTimeline(orderId: string) {
  return createWebSocketTimeline(track, {
    snapshot: message =>
      message.type === 'position' && message.orderId === orderId
        ? { time: message.time, state: message.position }
        : undefined,
    interpolate: (from: Position, to: Position, t) => ({
      lat: lerp(from.lat, to.lat, t),
      lng: lerp(from.lng, to.lng, t)
    }),
    // A position comes about once a second: draw two seconds behind, between two we have.
    delay: 2_000,
    latency
  });
}
```

- **`orderTopics`** holds `order:<id>` while the page is open, and subscribes again after a reconnect. See [Topic subscriptions](../guide/topics.md).
- **`latency`** pings every 10 seconds and estimates the offset between the server's clock and the phone's, for the ETA. See [Ping and server time](../guide/games.md#ping-and-server-time).
- **`courierTimeline`** keeps the order's positions on a [timeline](../api/create-websocket-timeline.md), and `at()` returns where the courier was two seconds ago, blended between the two fixes around that time. Two seconds is two GPS intervals, so there's always a next fix to move toward, even when one is late. The timeline was made for multiplayer games. Here it's only interpolation: no inputs, no prediction.

### The map

```tsx
// Tracking.tsx
import { circleMarker, map as createMap, tileLayer } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { useWebSocketState, useWebSocketTopic } from 'react-websocket';
import type { Position } from './protocol';
import { courierTimeline, latency, orderTopics, statuses } from './track';

export function Tracking({ orderId, home }: { orderId: string; home: Position }) {
  useWebSocketTopic(orderTopics, `order:${orderId}`);
  return (
    <main>
      <Eta orderId={orderId} />
      <CourierMap orderId={orderId} home={home} />
    </main>
  );
}

function CourierMap({ orderId, home }: { orderId: string; home: Position }) {
  const ref = useRef<HTMLDivElement>(null);
  const { lat, lng } = home;

  useEffect(() => {
    const map = createMap(ref.current!).setView([lat, lng], 15);
    tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    circleMarker([lat, lng], { radius: 6 }).addTo(map);
    const courier = circleMarker([lat, lng], { radius: 9, fillOpacity: 1 }).addTo(map);

    // Move the marker every frame, between the positions the server sent. No React render.
    const timeline = courierTimeline(orderId);
    let frame = requestAnimationFrame(function draw() {
      const position = timeline.at();
      if (position) courier.setLatLng(position);
      frame = requestAnimationFrame(draw);
    });

    return () => {
      cancelAnimationFrame(frame);
      timeline.dispose();
      map.remove();
    };
  }, [orderId, lat, lng]);

  return <div ref={ref} style={{ height: 400 }} aria-label="The courier on a map" />;
}
```

- **No React render per frame.** The map is created once per order in an effect, and a `requestAnimationFrame` loop moves the marker with Leaflet's `setLatLng`. React renders the page when the ETA changes, and that's all.
- **`circleMarker`** draws the marker as a vector, so there's no marker image to configure in your bundler.
- **The tiles** here come from OpenStreetMap's servers, which are for light use only. Use your own tile provider in production.

The same loop works with any map library that can move a marker, or with a canvas of your own.

### The arrival time

```tsx
const stages = {
  preparing: 'Your order is being prepared',
  'on-the-way': 'On the way',
  arriving: 'Arriving now',
  delivered: 'Delivered'
};

function Eta({ orderId }: { orderId: string }) {
  const status = useWebSocketState(statuses, all => all[orderId]);
  const [, setNow] = useState(0);

  // Count down once a second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!status) return <p role="status">Finding your order…</p>;
  if (status.eta === undefined || status.stage !== 'on-the-way') {
    return <p role="status">{stages[status.stage]}</p>;
  }
  const minutes = Math.max(1, Math.round((status.eta - latency.serverNow()) / 60_000));
  return <p role="status">On the way: about {minutes} min</p>;
}
```

The ETA is a time on the server's clock. `latency.serverNow()` is the phone's clock corrected by the measured offset, so the countdown is right even when the phone's clock isn't.

## The courier's app

```ts
// courier.ts: the courier's app.
import { createWebSocket, createWebSocketSendRate } from 'react-websocket';
import { createWebSocketOutbox } from 'react-websocket/outbox';
import type { Position, Proof, TrackIn, TrackOut } from './protocol';

export const courier = createWebSocket<TrackIn, TrackOut>('wss://delivery.example.com/courier', {
  json: true
});

// At most a position a second, down to one every five on a congested link. Between sends,
// only the newest is kept, and after a reconnect only the newest goes out.
const gps = createWebSocketSendRate(courier, { maxRate: 1, minRate: 0.2 });

let last: Position | null = null;

/** Share the courier's position for an order, until the returned function is called. */
export function shareLocation(orderId: string) {
  const watch = navigator.geolocation.watchPosition(
    ({ coords }) => {
      last = { lat: coords.latitude, lng: coords.longitude };
      gps.send({ type: 'gps', orderId, position: last }, 'gps');
    },
    error => console.warn(`No location: ${error.message}`),
    { enableHighAccuracy: true, maximumAge: 2_000 }
  );
  return () => navigator.geolocation.clearWatch(watch);
}

// Kept in IndexedDB until the server has it: the courier may be in a basement, offline.
export const proofs = createWebSocketOutbox(courier, {
  name: 'proofs',
  send: (proof: Proof, id) => ({ type: 'delivered', id, ...proof }),
  ack: message => (message.type === 'ack' ? message.id : undefined)
});

export async function deliver(orderId: string, photo: File) {
  await proofs.add({ orderId, photo: await shrink(photo), at: Date.now(), position: last });
}

/** A photo small enough to store and send: 800 px at most, as JPEG. */
async function shrink(file: File) {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}
```

- **Positions go through [`createWebSocketSendRate`](../api/create-websocket-send-rate.md)**, keyed `'gps'`: at most one a second, however often the phone reports, and down to one every five seconds when the send buffer fills on a weak signal. Between sends only the newest position is kept, so after a dead zone the server gets where the courier is, not where they've been.
- **The proof of delivery goes through an [outbox](../guide/outbox.md).** It's stored in IndexedDB and sent until the server acknowledges it, through lost signal, reconnects and a closed app.
- **The photo is shrunk first**, to 800 pixels at most, so it's quick to store and send.

```tsx
// CourierApp.tsx
import { useEffect, useState } from 'react';
import { useWebSocketOutbox, useWebSocketStatus } from 'react-websocket';
import { courier, deliver, proofs, shareLocation } from './courier';

export function CourierApp({ orderId }: { orderId: string }) {
  const status = useWebSocketStatus(courier); // also holds the connection
  const waiting = useWebSocketOutbox(proofs);
  const [sharing, setSharing] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => (sharing ? shareLocation(orderId) : undefined), [sharing, orderId]);

  return (
    <main>
      <p role="status">{status === 'open' ? 'Online' : 'Offline: your deliveries are saved'}</p>
      <button onClick={() => setSharing(!sharing)} disabled={done}>
        {sharing ? 'Stop sharing my location' : 'Start the delivery'}
      </button>
      <label>
        Photo of the delivery
        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={done}
          onChange={async event => {
            const photo = event.target.files?.[0];
            if (!photo) return;
            await deliver(orderId, photo);
            setSharing(false);
            setDone(true);
          }}
        />
      </label>
      {waiting.length > 0 && <p>{waiting.length} delivery waiting to sync</p>}
    </main>
  );
}
```

The send rate doesn't hold the connection, so the app does, with `useWebSocketStatus`. The outbox holds it by itself while a proof is waiting.

## The server

The server runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name.

### Positions and the ETA

```ts
// server.ts
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { distance } from './geo.ts';
import type { Position, Stage, TrackIn, TrackOut } from './protocol.ts';

export type Order = { id: string; destination: Position; stage: Stage; eta?: number };

const orders = new Map<string, Order & { position?: Position; time?: number }>(); // your database
const watchers = new Map<string, Set<WebSocket>>(); // the customers on each `order:<id>`
const proofs = new Map<string, string>(); // photo by proof key: your storage

const SPEED = 8; // meters a second, for the ETA. Use your routing service's estimate.

function send(socket: WebSocket, message: TrackIn) {
  socket.send(JSON.stringify(message));
}

function publish(orderId: string, message: TrackIn) {
  for (const socket of watchers.get(`order:${orderId}`) ?? []) send(socket, message);
}

const status = (order: Order): TrackIn => ({
  type: 'status',
  orderId: order.id,
  stage: order.stage,
  eta: order.eta
});

export function createOrder(order: Order) {
  orders.set(order.id, order);
}

/** A position from the courier's phone. */
export function moved(orderId: string, position: Position) {
  const order = orders.get(orderId);
  if (!order || order.stage === 'delivered') return;
  order.position = position;
  order.time = Date.now();
  publish(orderId, { type: 'position', orderId, time: order.time, position });

  const left = distance(position, order.destination);
  const stage = left < 150 ? 'arriving' : 'on-the-way';
  const eta = order.time + (left / SPEED) * 1_000;
  // A new ETA only when it changes by half a minute, not with every position.
  if (stage !== order.stage || Math.abs(eta - (order.eta ?? 0)) > 30_000) {
    Object.assign(order, { stage, eta });
    publish(orderId, status(order));
  }
}
```

- **Every position is published** to the order's topic, with the server's time.
- **The ETA is published only when it changes by half a minute**, or the stage changes, not with every position. The customer's page counts down by itself in between.
- **`SPEED`** stands in for your routing service. A straight line at eight meters a second is optimistic in a city.

### The two apps

```ts
function customer(socket: WebSocket, message: TrackOut) {
  if (message.type !== 'subscribe' && message.type !== 'unsubscribe') return;
  const topic = message.topic;
  if (message.type === 'unsubscribe') {
    watchers.get(topic)?.delete(socket);
    return;
  }
  // Check that the order belongs to this customer before you subscribe them.
  const order = orders.get(topic.slice('order:'.length));
  if (!order) return;
  let sockets = watchers.get(topic);
  if (!sockets) watchers.set(topic, (sockets = new Set()));
  sockets.add(socket);
  // Where things are now, so the page doesn't wait for the next move.
  send(socket, status(order));
  if (order.position && order.time) {
    send(socket, {
      type: 'position',
      orderId: order.id,
      time: order.time,
      position: order.position
    });
  }
}

function courier(socket: WebSocket, message: TrackOut) {
  // Check that the courier is assigned to the order.
  if (message.type === 'gps') moved(message.orderId, message.position);
  if (message.type !== 'delivered') return;
  // Sent again until acknowledged, from a phone that keeps losing signal: store it once.
  if (!proofs.has(message.id)) {
    proofs.set(message.id, message.photo);
    const order = orders.get(message.orderId);
    if (order) {
      Object.assign(order, { stage: 'delivered', eta: undefined });
      publish(order.id, status(order));
    }
  }
  send(socket, { type: 'ack', id: message.id });
}

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', (socket, request) => {
  // Authenticate both apps, as in the Authentication guide.
  const handle = request.url === '/courier' ? courier : customer;
  socket.on('message', data => {
    const message = JSON.parse(String(data)) as TrackOut; // validate it in production
    if (message.type === 'ping') {
      return send(socket, { type: 'pong', id: message.id, time: Date.now() });
    }
    handle(socket, message);
  });
  socket.on('close', () => {
    for (const sockets of watchers.values()) sockets.delete(socket);
  });
});

server.listen(Number(process.env.PORT ?? 8080));
```

- **A new subscriber gets the order's status and the last position at once**, so the map doesn't wait for the courier to move.
- **A proof is stored once.** The outbox sends it again until it's acknowledged, so the server keeps the keys it has. Acknowledge only once the photo is stored.
- **Check who's asking.** A customer may only subscribe to their own orders, and a courier may only send positions for orders assigned to them. Authenticate both apps, as in [Authentication](../guide/authentication.md).

### A simulated courier

To work on the customer's page without a courier on the road, run a simulation instead of the server: it starts the server and drives a route.

```ts
// geo.ts
import type { Position } from './protocol.ts';

/** Meters between two points. */
export function distance(a: Position, b: Position) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
```

```ts
// simulate.ts: a courier that drives a route, for trying the customer's page without one.
import { setTimeout as sleep } from 'node:timers/promises';
import { distance } from './geo.ts';
import type { Position } from './protocol.ts';
import { createOrder, moved } from './server.ts';

const route: Position[] = [
  { lat: 53.3438, lng: -6.2546 },
  { lat: 53.3454, lng: -6.2592 },
  { lat: 53.3478, lng: -6.2603 },
  { lat: 53.3497, lng: -6.2603 }
];

createOrder({ id: 'demo', destination: route.at(-1)!, stage: 'preparing' });

// 8 meters a second, a GPS fix a second, along each leg of the route.
for (const [i, from] of route.slice(0, -1).entries()) {
  const to = route[i + 1]!;
  const steps = Math.ceil(distance(from, to) / 8);
  for (let step = 1; step <= steps; step++) {
    await sleep(1_000);
    const t = step / steps;
    moved('demo', {
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t
    });
  }
}
```

## When things go wrong

| What happens | What the customer or courier sees | Why |
| --- | --- | --- |
| A GPS fix arrives late | The marker keeps moving smoothly | The page draws two seconds behind, between fixes it already has |
| The customer's connection drops | The marker stops where it was, then carries on | The timeline holds the last position until positions arrive on the new connection |
| The customer's phone clock is off | The right ETA | `serverNow()` |
| The courier's signal is weak | Positions every few seconds instead of every second | The send rate halves when the send buffer fills, and climbs back when it drains |
| The courier is in a dead zone | The customer sees the marker stop, then jump to where the courier is now | Only the newest position is kept while disconnected |
| The courier delivers with no signal | "1 delivery waiting to sync", then "Delivered" for the customer | The outbox keeps the proof and sends it on the next connection, even after the app is closed and opened again |

In Chrome, against the server on this page with the simulated courier: positions arrived once a second, and over three seconds the marker moved on 181 of 182 frames. With the server's clock set two minutes ahead of the browser's, the latency estimate found an offset of 120.0 s, and the page showed "about 1 min" (1.16 minutes left). `Date.now()` would have said 3.16. Through a reconnect mid-route, the marker never moved backward, and held still for at most 77 frames before moving on.

In the courier's app, with a location fix every 300 ms, the server received about one position a second. A 1600 × 1200 photo of 21 KB became an 8 KB message. Taken while the server was down, it survived a reload of the app in IndexedDB, reached the server once when it came back, and the customer's page changed to "Delivered".

## Testing it

The simulation drives the customer's page. For the courier's app, browsers' developer tools can override the location, and the outbox can be tested offline by stopping the server, delivering, reloading, and starting the server again. To test without IndexedDB, pass `storage: memoryStorage()` to the outbox.

## See also

- [`createWebSocketTimeline`](../api/create-websocket-timeline.md) and [Real-time games](../guide/games.md), where the timeline comes from
- [`createWebSocketSendRate`](../api/create-websocket-send-rate.md) and [`createWebSocketLatency`](../api/create-websocket-latency.md)
- [Offline outbox](../guide/outbox.md) and [`useWebSocketOutbox`](../api/use-websocket-outbox.md)
- [Topic subscriptions](../guide/topics.md)
