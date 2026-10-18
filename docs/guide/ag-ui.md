---
title: 'AG-UI agents over WebSockets'
description: 'Run AG-UI agents over a WebSocket in React: messages, tool calls and shared state from AG-UI events, JSON Patch state deltas with a snapshot fallback, and runs that resume after a reconnect or reload.'
---

# AG-UI over WebSockets

[AG-UI](https://docs.ag-ui.com) is an open protocol for agents and the apps that show them: a run streams standard events for text, tool calls, steps, and a state shared between the agent and the UI. The protocol doesn't depend on a transport, but its standard client speaks HTTP. `react-websocket/ag-ui` runs it over a WebSocket, with what WebSockets add: one connection for every run, runs that resume after a reconnect or a reload, and a way back from a state delta that went wrong.

```ts
// agent.ts
import { createWebSocket } from 'react-websocket';
import { createAgUiAgent } from 'react-websocket/ag-ui';

export const agent = createAgUiAgent<Plan>(createWebSocket('wss://agent.example.com', { json: true }), {
  state: { tasks: [] },
  resync: runId => ({ type: 'resync', runId })
});
```

```tsx
import { useAgUiAgent } from 'react-websocket';
import { agent } from './agent';

function Chat() {
  const thread = useAgUiAgent(agent);
  return (
    <>
      {thread.messages.map(message => (
        <Message key={message.id} message={message} />
      ))}
      <TaskList tasks={thread.state.tasks} />
      <button onClick={() => agent.run({ messages: [userMessage(input)] })}>Send</button>
      {thread.status === 'running' && <button onClick={agent.abort}>Stop</button>}
    </>
  );
}
```

## The thread

`useAgUiAgent(agent)` returns the thread: what the agent's events add up to.

| Field | From |
| --- | --- |
| `messages` | `TEXT_MESSAGE_*` and their chunks, `TOOL_CALL_*` on their parent message, `TOOL_CALL_RESULT` as `tool` messages, `REASONING_MESSAGE_*` as `reasoning` messages, `ACTIVITY_SNAPSHOT` and `ACTIVITY_DELTA`, and `MESSAGES_SNAPSHOT` |
| `state` | `STATE_SNAPSHOT` and `STATE_DELTA` (JSON Patch) |
| `status` | `'running'` from `RUN_STARTED`, `'finished'` after `RUN_FINISHED`, `'error'` after `RUN_ERROR`, `'aborted'` after Stop |
| `step` | The step between `STEP_STARTED` and `STEP_FINISHED` |
| `error`, `result` | From `RUN_ERROR` and `RUN_FINISHED` |
| `stale` | A state delta couldn't be applied; see below |

Tool call arguments arrive as JSON text in pieces, so `toolCalls[n].function.arguments` grows until `TOOL_CALL_END`: parse it then. Events the adapter doesn't fold, such as `CUSTOM` and `RAW`, leave the thread as it is. To handle them, listen to the client's messages, or wrap the exported [`applyAgUiEvent`](../api/ag-ui.md#applyaguievent) in your own reducer.

`agent.run(input)` starts a run with the thread so far, plus `input.messages`, which show up at once. It sends AG-UI's `RunAgentInput`: the thread id, a new run id, the `state`, the `messages`, and your `tools`, `context` and `forwardedProps`. A run that's still streaming is stopped first.

## When a state delta fails

`STATE_DELTA` carries [JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) operations against the state the client is supposed to have. If the client's state differs, because a delta was lost or the server's view drifted, a patch can fail: a path that doesn't exist, a failed `test`. Applying later deltas to the wrong base would only make it worse.

So the adapter keeps the last good state, marks the thread `stale`, and skips deltas until a `STATE_SNAPSHOT` arrives. With the `resync` option, it asks the server for one right away, and again each time a later delta fails after a snapshot; answer it with a snapshot before the run finishes. A run that finishes stale doesn't make the next one stale: that run starts from the last good state, which it sends to the server, so its deltas apply. Patches never change the state in place: what changes is copied, and the rest is shared, so React sees new objects only where something changed.

## Runs that survive reconnects

Each run streams through [`createWebSocketRuns`](../api/create-websocket-runs.md), so it behaves like the [resumable runs](./agents.md#resumable-runs) in the agents guide:

- After a reconnect, the run resumes after the last event received, and events sent twice are dropped.
- After a reload, the runs that were streaming are followed again from their first event, which rebuilds their part of the thread. Send a `MESSAGES_SNAPSHOT` and a `STATE_SNAPSHOT` at the start of each run, and a reloaded page gets the whole thread back.
- `policy: 'cancel'` stops a run when its connection drops, for answers nobody may be waiting for.

## The wire format

AG-UI doesn't define messages for WebSockets, and one socket can carry several runs, so each event needs its run and its place. The defaults are:

| Direction | Message |
| --- | --- |
| Client → server | `{ type: 'run', runId, input }` with `input` a `RunAgentInput` |
| Client → server | `{ type: 'resume', runId, after }`: send the run's events after offset `after`, or all of them without it |
| Client → server | `{ type: 'cancel', runId }` |
| Client → server | `{ type: 'resync', runId }`, with the `resync` option: send a `STATE_SNAPSHOT` |
| Server → client | `{ runId, offset, event }`: an AG-UI event, with `offset` counting the run's events from 1 |

The server keeps each run's events for a while, starts a run only once per `runId` (the client sends `run` again after a reconnect until the first event arrives), and ends every run with `RUN_FINISHED` or `RUN_ERROR`. The `run`, `resume`, `cancel`, `resync` and `event` options each replace one of these formats, if your server already speaks another.

## See also

- [`react-websocket/ag-ui` API](../api/ag-ui.md)
- [AI agents](./agents.md): browser tools, approvals, streaming and resumable runs
- [AG-UI events](https://docs.ag-ui.com/concepts/events)
