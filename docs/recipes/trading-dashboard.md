---
title: 'Build a live trading dashboard with React and WebSockets'
description: 'A market dashboard over one WebSocket: a long watchlist that streams only the rows on screen, renders once per frame, an order book that stays exact through lost messages, and orders placed exactly once.'
---

# Build a live trading dashboard

This guide builds a trading screen: a watchlist of hundreds of symbols, the order book of the selected one, and a ticket to buy it. Market data is the classic firehose, and every part of the screen fails in its own way when it's handled naively:

1. **Thousands of updates a second.** One render per message freezes the page long before the network is the problem.
2. **Most rows are off screen.** Subscribing to all 500 symbols of a watchlist pays for prices nobody is looking at.
3. **The order book must be exact.** Every change builds on the one before. Miss one and every level after it is wrong, with nothing to show it.
4. **An order must be placed once.** When the connection drops right after Buy, the app doesn't know whether the order went through, and clicking again may buy twice.
5. **A frozen price looks like a quiet market.** A connection that died silently keeps showing the last prices as if they were current.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `live.ts` | The browser | The connection, quotes, order books and orders |
| `Dashboard.tsx` | The browser | The watchlist, the order book and the ticket |
| `server.ts` | Node | A simulated market, with order books and orders |

## The protocol

Quotes and order books are topics. A quote carries the latest price, so a missed one doesn't matter: the next replaces it. An order book is a snapshot followed by numbered changes, so a missed one does.

```ts
// protocol.ts: imported by the browser and the server.
export type Quote = { symbol: string; price: number; change: number };

/** A price level of an order book: [price, size]. */
export type Level = [price: number, size: number];

export type Order = { symbol: string; side: 'buy' | 'sell'; qty: number; limit: number };

export type MarketIn =
  // The latest quote, on `quote:<symbol>`. Sent at once on subscribe, then on every change.
  | { type: 'quote'; topic: string; quote: Quote }
  // An order book on `book:<symbol>`: the whole book as of `seq`, then numbered changes.
  | { type: 'book'; topic: string; seq: number; bids: Level[]; asks: Level[] }
  | { type: 'level'; topic: string; seq: number; side: 'bid' | 'ask'; price: number; size: number }
  // The answer to an order.
  | { type: 'placed'; id: number; orderId: string; filled: number }
  | { type: 'rejected'; id: number; reason: string };

export type MarketOut =
  | { type: 'subscribe'; topic: string; after?: number }
  | { type: 'unsubscribe'; topic: string }
  | ({ type: 'order'; id: number; clientOrderId: string } & Order);
```

## The client

### Quotes

```ts
// live.ts
import {
  createWebSocket,
  createWebSocketFeeds,
  createWebSocketRequests,
  createWebSocketState,
  createWebSocketTopics
} from 'react-websocket';
import type { Level, MarketIn, MarketOut, Order, Quote } from './protocol';

export const market = createWebSocket<MarketIn, MarketOut>('wss://market.example.com/live', {
  json: true,
  // A frozen price looks just like a quiet market. Ping every 10 s, and reconnect if nothing
  // at all arrives within 3 s of a ping.
  heartbeat: { interval: 10_000, pong: 'pong', timeout: 3_000 }
});

// Quotes: only the latest one matters, so plain topics, subscribed again after a reconnect.
export const quoteTopics = createWebSocketTopics(market, {
  subscribe: topic => ({ type: 'subscribe', topic }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic })
});

export const quotes = createWebSocketState(market, {
  initialState: {} as Record<string, Quote>,
  reduce: (all, message) =>
    message.type === 'quote' ? { ...all, [message.quote.symbol]: message.quote } : all,
  batch: 'frame' // one render per frame at most, however fast quotes arrive
});
```

