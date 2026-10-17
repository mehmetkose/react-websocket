---
description: 'useAgentRun: render a resumable run from createWebSocketRuns, such as an AI answer that keeps streaming after a reconnect or a page reload.'
---

# useAgentRun

Render a run from [`createWebSocketRuns`](./create-websocket-runs.md): its value so far and its status. Re-renders on every event.

```ts
function useAgentRun<T>(
  runs: WebSocketRuns<any, T> | null | undefined,
  runId: string | null | undefined
): AgentRun<T> | undefined;
```

## Usage

```tsx
import { useState } from 'react';
import { useAgentRun } from 'react-websocket';
import { runs } from './runs';

function Chat({ prompt }: { prompt: string }) {
  // After a reload, pick up the run that was streaming.
  const [runId, setRunId] = useState(() => runs.list().at(-1)?.runId ?? null);
  const run = useAgentRun(runs, runId);
  return (
    <>
      <button onClick={() => setRunId(runs.start(prompt))}>Ask</button>
      {run?.status === 'streaming' && <button onClick={() => runs.abort(run.runId)}>Stop</button>}
      <p>{run?.value}</p>
      {run?.status === 'error' && <p role="alert">The answer failed.</p>}
    </>
  );
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `runs` | `WebSocketRuns<any, T> \| null \| undefined` | From [`createWebSocketRuns`](./create-websocket-runs.md) |
| `runId` | `string \| null \| undefined` | The run to render. `null` or `undefined` renders nothing |

## Returns

The run's [`AgentRun<T>`](./create-websocket-runs.md#agentrun): `runId`, `status` (`'streaming'`, `'done'`, `'error'` or `'aborted'`), `value` and `error`. `undefined` for a `null` id, for a run the manager doesn't know yet, and on the server.

## Behavior

- **Attaching.** A run the manager doesn't know, such as one from a chat history, is attached once mounted and followed from its first event, so `value` builds up from the beginning.
- **Connection.** The manager holds the connection while runs are streaming; the hook itself doesn't.
- **Re-renders.** Once per event. For very fast streams, reduce several tokens per event on the server, or render the value with `useDeferredValue`.
