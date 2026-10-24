---
description: 'react-websocket/ag-ui: createAgUiAgent, useAgUiAgent, applyAgUiEvent and applyPatch for AG-UI agents over a WebSocket.'
---

# react-websocket/ag-ui

Run [AG-UI](https://docs.ag-ui.com) agents over a WebSocket. The guide is [AG-UI over WebSockets](../guide/ag-ui.md).

The entry has no React dependency. [`useAgUiAgent`](#useaguiagent) comes from `react-websocket`. `createAgUiAgent` is about 3.5 kB min+gzip, including the [runs](./create-websocket-runs.md) and [feeds](./create-websocket-feeds.md) it uses, which it shares with the other entries.

## createAgUiAgent

```ts
function createAgUiAgent<S, In, Out>(
  client: WebSocketClient<In, Out>,
  options?: {
    threadId?: string;
    state?: S;
    name?: string;
    run?: (input: RunAgentInput, runId: string) => Out;
    resume?: (runId: string, after: number | undefined) => Out;
    cancel?: (runId: string) => Out;
    resync?: (runId: string) => Out;
    event?: (message: In) => { runId: string; offset: number; event: AgUiEvent } | null | undefined;
    policy?: 'keep' | 'cancel';
    storage?: RunStorage | null;
  }
): AgUiAgent<S>;
```

| Option | | Default |
| --- | --- | --- |
| `threadId` | The thread's id, sent in every `RunAgentInput` | A random id |
| `state` | The shared state before the first `STATE_SNAPSHOT`, sent with the first run | `undefined` |
| `name` | Names where streaming runs are remembered across reloads | `'ag-ui'` |
| `run` | The message that starts a run | `{ type: 'run', runId, input }` |
| `resume` | The message that asks for a run's events after `after` | `{ type: 'resume', runId, after }` |
| `cancel` | The message that stops a run | `{ type: 'cancel', runId }` |
| `resync` | The message that asks for a `STATE_SNAPSHOT`, sent once each time a `STATE_DELTA` fails, until a snapshot arrives | Not sent |
| `event` | Recognize a run's event in a server message | Messages shaped `{ runId, offset, event }` |
| `policy` | What happens to a run when its connection drops: `'keep'` resumes it, `'cancel'` stops it | `'keep'` |
| `storage` | Where streaming runs are remembered, or `null` | `sessionStorage` |

Returns an `AgUiAgent<S>`:

| Member | |
| --- | --- |
| `run(input?, options?)` | Start a run with the thread so far plus `input.messages`. `input` also takes `tools`, `context` and `forwardedProps`; `options.policy` overrides the default. A streaming run is aborted first. Returns the run id |
| `abort()` | Stop the streaming run |
| `reset()` | Forget the thread, e.g. on logout or when another user signs in: its runs (with [`runs.clear()`](./create-websocket-runs.md), which sends nothing), messages and state. The next run starts over from `state`, with a new thread id unless `threadId` was given. `abort()` a streaming run first to stop it on the server |
| `getSnapshot()` | The thread, an [`AgUiThread<S>`](#aguithread). The same object until it changes |
| `subscribe(listener)` | Get notified when the thread changes. Compatible with `useSyncExternalStore` |
| `runs` | The [runs](./create-websocket-runs.md) underneath |
| `client` | The client |
| `dispose()` | Stop following runs and release the connection |

### AgUiThread

```ts
interface AgUiThread<S> {
  readonly messages: readonly AgUiMessage[];
  readonly state: S;
  readonly status: 'idle' | 'running' | 'finished' | 'error' | 'aborted';
  readonly step?: string;
  readonly error?: { message: string; code?: string };
  readonly result?: unknown;
  readonly stale: boolean; // a STATE_DELTA failed; waiting for a snapshot
}
```

`AgUiMessage` has AG-UI's message fields: `id`, `role`, `content`, and `toolCalls` (each `{ id, type: 'function', function: { name, arguments } }`) for assistant messages, `toolCallId` for tool messages, and `activityType` for activity messages.

## useAgUiAgent

```ts
function useAgUiAgent<S>(agent: AgUiAgent<S>): AgUiThread<S>;
```

From `react-websocket`. The agent's thread, re-rendering on every event.

## applyAgUiEvent

```ts
function applyAgUiEvent<S>(thread: AgUiThread<S>, event: AgUiEvent): AgUiThread<S>;
```

Fold one AG-UI event into a thread without changing it. `createAgUiAgent` uses it to reduce each run. Use it yourself to reduce AG-UI events from another source, or wrap it to handle `CUSTOM` events:

```ts
const reduce = (thread: AgUiThread<Plan>, event: AgUiEvent): AgUiThread<Plan> =>
  event.type === 'CUSTOM' && event.name === 'reset_plan'
    ? { ...thread, state: { tasks: [] } }
    : applyAgUiEvent(thread, event);
```

A `STATE_DELTA` that can't be applied returns the thread with `stale: true` and the state unchanged, and later deltas are skipped until a `STATE_SNAPSHOT`.

## applyPatch

```ts
function applyPatch<T>(document: T, operations: readonly JsonPatchOperation[]): T;
```

Apply a [JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) (`add`, `remove`, `replace`, `move`, `copy`, `test`) without changing `document`: what changes is copied, and the rest is shared. Throws if an operation can't be applied, such as a missing path, an index out of range (an array's `length` isn't one of its members), a pointer that doesn't start with `/`, or a failed `test`, and `document` stays as it was. A key such as `__proto__` is added as a property of its own, as `JSON.parse` would.
