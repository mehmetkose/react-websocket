---
description: 'Answer requests the server sends: in code, for tools only the browser has, or by a person, for approvals. The reverse of createWebSocketRequests.'
---

# createWebSocketResponder

Answer requests the server sends: in code, for tools that only exist in the browser, or by a person, for approvals. The reverse of [`createWebSocketRequests`](./create-websocket-requests.md).

```ts
function createWebSocketResponder<P, R, In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    request: (
      message: In
    ) => { id: number | string; method: string; params?: P; timeout?: number } | null | undefined;
    respond: (id: number | string, result: R) => Out;
    error: (id: number | string, error: unknown) => Out;
    cancel?: (message: In) => number | string | null | undefined;
    timeout?: number;
  }
): WebSocketResponder<P, R>;
```

Available from both `react-websocket` and `react-websocket/core`.

## Usage

```ts
import { createWebSocket, createWebSocketResponder } from 'react-websocket';

type In =
  | { type: 'call'; id: string; method: string; params?: { summary: string } }
  | { type: 'cancel'; id: string }
  | { type: 'token'; text: string };
type Out = { type: 'result'; id: number | string; result?: unknown; error?: string };

const agent = createWebSocket<In, Out>('wss://agent.example.com', { json: true });

export const tools = createWebSocketResponder(agent, {
  request: message => (message.type === 'call' ? message : undefined),
  respond: (id, result: unknown) => ({ type: 'result', id, result }),
  error: (id, error) => ({ type: 'result', id, error: String(error) }),
  cancel: message => (message.type === 'cancel' ? message.id : undefined)
});

// Answered in code.
tools.onRequest('get_selection', () => window.getSelection()?.toString() ?? '');
```

A request registered without a handler waits for a person. [`useAgentApproval`](./use-agent-approval.md) registers one while mounted and renders what's waiting. The guide is [AI agents](../guide/agents.md).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client requests arrive on. `In` and `Out` are taken from it |
| `options.request` | `(message: In) => { id, method, params?, timeout? } \| null \| undefined` | Recognize a request: its `id`, the `method` handlers are registered for, and the `params` they receive. `undefined` for any other message. Returning the message itself works when it has these fields. A `timeout` here, from the server, overrides `options.timeout` |
| `options.respond` | `(id, result: R) => Out` | Builds the reply. Annotate `result`: its type is what handlers return |
| `options.error` | `(id, error: unknown) => Out` | Builds the error reply. See [Errors](#errors) |
| `options.cancel` | `(message: In) => number \| string \| null \| undefined` | Optional. The id of a request the server withdrew, or `undefined` if the message isn't a cancellation |
| `options.timeout` | `number` | Optional. Time to answer a request, in ms. Default `Infinity`: the server times out its own requests, and people take a while to decide |

Handlers receive `params` typed as `request` returns them. If they're optional in your message type, handlers get `params | undefined`. Ids are typed `number | string`, so your `Out` type must accept both.

## Returns

`WebSocketResponder<P, R>`:

| Member | |
| --- | --- |
| `onRequest(method, handler?)` | Answer requests for `method` until the returned function is called. See below |
| `getSnapshot()` | Requests waiting for an answer from outside a handler, oldest first. Returns the same array until it changes |
| `subscribe(listener)` | Get notified when `getSnapshot()` changes. Returns an unsubscribe function |
| `dispose()` | Send an `AbortError` reply to every request in flight and stop listening. Only for responders created dynamically |
| `client` | The client |

### onRequest

```ts
onRequest(method: string, handler?: (params: P, request: IncomingRequest<P, R>) => R | PromiseLike<R>): () => void;
```

- **With a handler**, the request is answered in code. Return or resolve the result to reply with it. Throw or reject to send the `error` reply.
- **Without one**, the request waits in `getSnapshot()` until something calls `respond` or `reject` on it.
- **Several registrations** for one method form a stack. The newest one takes new requests, and unregistering it hands them back to the one before. So a dialog and a badge can both hold `'approve'`, and hot reloading doesn't break it.
- **Unregistering** never cancels requests that are already waiting or running. The function is safe to call more than once.

### IncomingRequest

```ts
interface IncomingRequest<P, R> {
  readonly id: number | string;
  readonly method: string;
  readonly params: P;
  /** Aborts when the answer is no longer wanted. */
  readonly signal: AbortSignal;
  /** Reply with `result`. `false` if it was already answered or is gone. */
  respond(result: R): boolean;
  /** Reply with the `error` reply. `false` if it was already answered or is gone. */
  reject(error: unknown): boolean;
}
```

Only the first answer counts. `signal` aborts when:

| When | `signal.reason` |
| --- | --- |
| The server cancels the request | `AbortError` |
| It times out | `TimeoutError`. The `error` reply is sent too |
| The connection it arrived on closes | `AbortError`. Nothing can be sent |
| `respond` or `reject` is called while its handler is still running | `AbortError` |
| `dispose()` | `AbortError`. The `error` reply is sent too |

Pass the signal on to `fetch`, a geolocation watch, or anything else the handler starts.

### Errors

`options.error` receives one of these. Each is a `DOMException`, except what a handler throws:

| `error` | When |
| --- | --- |
| What the handler threw or rejected with | The handler failed |
| What `request.reject(error)` was given | A person or your code rejected it |
| `NotFoundError` | Nothing is registered for the method |
| `TimeoutError` | `timeout` ran out |
| `AbortError` | `dispose()` was called |
| What building or encoding the reply threw | `respond` threw, or the result can't be serialized (e.g. a circular object) |

## Behavior

- **One answer per request.** While its connection lives, every request gets exactly one reply or error reply. A request the server sends again with an id that's still in flight is ignored.
- **Tied to its connection.** A request can only be answered on the connection it arrived on. When that connection closes, including through `reconnect()`, the request is dropped and its signal aborts, and a late result is discarded. Replies are sent with `volatile`, so they're never queued for the next connection, where the server wouldn't know the id. If your server keeps work across reconnects, have it send pending requests again when the client reconnects.
- **Doesn't connect.** It answers whenever the client is open, but doesn't hold the connection, even while a request waits for a person. `useAgentApproval` holds it while mounted.
- **Requests are messages.** Requests also reach `onMessage`, `lastMessage` and state stores. The same goes for cancellations.
- **One per client.** Two responders on one client both see every request, and one of them answers `NotFoundError`. Also make sure `request` doesn't match the replies a [`createWebSocketRequests`](./create-websocket-requests.md) manager on the same client waits for. With JSON-RPC, for example, a request has a `method` and a reply doesn't.
- **Requires TypeScript 5.4+** for the inferred message types (it uses `NoInfer`).
