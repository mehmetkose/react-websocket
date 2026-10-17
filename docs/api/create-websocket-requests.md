# createWebSocketRequests

Send requests over a client and await their replies, matched by an id the library generates.

```ts
function createWebSocketRequests<Req, In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    send: (message: Req, id: number) => Out;
    reply: (message: In) => number | string | null | undefined;
    error?: (message: In) => unknown;
    timeout?: number;
  }
): WebSocketRequests<Req, In>;
```

Available from both `react-websocket` and `react-websocket/core`.

## Usage

```ts
import { createWebSocket, createWebSocketRequests } from 'react-websocket';

type In = { type: 'reply'; id: number; room?: string; error?: string } | { type: 'state' };
type Out = { type: 'join'; room: string; id: number };
type Request = { type: 'join'; room: string };

const game = createWebSocket<In, Out>('wss://game.example.com', { json: true });

export const rpc = createWebSocketRequests(game, {
  send: (message: Request, id) => ({ ...message, id }),
  reply: message => (message.type === 'reply' ? message.id : undefined),
  error: message => (message.type === 'reply' && message.error ? new Error(message.error) : undefined)
});

const reply = await rpc.request({ type: 'join', room: 'lobby' }, { timeout: 5000 });
```

The guide is [Real-time games](../guide/games.md#requests-await-the-server-s-answer).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client to send requests on. `In` and `Out` are taken from it |
| `options.send` | `(message: Req, id: number) => Out` | Builds the outgoing message with its id. Annotate `message`: its type is what `request()` accepts |
| `options.reply` | `(message: In) => number \| string \| null \| undefined` | The id an incoming message replies to, or `undefined` if it isn't a reply. A string id matches the number it was sent as |
| `options.error` | `(message: In) => unknown` | Optional. Return anything but `undefined` to reject the request with it, e.g. for an error reply |
| `options.timeout` | `number` | Optional. Default time to wait for a reply, in ms. `Infinity` waits forever. Default `10000` |

## Returns

`WebSocketRequests<Req, In>`:

| Member | |
| --- | --- |
| `request(message, options?)` | Send `message` and return a promise of its reply. See below |
| `pending()` | Number of requests waiting for a reply |
| `dispose()` | Reject every pending request and stop listening. Only for managers created dynamically |
| `client` | The client |

### request options

`RequestOptions` extends [`SendOptions`](./types.md#sendoptions):

| Option | Type | |
| --- | --- | --- |
| `timeout` | `number` | Overrides the manager's `timeout` for this request |
| `signal` | `AbortSignal` | Aborting rejects the request with `signal.reason`. An already aborted signal sends nothing |
| `volatile` | `boolean` | Reject right away if the socket isn't open, instead of queueing the request |
| `key` | `string` | Passed to `send()`: replaces a queued request with the same key, and the replaced request rejects |
| `onDrop` | `() => void` | Called if the request is dropped from the queue before it's sent. The request rejects either way |

## Behavior

- **Rejects, never hangs.** A request rejects on timeout (a `DOMException` named `TimeoutError`), when `error` returns a value, when its signal aborts, when the connection it was sent on closes, on `close()`, when the client gives up, and on `dispose()`.
- **Lost connections.** A reply can only arrive on the connection the request was sent on. When that connection closes, including through `reconnect()`, the request rejects instead of waiting through the reconnect.
- **Queued while disconnected.** A request made while connecting or reconnecting waits in the client's send queue and goes out when the socket opens. Its timeout runs from the call. With `volatile`, or on a `closed` client, it rejects right away. If it's dropped from the queue before it's sent (replaced by a newer request with the same `key`, or evicted by `queue.limit`), it rejects then. On a client created with `queue: false`, the request is dropped and only rejects on timeout, so pass `volatile` there.
- **Unique ids per client.** Ids count up per client, shared by every manager on it, so two managers on one client never send the same id.
- **Holds the connection.** A pending request holds the client like a mounted hook, so it works without React. The client is released when the request settles.
- **Replies are messages.** Replies also reach `onMessage`, `lastMessage`, `useWebSocketEvent` and state stores. A late reply to a request that already timed out is delivered there and ignored here.
- **Requires TypeScript 5.4+** for the inferred message types (it uses `NoInfer`).
