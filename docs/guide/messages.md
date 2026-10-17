# Messages and types

This page covers how incoming data is decoded and validated, how outgoing messages are encoded, and how to type both directions.

## Raw data by default

Without options, messages are delivered exactly as the browser gives them in `event.data`: a `string` for text frames, and a `Blob` (or `ArrayBuffer`) for binary frames. `send()` passes its argument straight to `WebSocket.send`.

```tsx
const { lastMessage, send } = useWebSocket<string, string>('wss://api.example.com/echo');
send('hello');
```

## JSON

`json: true` runs `JSON.parse` on incoming data and `JSON.stringify` on outgoing messages:

```tsx
type ServerEvent = { type: 'price'; symbol: string; price: number };
type ClientCommand = { type: 'subscribe'; symbol: string };

const { lastMessage, send } = useWebSocket<ServerEvent, ClientCommand>(
  'wss://api.example.com/prices',
  { json: true }
);

send({ type: 'subscribe', symbol: 'ACME' });
```

The two type parameters are:

- `In`: the type of incoming messages, after decoding. It types `lastMessage`, `onMessage` and the `message` event.
- `Out`: the type that `send()` accepts.

:::warning Generics are not validation
`useWebSocket<ServerEvent>` only tells TypeScript what to expect. Nothing checks it at runtime. To check incoming data, use a [schema](#validating-with-a-schema).
:::

## Custom encoding

`parse` and `serialize` replace the default (or JSON) encoding. They take precedence over `json`.

```ts
import { createWebSocket } from 'react-websocket';
import { decode, encode } from '@msgpack/msgpack';

type Tick = { symbol: string; price: number };
type Command = { subscribe: string[] };

export const feed = createWebSocket<Tick, Command>('wss://api.example.com/feed', {
  binaryType: 'arraybuffer',
  parse: data => decode(new Uint8Array(data as ArrayBuffer)),
  serialize: message => encode(message)
});
```

`binaryType` controls how binary frames arrive: `'blob'` (the browser default) or `'arraybuffer'`. Use `'arraybuffer'` when you decode binary synchronously in `parse`.

## Validating with a schema

`schema` accepts any [Standard Schema](https://standardschema.dev) validator, including zod (3.24+), valibot (1.0+) and arktype (2.0+). The schema runs after `parse`/`json`, and the incoming message type is inferred from it, so you don't need to pass `In` yourself:

```ts
import { z } from 'zod';
import { createWebSocket } from 'react-websocket';

const Tick = z.object({ symbol: z.string(), price: z.number() });

export const prices = createWebSocket('wss://api.example.com/ticks', {
  json: true,
  schema: Tick
});
// prices.getSnapshot().lastMessage: { symbol: string; price: number } | undefined
```

The delivered message is the schema's **output**, so transforms and defaults apply:

```ts
const Tick = z.object({
  symbol: z.string(),
  price: z.number(),
  at: z.string().transform(s => new Date(s))
});
// lastMessage.at is a Date
```

Async schemas (for example zod's `refine` with an async check) are supported. Messages are still delivered in the order they arrived, even if a later one validates faster.

### One socket, many message types

Many servers send several kinds of messages over one socket. Use a discriminated union, either as a type or as a schema, and narrow on the tag:

```tsx
import { z } from 'zod';
import { createWebSocket, useWebSocketEvent } from 'react-websocket';

const LiveEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price'), symbol: z.string(), price: z.number() }),
  z.object({ type: z.literal('chat'), user: z.string(), text: z.string() })
]);

export const live = createWebSocket('wss://api.example.com/live', {
  json: true,
  schema: LiveEvent
});

function ChatLines({ onLine }: { onLine: (line: string) => void }) {
  useWebSocketEvent(live, 'message', event => {
    if (event.type === 'chat') onLine(`${event.user}: ${event.text}`); // narrowed
  });
  return null;
}
```

More patterns are in [Recipes](../recipes.md).

## Invalid messages: `MessageError`

A message that fails to decode (`parse` throws, or `json` gets invalid JSON) or fails `schema` is **not delivered**. `lastMessage` isn't updated and `onMessage` isn't called. Instead, an `error` event is emitted with a `MessageError`:

| Property | |
| --- | --- |
| `message` | `'Failed to parse message'`, `'Message failed schema validation'` or `'Schema validation threw'` |
| `data` | The raw `event.data` that failed |
| `issues` | The schema's issues, for validation failures |
| `cause` | The error thrown by `parse`, `JSON.parse` or the schema, if any |

```tsx
import { MessageError, useWebSocket } from 'react-websocket';

useWebSocket('wss://api.example.com/ticks', {
  json: true,
  schema: Tick,
  onError(error) {
    if (error instanceof MessageError) {
      reportToMonitoring('Bad message from server', { data: error.data, issues: error.issues });
    }
  }
});
```

The connection stays open after a `MessageError`; only that message is dropped.

## Outgoing messages

`send(message)` encodes with `serialize`, or `JSON.stringify` if `json` is set, or passes the message through unchanged. If the socket isn't open yet, the encoded message is queued and sent when it opens. See [the send queue](./reconnecting.md#the-send-queue).

`send` returns `true` if the message went out immediately and `false` if it was queued (or dropped, with `queue: false`).

Outgoing messages are not validated by `schema`. The `Out` type parameter covers them at compile time.

## See also

- Options: [`json`](../api/options.md#json), [`parse`](../api/options.md#parse), [`serialize`](../api/options.md#serialize), [`schema`](../api/options.md#schema), [`binaryType`](../api/options.md#binarytype)
- Types: [`MessageError`](../api/types.md#messageerror), [`StandardSchemaV1`](../api/types.md#standardschemav1), [`SendData`](../api/types.md#senddata)
