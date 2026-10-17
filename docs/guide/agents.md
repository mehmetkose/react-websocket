---
title: 'AI agents over WebSockets in React'
description: 'Stream an AI agent''s answer over a WebSocket in React with a Stop button, approve its tool calls from your UI, or answer with data only the browser has.'
---

# AI agents

An agent running on your server sometimes needs the browser: to ask the user before it acts, or to use something only the browser has, like the page selection, the user's location or their logged-in session. Over a WebSocket, that's a request from the server that the client answers. This page shows how to answer them in code and from your UI, and how to stream the agent's answer token by token with a Stop button.

## The setup

The examples on this page share one client and one responder:

```ts
// agent.ts
import { createWebSocket, createWebSocketResponder } from 'react-websocket';

type AgentIn =
  | { type: 'token'; id: number; text: string }
  | { type: 'end'; id: number }
  | { type: 'failed'; id: number; error: string }
  | { type: 'call'; id: string; method: string; params: Record<string, string>; timeout?: number }
  | { type: 'cancel'; id: string };

type AgentOut =
  | { type: 'prompt'; id: number; text: string }
  | { type: 'stop'; id: number }
  | { type: 'result'; id: number | string; result?: unknown; error?: string };

export const agent = createWebSocket<AgentIn, AgentOut>('wss://agent.example.com', { json: true });

export const tools = createWebSocketResponder(agent, {
  request: message => (message.type === 'call' ? message : undefined),
  respond: (id, result: unknown) => ({ type: 'result', id, result }),
  error: (id, error) => ({ type: 'result', id, error: String(error) }),
  cancel: message => (message.type === 'cancel' ? message.id : undefined)
});
```

The server sends `{ type: 'call', id, method, params }` and waits for a `result` with the same `id`. `request` tells the responder which messages are requests. Here the message already has `id`, `method` and `params`, so it returns the message itself. `respond` and `error` build the reply. The library picks the id up from the request and makes sure every request gets exactly one reply.

## Tools that run in the browser

Register a handler for each method. Whatever it returns, or resolves to, is sent as the result. If it throws or rejects, the `error` reply is sent instead:

```ts
tools.onRequest('get_selection', () => window.getSelection()?.toString() ?? '');

// The user's session cookies go with the request, which the agent's server can't do.
tools.onRequest('read_order', async ({ orderId }, { signal }) => {
  const response = await fetch(`/api/orders/${orderId}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
});
```

`signal` aborts when the answer is no longer wanted: the server cancelled the request, it timed out, or the connection closed. Pass it to `fetch` and anything else that can stop early.

A request for a method with no registration gets the `error` reply with a `NotFoundError`, so the agent hears back right away instead of waiting.

`params` come from the server, and in the end from a model. Validate them before acting, and register only the tools you mean to expose. Ask the user before anything with side effects.

## Asking the user

Some requests need a person: "Refund $20 to order #1182?" Register the method without a handler and the request waits for your UI. [`useAgentApproval`](../api/use-agent-approval.md) does that while mounted and returns the waiting requests:

```tsx
import { useAgentApproval } from 'react-websocket';
import { tools } from './agent';

