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

If the connection drops mid-answer, the stream throws after the tokens that arrived, and the hook reports `status: 'error'` with the partial answer. The server may still be generating, and its tokens are paid for. To pick the answer up again, make it a resumable run.

## Resumable runs

A refresh, a switch from Wi-Fi to cellular, or a laptop that sleeps drops a streaming answer halfway. With [`createWebSocketRuns`](../api/create-websocket-runs.md), the answer survives: each run has an id, its events are numbered, and the client asks for what it missed.

```ts
// runs.ts
import { createWebSocketRuns } from 'react-websocket';
import { agent } from './agent';

export const runs = createWebSocketRuns(agent, {
  name: 'chat',
  start: (prompt: string, runId) => ({ type: 'run', runId, prompt }),
  resume: (runId, after) => ({ type: 'resume', runId, after }),
  cancel: runId => ({ type: 'cancel', runId }),
  event: message => (message.type === 'token' || message.type === 'done' ? message : undefined),
  done: message => message.type === 'done',
  initial: '',
  reduce: (text, message) => text + message.text
});
```

[`useAgentRun`](../api/use-agent-run.md) renders one:

```tsx
import { useState } from 'react';
import { useAgentRun } from 'react-websocket';
import { runs } from './runs';

function Chat() {
  // After a reload, pick up the run that was streaming.
  const [runId, setRunId] = useState(() => runs.list().at(-1)?.runId ?? null);
  const run = useAgentRun(runs, runId);
  return (
    <>
      <button onClick={() => setRunId(runs.start(prompt))}>Ask</button>
      <button onClick={() => runId && runs.abort(runId)} disabled={run?.status !== 'streaming'}>
        Stop
      </button>
      <p>{run?.value}</p>
    </>
  );
}
```

What happens:

- **`start(prompt)`** makes a run id, sends `start(prompt, runId)` as soon as the socket is open, and folds each event into the run's `value` with `reduce`.
- **The connection drops.** On the next one, the run sends `resume(runId, after)` with the offset of the last event received, so the server sends only what was missed. Anything it sends twice is dropped. Until the first event arrives, it sends `start` again instead, so the server should start a run only once per id.
- **The page reloads.** Streaming runs are remembered in `sessionStorage`. The new page follows them again from their first event (`resume(runId, undefined)`), so `reduce` rebuilds the answer, and `runs.list()` finds them.
- **It ends** with `done`, with an `error` event, or with `abort(runId)`, which sends `cancel`. Then it's forgotten from storage, and its final `value` stays.

### Background agents or a chat answer

Each run has a policy for when its connection drops. `keep`, the default, resumes it, for agents that work in the background. `cancel` aborts it and sends `cancel` first thing on the next connection, for a chat answer nobody may be waiting for, so the server stops spending:

```ts
const runId = runs.start(prompt, { policy: 'cancel' });
```

The client can only cancel once it's connected again, so have the server cancel on its own too: send the policy with the start message, and stop a `cancel` run when its socket closes.

### The server's side

The server keeps each run's events while it streams, and a while after, each with an `offset` that counts from 1:

- On `start` with a new id, it starts the run. On `start` with an id it knows, it carries on as for `resume`.
- On `resume` with `after`, it sends the events after that offset, then follows the run live on this connection. Without `after`, it sends them all.
- For an id it doesn't know, it sends an error event, which ends the run on the client.
- An error event carries the next offset, like any other event.

To follow a run from somewhere else, such as one listed in a chat history from the server, pass its id to `useAgentRun`, or call `runs.attach(runId)`: it's followed from its first event.

## Dashboards of many runs

A page that watches dozens of agents at once can't afford every token of every run: most cards are off screen, and the browser would spend its time on text nobody reads. Stream full tokens only for the runs on screen, and status alone for the rest.

Give each run two [feed](./topics.md#numbered-feeds) topics, one with every token and one with its status, and pick one with [`useInView`](../api/use-in-view.md). [`useWebSocketTopic`](../api/use-websocket-topic.md) switches subscriptions when the topic changes:

```tsx
import { useRef } from 'react';
import { useInView, useWebSocketState, useWebSocketTopic } from 'react-websocket';
import { feeds, runs } from './live';

function RunCard({ id }: { id: string }) {
  const ref = useRef<HTMLElement>(null);
  const onScreen = useInView(ref, { rootMargin: '200px' });
  useWebSocketTopic(feeds, onScreen ? `run:${id}:tokens` : `run:${id}:status`);
  const run = useWebSocketState(runs, all => all[id]);
  return (
    <article ref={ref}>
      <h3>{run?.title}</h3>
      <p>{run?.status}</p>
      {onScreen && <pre>{run?.text}</pre>}
    </article>
  );
}
```

- A card that scrolls into view subscribes to its tokens. With feeds, the server answers a new subscription with a snapshot of the text so far, then streams from there, so the card shows the whole answer at once.
- A card that scrolls out unsubscribes from its tokens a tick later, and gets status messages only.
- `rootMargin` starts streaming a little before a card is visible, so it's already full when it scrolls in.

In Chrome, 30 runs producing 10 tokens a second each in a panel showing 4 cards: 900 messages in 3 seconds with every card subscribed to its tokens, 198 with `useInView` (120 tokens for the 4 visible cards, 78 status messages for all 30).

### A live cost meter

The status topic can carry usage too. Add up what each run has spent, and stop a run that goes over a budget on the client:

```ts
import { createWebSocketState } from 'react-websocket';

export const spend = createWebSocketState(feeds, {
  initialState: {} as Record<string, number>,
  reduce: (totals, message) =>
    message.type === 'usage' ? { ...totals, [message.runId]: message.costUsd } : totals
});

const budgetUsd = 0.5;
spend.subscribe(() => {
  for (const [runId, cost] of Object.entries(spend.getState())) {
    if (cost > budgetUsd) agentRuns.abort(runId); // sends `cancel`
  }
});
```

Render the total with `useWebSocketState(spend, totals => Object.values(totals).reduce((a, b) => a + b, 0))`. A client-side budget is a convenience, not a limit: enforce real limits on the server.

## Voice

Voice agents stream audio both ways, and the hard part is the interruption: stop playback, cancel generation, and tell the server how much the user actually heard. See [Voice agents and interruptions](./voice.md).

## Things to watch for

- **One responder per client.** Two responders on one client both see every request, and one of them answers `NotFoundError`.
- **Requests aren't replies.** If you also use [`createWebSocketRequests`](../api/create-websocket-requests.md) on the same client, make sure `request` doesn't match its replies. With JSON-RPC, for example, a request has a `method` and a reply doesn't.
- **Requests are messages.** They also reach `onMessage`, `lastMessage` and state stores, so a state reducer that switches on `type` should ignore them.
- **The connection.** A mounted `useAgentApproval` keeps the connection open, like the other hooks. The responder alone doesn't.

The full API is in [`createWebSocketResponder`](../api/create-websocket-responder.md). To see it in a whole app, with a server that calls Claude, see [Build an AI chatbot](../recipes/ai-chatbot.md). For jobs that run for minutes, see [Build an AI image and video generator](../recipes/ai-media-generator.md).
