---
description: 'createWebSocketRuns: streaming runs, such as an AI agent''s answer, that survive reconnects and page reloads, with resume by offset and a keep or cancel policy.'
---

# createWebSocketRuns

Stream runs, such as an AI agent's answer, that survive reconnects and page reloads. Each run has an id and numbered events. After a reconnect the client resumes after the last event it received, and after a reload it follows the run again from the beginning.

```ts
function createWebSocketRuns<Req, T, In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    name: string;
    start: (request: Req, runId: string) => Out;
    resume: (runId: string, after: number | undefined) => Out;
    cancel?: (runId: string) => Out;
    event: (message: In) => { runId: string; offset: number } | null | undefined;
    done?: (message: In) => boolean;
    error?: (message: In) => unknown;
    initial: T;
    reduce: (value: T, message: In) => T;
    policy?: 'keep' | 'cancel';
    storage?: RunStorage | null;
  }
): WebSocketRuns<Req, T>;
```

Available from both `react-websocket` and `react-websocket/core`. Render a run with [`useAgentRun`](./use-agent-run.md). The guide is [Resumable runs](../guide/agents.md#resumable-runs).

## Usage

```ts
import { createWebSocket, createWebSocketRuns } from 'react-websocket';

type AgentIn =
  | { type: 'token'; runId: string; offset: number; text: string }
  | { type: 'done'; runId: string; offset: number; text: string }
  | { type: 'failed'; runId: string; offset: number; error: string };
type AgentOut =
  | { type: 'run'; runId: string; prompt: string }
  | { type: 'resume'; runId: string; after?: number }
  | { type: 'cancel'; runId: string };

const agent = createWebSocket<AgentIn, AgentOut>('wss://agent.example.com', { json: true });

export const runs = createWebSocketRuns(agent, {
  name: 'chat',
  start: (prompt: string, runId) => ({ type: 'run', runId, prompt }),
  resume: (runId, after) => ({ type: 'resume', runId, after }),
  cancel: runId => ({ type: 'cancel', runId }),
  event: message => message,
  done: message => message.type === 'done',
  error: message => (message.type === 'failed' ? message.error : undefined),
  initial: '',
  reduce: (text, message) => (message.type === 'failed' ? text : text + message.text)
});

const runId = runs.start('Summarize this thread');
```

Annotate `start`'s `request` parameter: that's what `runs.start()` accepts.

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client the runs stream on. `In` and `Out` are taken from it |
| `options.name` | `string` | Names the runs' entry in `storage`: `react-websocket-runs:<name>` |
| `options.start` | `(request: Req, runId: string) => Out` | The message that starts a run. Sent again on a new connection until the run's first event arrives, so the server should start a run only once per id |
| `options.resume` | `(runId: string, after: number \| undefined) => Out` | The message that asks for a run's events after `after`, or from the beginning when it's `undefined` (after a reload, or for `attach()`) |
| `options.cancel` | `(runId: string) => Out` | Optional. The message that stops a run, for `abort()` and the `cancel` policy |
| `options.event` | `(message: In) => { runId, offset } \| null \| undefined` | Recognize a run's event, including its last one and error events. `offset` is one more than the event before it. `undefined` for any other message |
| `options.done` | `(message: In) => boolean` | Optional. Whether an event is the run's last. It's reduced, then the run is `'done'` |
| `options.error` | `(message: In) => unknown` | Optional. Return the error an event ends the run with, or `undefined`. That event isn't reduced |
| `options.initial` | `T` | A run's value before its first event |
| `options.reduce` | `(value: T, message: In) => T` | Fold an event into a run's value. Pure |
| `options.policy` | `'keep' \| 'cancel'` | Optional. The default policy for runs: what happens when their connection drops. Default `'keep'` |
| `options.storage` | `RunStorage \| null` | Optional. Where streaming runs are remembered: anything with `getItem`, `setItem` and `removeItem`. Default `sessionStorage`. `null` remembers nothing |

## Returns

A `WebSocketRuns<Req, T>`:

| Member | |
| --- | --- |
| `start(request, options?)` | Start a run and return its id. `options.runId` sets the id, `options.policy` overrides the default policy, and `options.initial` the initial value. An id it already knows, streaming or ended, starts nothing, as the server starts a run only once per id: `delete()` it first to use it again |
| `attach(runId, options?)` | Follow a run started elsewhere, from its first event. Does nothing for a run it already knows. Takes `policy` and `initial` too |
| `abort(runId)` | Stop a streaming run: send `cancel`, and make it `'aborted'` |
| `get(runId)` | The run's [`AgentRun<T>`](#agentrun), or `undefined`. The same object until it changes |
| `list()` | Every run it knows, oldest first, including the ones remembered from before a reload. A new array on every change |
| `subscribe(listener)` | Get notified when a run changes. Compatible with `useSyncExternalStore` |
| `delete(runId)` | Forget a run, aborting it first if it's streaming |
| `client` | The client |
| `dispose()` | Stop following runs and release the connection. Remembered runs stay remembered |

### AgentRun

```ts
interface AgentRun<T> {
  readonly runId: string;
  readonly status: 'streaming' | 'done' | 'error' | 'aborted';
  readonly value: T; // reduced from the events so far
  readonly error: unknown; // when status is 'error'
}
```

## Behavior

- **Reconnects.** A streaming run sends `resume(runId, after)` on every new connection, with the offset of the last event received. Events at or below it are dropped, and an event after a gap asks for the missing ones, as [feeds](./create-websocket-feeds.md) do: each run is a topic of its own.
- **Reloads.** Streaming runs are remembered in `storage` with their policy, and forgotten once they end. A new page follows the remembered `keep` runs from their first event, and sends `cancel` for the `cancel` ones, 200 ms later, unless another page says it still follows them. A duplicated tab, or one opened with `window.open`, starts with a copy of `sessionStorage`, and so with the runs of the page that is still streaming them.
- **Policies.** When the connection drops, `cancel` runs are aborted at once, and `cancel` goes out first thing on the next connection, holding the connection open until it does. It doesn't go through the send queue, so it goes out with `queue: false` too. `keep` runs carry on. [`migrate()`](../guide/reconnecting.md#deploys-without-reconnect-storms) keeps the status `open`, so it never aborts a run.
- **The connection.** While runs are streaming, they hold the client's connection, as a mounted hook would.
- **Values stay.** A run that ended keeps its final `value` until `delete()`.
