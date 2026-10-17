# createWebSocketRequests

Send requests over a client and await their replies, or iterate over a stream of them, matched by an id the library generates.

```ts
function createWebSocketRequests<Req, In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    send: (message: Req, id: number) => Out;
    reply: (message: In) => number | string | null | undefined;
    error?: (message: In) => unknown;
    done?: (message: In) => boolean;
    cancel?: (id: number) => Out;
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

The guide is [Real-time games](../guide/games.md#requests-await-the-servers-answer).

### Streaming replies

When one request gets many replies, such as tokens from a model, set `done` to recognize the last one and iterate with `stream()`. Set `cancel` to tell the server to stop when the loop exits early or the request is aborted.

```ts
export const ask = createWebSocketRequests(agent, {
  send: (message: { prompt: string }, id) => ({ type: 'ask', id, ...message }),
  reply: message => ('id' in message ? message.id : undefined),
  error: message => (message.type === 'failed' ? new Error(message.error) : undefined),
  done: message => message.type === 'end',
  cancel: id => ({ type: 'stop', id }),
  timeout: 60_000
});

let text = '';
for await (const reply of ask.stream({ prompt }, { signal })) {
  if (reply.type === 'token') text += reply.text;
}
```

In React, [`useWebSocketStream`](./use-websocket-stream.md) folds the replies into state. The guide is [AI agents](../guide/agents.md#streaming-the-answer).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client to send requests on. `In` and `Out` are taken from it |
| `options.send` | `(message: Req, id: number) => Out` | Builds the outgoing message with its id. Annotate `message`: its type is what `request()` accepts |
| `options.reply` | `(message: In) => number \| string \| null \| undefined` | The id an incoming message replies to, or `undefined` if it isn't a reply. A string id matches the number it was sent as |
| `options.error` | `(message: In) => unknown` | Optional. Return anything but `undefined` to reject the request (or end the stream) with it, e.g. for an error reply |
| `options.done` | `(message: In) => boolean` | Optional, needed by `stream()`. `true` for the last reply of a stream. That reply is yielded too |
| `options.cancel` | `(id: number) => Out` | Optional. Builds the message that tells the server to stop working on request `id`. See [Cancel](#behavior) |
| `options.timeout` | `number` | Optional. Default time to wait for a reply, in ms. For a stream, the time to wait for each reply, including the first. `Infinity` waits forever. Default `10000` |

## Returns

`WebSocketRequests<Req, In>`:

| Member | |
| --- | --- |
| `request(message, options?)` | Send `message` and return a promise of its reply. See below |
| `stream(message, options?)` | Send `message` and return an `AsyncIterableIterator<In>` of its replies, up to and including the one `done` matches. Throws a `TypeError` without `done` |
| `pending()` | Number of requests and streams waiting for a reply |
| `dispose()` | Reject every pending request, end every stream with an error, send `cancel` for each, and stop listening. Only for managers created dynamically |
| `client` | The client |

### request options

`RequestOptions`, for both `request()` and `stream()`, extends [`SendOptions`](./types.md#sendoptions):

| Option | Type | |
| --- | --- | --- |
| `timeout` | `number` | Overrides the manager's `timeout` for this request. For a stream, the time to wait for each reply |
| `signal` | `AbortSignal` | Aborting rejects the request, or makes the stream throw, with `signal.reason`. An already aborted signal sends nothing |
| `volatile` | `boolean` | Reject right away if the socket isn't open, instead of queueing the request |
| `key` | `string` | Passed to `send()`: replaces a queued request with the same key, and the replaced request rejects |
| `priority` | `boolean` | Passed to `send()`: queues the request ahead of messages queued without `priority`. For a cancel that must not wait behind a backlog |
| `maxBuffered` | `number` | Passed to `send()`: while open, reject right away if more than this many bytes are already waiting in the send buffer |
| `maxAge` | `number` | Passed to `send()`: reject instead of sending if the request has waited in the queue longer than this many ms |
| `onDrop` | `() => void` | Called if the request is dropped from the queue before it's sent. The request rejects either way |

## Behavior

- **Rejects, never hangs.** A request rejects on timeout (a `DOMException` named `TimeoutError`), when `error` returns a value, when its signal aborts, when the connection it was sent on closes, on `close()`, when the client gives up, and on `dispose()`. A stream throws in the same cases.
- **Lost connections.** A reply can only arrive on the connection the request was sent on. When that connection closes, including through `reconnect()`, the request rejects instead of waiting through the reconnect.
- **Queued while disconnected.** A request made while connecting or reconnecting waits in the client's send queue and goes out when the socket opens. Its timeout runs from the call. With `volatile`, or on a `closed` client, it rejects right away. So does a request dropped by `maxBuffered` while open. If it's dropped from the queue before it's sent (replaced by a newer request with the same `key`, evicted by `queue.limit`, or older than `maxAge`), it rejects then. On a client created with `queue: false`, the request is dropped and only rejects on timeout, so pass `volatile` there.
- **Unique ids per client.** Ids count up per client, shared by every manager on it, so two managers on one client never send the same id.
- **Holds the connection.** A pending request or stream holds the client like a mounted hook, so it works without React. The client is released when the request settles or the stream ends.
- **Streams.** `stream()` sends right away, like `request()`. Replies that arrive before the loop reads them are buffered, so a slow loop misses nothing. A stream is read once, by one loop. `request()` with `done` set still resolves with the first reply.
- **Idle timeout.** A stream's `timeout` restarts with every reply, so a long answer never times out while replies keep coming. It also covers the wait for the first reply: a model that thinks before answering may need a longer `timeout`.
- **Failure order.** When a stream fails, it yields the replies it already received, then throws. Aborting its signal is different: it throws `signal.reason` at the next read and discards what's buffered, so a Stop button takes effect at once. A failure nobody reads yet is kept for the next read, never reported as an unhandled rejection.
- **Cancel.** With `cancel` set, the message it builds is sent when this side gives up while the server may still be working: the signal aborts, the request times out, a loop over a stream exits early (`break`, `return`, or a throw in its body), and on `dispose()`. It isn't sent after the last reply, an error reply, a lost connection or `close()`. A cancel for a request still in the send queue is queued right behind it, since a queued message can't be taken back. A cancel for a request already sent goes out only on that connection, and is dropped if it's closing.
- **Replies are messages.** Replies also reach `onMessage`, `lastMessage`, `useWebSocketEvent` and state stores. A late reply to a request that already timed out is delivered there and ignored here.
- **Requires TypeScript 5.4+** for the inferred message types (it uses `NoInfer`).