function Approval() {
  const [request] = useAgentApproval(tools, 'approve_tool');
  if (!request) return null;
  return (
    <dialog open>
      <p>{request.params.summary}</p>
      <button onClick={() => request.respond({ approved: true })}>Approve</button>
      <button onClick={() => request.respond({ approved: false })}>Deny</button>
    </dialog>
  );
}
```

Only the first answer counts. `respond` and `reject` return `false` if the request was already answered, cancelled or timed out, so you can tell the user they were too late. The dialog disappears on its own when the request goes away.

Outside React, `tools.onRequest('approve_tool')` registers the method, and `tools.getSnapshot()` and `tools.subscribe()` give you the same list.

### Tools that need a click

Browsers only open the file picker or read the clipboard in response to a user gesture, and a handler runs from a message event, not a click. Answer those requests from the UI too:

```tsx
function FileRequest() {
  const [request] = useAgentApproval(tools, 'pick_file');
  if (!request) return null;
  return (
    <label>
      {request.params.reason}
      <input
        type="file"
        onChange={async event => {
          const file = event.target.files?.[0];
          if (!file) return request.reject(new Error('No file chosen'));
          request.respond({ name: file.name, text: await file.text() });
        }}
      />
    </label>
  );
}
```

## Timeouts and cancellation

There's no timeout by default. The server already times out its own requests, and a person may take a while to decide. Set `timeout` on the responder for a default, or let the server send one per request. `request` passes it on here, because the message has a `timeout` field. When it runs out, the client sends the `error` reply with a `TimeoutError` and aborts `signal`.

The server can withdraw a request too, for example when the user stops the run. The `cancel` option recognizes those messages. The request's `signal` aborts, the dialog disappears, and nothing is sent back.

## Disconnects

A request is tied to the connection it arrived on. When that connection closes, the request is dropped. Its `signal` aborts, the dialog disappears, and a late result is thrown away. It isn't queued: on the next connection, the server wouldn't know the id.

If your server keeps runs alive across reconnects, have it send the pending requests again when the client comes back. A hello from `onOpen` is a good trigger. The [reconnecting guide](./reconnecting.md) covers the rest of the recovery.

## Keeping requests while the dialog is hidden

`useAgentApproval` registers the method only while it's mounted. Requests already waiting stay when it unmounts, so a remounted dialog shows them again. But a request that arrives while no dialog is mounted gets `NotFoundError`. That includes a dialog inside a hidden [`<Activity>`](./lifecycle.md#activity).

To keep every request waiting, whether or not a dialog is on screen, register the method once at module level:

```ts
tools.onRequest('approve_tool'); // requests wait until some dialog answers them
```

## Streaming the answer

The agent's answer arrives as many messages: tokens, then an end. [`createWebSocketRequests`](../api/create-websocket-requests.md#streaming-replies) with `done` turns them into one stream per prompt, and `cancel` tells the server to stop generating when nobody is reading anymore:

```ts
// agent.ts
export const ask = createWebSocketRequests(agent, {
  send: (text: string, id) => ({ type: 'prompt', id, text }),
  reply: message =>
    message.type === 'token' || message.type === 'end' || message.type === 'failed'
      ? message.id
      : undefined,
  error: message => (message.type === 'failed' ? new Error(message.error) : undefined),
  done: message => message.type === 'end',
  cancel: id => ({ type: 'stop', id }),
  // The time to wait for each token, including the first: allow for a model that thinks first.
  timeout: 60_000
});
```

The server answers `{ type: 'prompt', id, text }` with `{ type: 'token', id, text }` messages, then `{ type: 'end', id }`, or `{ type: 'failed', id, error }` if it fails. On `{ type: 'stop', id }` it stops generating.

In a component, [`useWebSocketStream`](../api/use-websocket-stream.md) folds the tokens into text:

```tsx
import { useWebSocketStream } from 'react-websocket';
import { ask } from './agent';

function Answer({ prompt }: { prompt: string }) {
  const answer = useWebSocketStream(ask, {
    initial: '',
    reduce: (text, reply) => (reply.type === 'token' ? text + reply.text : text),
    batch: 'frame' // one render per frame, however fast tokens arrive
  });
  return (
    <>
      <button onClick={() => answer.start(prompt)}>Ask</button>
      <button onClick={answer.abort} disabled={answer.status !== 'streaming'}>
        Stop
      </button>
      <p>{answer.value}</p>
      {answer.status === 'error' && <p role="alert">The answer stopped. Try again.</p>}
    </>
  );
}
```

Asking again replaces the answer and stops the one before. Stop, a new question and unmounting each send `stop`, so the server doesn't keep paying for tokens nobody reads. After Stop, the partial answer stays on screen.

Outside React, iterate over the stream. Leaving the loop early, with `break` or a throw, sends `stop` too:

```ts
let text = '';
for await (const reply of ask.stream('Summarize this page')) {
  if (reply.type === 'token') text += reply.text;
}
```

If the connection drops mid-answer, the stream throws after the tokens that arrived, and the hook reports `status: 'error'` with the partial answer. The server may still be generating: whether a new connection can pick the answer up again is up to your protocol.

## Things to watch for

- **One responder per client.** Two responders on one client both see every request, and one of them answers `NotFoundError`.
- **Requests aren't replies.** If you also use [`createWebSocketRequests`](../api/create-websocket-requests.md) on the same client, make sure `request` doesn't match its replies. With JSON-RPC, for example, a request has a `method` and a reply doesn't.
- **Requests are messages.** They also reach `onMessage`, `lastMessage` and state stores, so a state reducer that switches on `type` should ignore them.
- **The connection.** A mounted `useAgentApproval` keeps the connection open, like the other hooks. The responder alone doesn't.

The full API is in [`createWebSocketResponder`](../api/create-websocket-responder.md).