- **The heartbeat** finds a connection that died without a close: no data at all within 3 seconds of a ping, and the client reconnects. Market data arrives all the time, so any message counts as a sign of life. See [Heartbeats](../guide/reconnecting.md#heartbeats).
- **`quoteTopics`** holds a subscription per symbol, and subscribes again to every held symbol after a reconnect, so prices come back without any code of yours. See [Topic subscriptions](../guide/topics.md).
- **`quotes`** keeps the latest quote per symbol in one store. With `batch: 'frame'`, its readers render at most once per animation frame, however many quotes arrive in it. See [Batching a fast stream](../guide/performance.md#batching-a-fast-stream).

### The order book

```ts
// Order books: every change counts, in order, so numbered feeds.
export const bookFeeds = createWebSocketFeeds(market, {
  subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic }),
  sequence: message => (message.type === 'level' ? message : undefined),
  snapshot: message => (message.type === 'book' ? message : undefined),
  onGap: (topic, after, received) =>
    console.warn(`${topic}: expected ${after + 1}, got ${received}`)
});

export type Book = { bids: Map<number, number>; asks: Map<number, number> };

export const books = createWebSocketState(bookFeeds, {
  initialState: {} as Record<string, Book>,
  reduce: (all, message) => {
    if (message.type === 'book') {
      const book = { bids: new Map(message.bids), asks: new Map(message.asks) };
      return { ...all, [message.topic]: book };
    }
    if (message.type !== 'level') return all;
    const book = all[message.topic];
    if (!book) return all;
    const key = message.side === 'bid' ? 'bids' : 'asks';
    const side = new Map(book[key]);
    if (message.size === 0) side.delete(message.price);
    else side.set(message.price, message.size);
    return { ...all, [message.topic]: { ...book, [key]: side } };
  },
  batch: 'frame'
});

/** The best `depth` levels of one side, best first. */
export function top(side: Map<number, number>, depth: number, descending: boolean): Level[] {
  return [...side].sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0])).slice(0, depth);
}
```

[Numbered feeds](../guide/topics.md#numbered-feeds) deliver each change once and in order. A change that skips a number is held back, `onGap` is called, and the feed asks the server for what's missing. After a reconnect it asks for the changes after the last one it applied. When the server no longer has them, it sends the whole book again, and the store replaces it.

### Orders

```ts
export class OrderRejected extends Error {}

export const orders = createWebSocketRequests(market, {
  send: (order: Order & { clientOrderId: string }, id) => ({ type: 'order', id, ...order }),
  reply: message =>
    message.type === 'placed' || message.type === 'rejected' ? message.id : undefined,
  error: message => (message.type === 'rejected' ? new OrderRejected(message.reason) : undefined)
});

export async function placeOrder(order: Order) {
  // Never queue an order behind a reconnect: by then the price has moved.
  if (market.getSnapshot().status !== 'open') {
    throw new Error("You're offline. The order wasn't sent.");
  }
  // The idempotency key: the server places each one once, and answers again with its result.
  const message = { ...order, clientOrderId: crypto.randomUUID() };
  try {
    return await orders.request(message, { volatile: true, timeout: 5_000 });
  } catch (error) {
    if (error instanceof OrderRejected) throw error;
    // Sent, but no answer: it may have been placed. Ask again with the same key, after the
    // reconnect if there is one, to find out without placing it twice.
    return await orders.request(message, { timeout: 30_000 });
  }
}
```

`placeOrder` handles the three ways an order can end:

| What happens | What the user sees | Why |
| --- | --- | --- |
| The server answers | "Placed 5f0d045b", or why it was rejected | The `placed` or `rejected` reply. A rejection is thrown as `OrderRejected` and isn't retried |
| The connection is down when they click | "You're offline. The order wasn't sent." | Nothing was sent, so it's safe to say. An order queued behind a reconnect would go out at a price the user never saw |
| It was sent, and no answer came back | "Sending…", then the result once the connection is back | The same `clientOrderId` again. The server places each key once and answers with the result it already has |

## The page

### The watchlist

```tsx
// Dashboard.tsx
import { useMemo, useRef, useState } from 'react';
import {
  useInView,
  useWebSocketState,
  useWebSocketStatus,
  useWebSocketTopic
} from 'react-websocket';
import { bookFeeds, books, market, placeOrder, quotes, quoteTopics, top } from './live';

export function Dashboard({ symbols }: { symbols: string[] }) {
  const [selected, setSelected] = useState(symbols[0]!);
  const status = useWebSocketStatus(market);
  // While reconnecting, every price on screen may be out of date: say so.
  const stale = status !== 'open';
  return (
    <main data-stale={stale || undefined}>
      {stale && <p role="status">Reconnecting… prices may be out of date.</p>}
      <ul className="watchlist">
        {symbols.map(symbol => (
          <Row key={symbol} symbol={symbol} onSelect={setSelected} />
        ))}
      </ul>
      <OrderBook symbol={selected} />
      <Ticket symbol={selected} />
    </main>
  );
}

function Row({ symbol, onSelect }: { symbol: string; onSelect: (symbol: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  // Subscribe only while the row is on screen, or nearly.
  const visible = useInView(ref, { rootMargin: '200px' });
  useWebSocketTopic(quoteTopics, visible ? `quote:${symbol}` : null);
  // Re-renders only when this symbol's quote changes.
  const quote = useWebSocketState(quotes, all => all[symbol]);
  return (
    <li ref={ref} onClick={() => onSelect(symbol)}>
      <span>{symbol}</span>
      <span>{quote?.price.toFixed(2) ?? '—'}</span>
      <span className={quote && quote.change < 0 ? 'down' : 'up'}>
        {quote ? `${quote.change > 0 ? '+' : ''}${quote.change.toFixed(2)}%` : ''}
      </span>
    </li>
  );
}
```

- **Each row subscribes only while it's on screen.** [`useInView`](../api/use-in-view.md) watches the row inside its scrolling list, and [`useWebSocketTopic`](../api/use-websocket-topic.md) holds `quote:<symbol>` while it's `true`. A row that scrolls in subscribes, and the server answers with the current quote at once. One that scrolls out unsubscribes a tick later, and keeps showing its last price.
- **Each row re-renders only for its own symbol.** The selector picks `all[symbol]`, so a quote for another symbol leaves the row alone. See [`useWebSocketState`](../api/use-websocket-state.md).
- **While reconnecting, the page says so.** `data-stale` lets your CSS grey the prices out until they're live again.

### The order book and the ticket

```tsx
function OrderBook({ symbol }: { symbol: string }) {
  useWebSocketTopic(bookFeeds, `book:${symbol}`);
  const book = useWebSocketState(books, all => all[`book:${symbol}`]);
  const [bids, asks] = useMemo(
    () => (book ? [top(book.bids, 10, true), top(book.asks, 10, false)] : [[], []]),
    [book]
  );
  return (
    <section aria-label={`${symbol} order book`}>
      <table>
        <tbody>
          {[...asks].reverse().map(([price, size]) => (
            <tr key={price} className="ask">
              <td>{price.toFixed(2)}</td>
              <td>{size}</td>
            </tr>
          ))}
          {bids.map(([price, size]) => (
            <tr key={price} className="bid">
              <td>{price.toFixed(2)}</td>
              <td>{size}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Ticket({ symbol }: { symbol: string }) {
  const [qty, setQty] = useState(10);
  const [result, setResult] = useState('');
  // The selected symbol may be scrolled out of the watchlist: hold its quote here too.
  useWebSocketTopic(quoteTopics, `quote:${symbol}`);
  const price = useWebSocketState(quotes, all => all[symbol]?.price);

  async function buy() {
    if (price === undefined) return;
    setResult('Sending…');
    try {
      const reply = await placeOrder({ symbol, side: 'buy', qty, limit: price });
      setResult(reply.type === 'placed' ? `Placed ${reply.orderId}` : '');
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void buy();
      }}
    >
      <input
        type="number"
        min={1}
        value={qty}
        onChange={event => setQty(event.target.valueAsNumber)}
      />
      <button disabled={price === undefined}>Buy {symbol}</button>
      <output>{result}</output>
    </form>
  );
}
```

The ticket holds the selected symbol's quote topic too, so its price stays live when the row is scrolled out of the watchlist. Topics are counted, so two holders share one subscription.

## The server

The market here is simulated. In production, the same messages come from your market data provider or matching engine. The server runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name.

### Topics and the order book's history

```ts
// server.ts: a simulated market. In production, these messages come from your market data feed.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Level, MarketIn, MarketOut, Order } from './protocol.ts';

type Book = {
  mid: number;
  seq: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
  history: (MarketIn & { type: 'level' })[]; // the latest changes, to resume from
};

const prices = new Map<string, { price: number; open: number }>();
const books = new Map<string, Book>();
const subscribers = new Map<string, Set<WebSocket>>();
const placed = new Map<string, Promise<{ orderId: string; filled: number }>>(); // your database

function send(socket: WebSocket, message: MarketIn) {
  socket.send(JSON.stringify(message));
}

function publish(topic: string, message: MarketIn) {
  for (const socket of subscribers.get(topic) ?? []) send(socket, message);
}

function priceOf(symbol: string) {
  let entry = prices.get(symbol);
  if (entry) return entry;
  const open = round(20 + Math.random() * 480);
  prices.set(symbol, (entry = { price: open, open }));
  return entry;
}

function quote(symbol: string): MarketIn {
  const { price, open } = priceOf(symbol);
  const change = ((price - open) / open) * 100;
  return { type: 'quote', topic: `quote:${symbol}`, quote: { symbol, price, change } };
}

function bookFor(symbol: string) {
  let book = books.get(symbol);
  if (book) return book;
  const mid = priceOf(symbol).price;
  const side = (sign: number) =>
    new Map(Array.from({ length: 20 }, (_, i) => [round(mid + sign * (i + 1) * 0.01), 100]));
  books.set(symbol, (book = { mid, seq: 0, bids: side(-1), asks: side(1), history: [] }));
  return book;
}

const round = (price: number) => Math.round(price * 100) / 100;
const levels = (side: Map<number, number>): Level[] => [...side];

function subscribe(socket: WebSocket, topic: string, after: number | undefined) {
  let sockets = subscribers.get(topic);
  if (!sockets) subscribers.set(topic, (sockets = new Set()));
  sockets.add(socket);

  const [kind, symbol = ''] = topic.split(':');
  if (kind === 'quote') return send(socket, quote(symbol));
  const book = bookFor(symbol);
  const oldest = book.history[0]?.seq ?? book.seq + 1;
  if (after === undefined || after < oldest - 1) {
    // Too far behind, or new: the whole book as of now.
    send(socket, {
      type: 'book',
      topic,
      seq: book.seq,
      bids: levels(book.bids),
      asks: levels(book.asks)
    });
  } else {
    for (const change of book.history) if (change.seq > after) send(socket, change);
  }
}

async function place(order: Order) {
  await sleep(30); // your matching engine
  return { orderId: randomUUID().slice(0, 8), filled: order.qty };
}
```

`subscribe` is where the feed's promises are kept: a new subscriber gets the whole book, and one coming back with `after` gets the changes since, from the last thousand. One that's further behind gets the whole book again.

### The connection and the simulation

```ts
const isString = (value: unknown) => typeof value === 'string';

/** A client's message, if it's JSON with the fields its type needs. */
function parse(data: string): MarketOut | undefined {
  try {
    const message = JSON.parse(data);
    const type = message?.type;
    if (type === 'subscribe' && isString(message.topic) && Number.isInteger(message.after ?? 0))
      return message;
    if (type === 'unsubscribe' && isString(message.topic)) return message;
    if (
      type === 'order' &&
      isString(message.clientOrderId) &&
      isString(message.symbol) &&
      (message.side === 'buy' || message.side === 'sell') &&
      Number.isFinite(message.qty) &&
      Number.isFinite(message.limit)
    )
      return message;
  } catch {
    // Not JSON.
  }
  return undefined;
}

const wss = new WebSocketServer({ port: Number(process.env.PORT ?? 8080), path: '/live' });

wss.on('connection', socket => {
  socket.on('error', console.error);
  socket.on('message', data => {
    if (String(data) === 'ping') return socket.send('pong');
    const message = parse(String(data));
    if (!message) return socket.close(1003, 'Invalid message');
    switch (message.type) {
      case 'subscribe':
        subscribe(socket, message.topic, message.after);
        break;
      case 'unsubscribe':
        subscribers.get(message.topic)?.delete(socket);
        break;
      case 'order': {
        const { id, clientOrderId, ...order } = message;
        if (order.qty * order.limit > 1_000_000) {
          send(socket, { type: 'rejected', id, reason: 'Orders are limited to 1,000,000.' });
          break;
        }
        // Each key is placed once. Asking again answers with the same result.
        let result = placed.get(clientOrderId);
        if (!result) placed.set(clientOrderId, (result = place(order)));
        void result.then(placement => send(socket, { type: 'placed', id, ...placement }));
        break;
      }
    }
  });
  socket.on('close', () => {
    for (const sockets of subscribers.values()) sockets.delete(socket);
  });
});

// Quotes: each symbol someone watches moves about five times a second.
setInterval(() => {
  for (const [topic, sockets] of subscribers) {
    if (!topic.startsWith('quote:') || !sockets.size || Math.random() < 0.5) continue;
    const entry = priceOf(topic.slice(6));
    entry.price = round(Math.max(1, entry.price * (1 + (Math.random() - 0.5) / 500)));
    publish(topic, quote(topic.slice(6)));
  }
}, 100);

// Books: a level of each watched book changes twenty times a second.
setInterval(() => {
  for (const [symbol, book] of books) {
    const topic = `book:${symbol}`;
    if (!subscribers.get(topic)?.size) continue;
    const bid = Math.random() < 0.5;
    const price = round(book.mid + (bid ? -1 : 1) * Math.ceil(Math.random() * 25) * 0.01);
    const size = Math.random() < 0.2 ? 0 : Math.ceil(Math.random() * 500);
    if (size) (bid ? book.bids : book.asks).set(price, size);
    else (bid ? book.bids : book.asks).delete(price);
    const change: Book['history'][number] = {
      type: 'level',
      topic,
      seq: ++book.seq,
      side: bid ? 'bid' : 'ask',
      price,
      size
    };
    book.history.push(change);
    if (book.history.length > 1000) book.history.shift();
    publish(topic, change);
  }
}, 50);
```

- **`ping`** is answered with `pong`, for the client's heartbeat.
- **`parse` checks every message** before the server uses it: JSON, a known `type`, and the fields that type needs. Anything else closes only that socket, with `1003`, which the client doesn't retry. An error thrown in the listener would stop the server and drop every client.
- **Orders are idempotent.** `placed` keeps the result of each `clientOrderId`, so the same key asked again, after a lost answer, gets the same order instead of a second one. Keep it in your database, with a lifetime longer than the client's retry.

## A binary codec

JSON is easy to read in the browser's network panel. If bandwidth matters more, plug in a binary codec such as MessagePack. Nothing else on this page changes:

```ts
// live.ts, with MessagePack instead of JSON
import { decode, encode } from '@msgpack/msgpack';
import { createWebSocket } from 'react-websocket';
import type { MarketIn, MarketOut } from './protocol';

export const market = createWebSocket<MarketIn, MarketOut>('wss://market.example.com/live', {
  binaryType: 'arraybuffer',
  parse: data => decode(data as ArrayBuffer) as MarketIn,
  serialize: message => encode(message),
  heartbeat: { interval: 10_000, pong: 'pong', timeout: 3_000 }
});
```

The server encodes with `encode(message)`, and `parse` decodes with `decode(data)` in place of `JSON.parse`. Measured with `@msgpack/msgpack`, a quote from this page is 92 bytes as JSON and 79 as MessagePack, and an order book change 87 and 67. Compression (`permessage-deflate`, which `ws` supports) shrinks JSON too, at some CPU cost on both ends: measure both on your own traffic.

## When things go wrong

| What happens | What the user sees | Why |
| --- | --- | --- |
| They scroll the watchlist | Prices fill in as rows appear | `useInView` subscribes rows that scroll in. The server sends the current quote on subscribe |
| Quotes arrive faster than the screen refreshes | A smooth page | `batch: 'frame'`: one render per frame at most |
| A book change goes missing | Nothing | The feed holds later changes back and asks again from the last one it applied |
| The connection drops | "Reconnecting… prices may be out of date.", then live prices | Topics and feeds subscribe again on the new connection. Feeds ask for what they missed |
| The connection dies silently | The same, within 3 seconds of the next ping | The heartbeat's `timeout` |
| They click Buy while offline | "You're offline. The order wasn't sent." | `placeOrder` checks before sending |
| The connection drops after Buy | "Sending…", then the order, placed once | The same `clientOrderId`, asked again after the reconnect |

In Chrome, against the server on this page with 500 symbols moving about five times a second each, in a watchlist showing 20 rows: with `useInView`, 21 symbols were subscribed (the visible rows and the ticket's), and the page received 117 messages a second and committed 30 renders a second. With every row subscribed, it received 2,514 messages a second. With `batch: 'frame'`, that was still 31 commits a second at 57 frames per second. Without it, every message was a render: 1,679 commits a second, and the page dropped to 10 frames per second.

With 5 % of incoming messages dropped by [`react-websocket/chaos`](../guide/chaos.md), the order book saw six gaps in ten seconds, and afterwards matched the server's book level for level. An order whose connection was dropped right after it was sent was placed once: the retry, 856 ms later on the new connection, got the same order id.

## Testing it

Drop messages on purpose to see the order book recover. Wrap the socket in [`react-websocket/chaos`](../guide/chaos.md) in development, with `loss: { in: 0.05 }`, and watch `onGap` in the console. To test order idempotency, call `Chaos.drop()` right after `placeOrder()` starts, and check that the server placed the order once.

## See also

- [Performance](../guide/performance.md): what re-renders when, and batching
- [Topic subscriptions and numbered feeds](../guide/topics.md)
- [Message state](../guide/state.md) and [`useWebSocketState`](../api/use-websocket-state.md)
- [`useInView`](../api/use-in-view.md), [`createWebSocketFeeds`](../api/create-websocket-feeds.md), [`createWebSocketRequests`](../api/create-websocket-requests.md)
- [Reconnecting and heartbeats](../guide/reconnecting.md)
