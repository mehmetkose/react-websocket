# useWebSocketStream

Stream the replies to a request into a value, such as a model's tokens into its answer, from [`createWebSocketRequests`](./create-websocket-requests.md#streaming-replies).

```ts
function useWebSocketStream<Req, In, T>(
  rpc: WebSocketRequests<Req, In> | null | undefined,
  options: { initial: T; reduce: (value: T, reply: In) => T; batch?: 'frame' }
): UseWebSocketStreamResult<Req, T>;

function useWebSocketStream<Req, In>(
  rpc: WebSocketRequests<Req, In> | null | undefined,
  options?: { batch?: 'frame' }
): UseWebSocketStreamResult<Req, readonly In[]>;
```

## Usage

```tsx
import { useState } from 'react';
import { useWebSocketStream } from 'react-websocket';
import { ask } from './agent';

function Chat() {
  const [prompt, setPrompt] = useState('');
  const answer = useWebSocketStream(ask, {
    initial: '',
    reduce: (text, reply) => (reply.type === 'token' ? text + reply.text : text),
    batch: 'frame'
  });
  return (
    <>
      <input value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button onClick={() => answer.start({ prompt })}>Ask</button>
      <button onClick={answer.abort} disabled={answer.status !== 'streaming'}>
        Stop
      </button>
      <p>{answer.value}</p>
      {answer.status === 'error' && <p role="alert">Something went wrong. Try again.</p>}
    </>
  );
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `rpc` | `WebSocketRequests<Req, In> \| null \| undefined` | From [`createWebSocketRequests`](./create-websocket-requests.md), with `done` set. `null` holds nothing |
| `options.initial` | `T` | The value before the first reply. `start()` resets to it |
| `options.reduce` | `(value: T, reply: In) => T` | Folds a reply into the value. Return a new value instead of changing the old one. Without `initial` and `reduce`, the value is the array of replies |
| `options.batch` | `'frame'` | Optional. Re-render at most once per animation frame instead of once per reply |

## Returns

`UseWebSocketStreamResult<Req, T>`:

| Member | |
| --- | --- |
| `value` | The replies so far, folded with `reduce` |
| `status` | `'idle'` until `start()`, then `'streaming'`. It ends as `'done'` after the last reply, `'error'` when the stream fails, or `'aborted'` after `abort()` |
| `error` | Why the stream failed, while `status` is `'error'`: what `error` returned for an error reply, a `TimeoutError`, or a lost connection |
| `start(message, options?)` | Reset the value to `initial` and stream the replies to `message`. Takes the [request options](./create-websocket-requests.md#request-options) except `signal`. Stable identity |
| `abort()` | Stop the stream. The value keeps what arrived. Stable identity |

## Behavior

- **One stream at a time.** `start()` aborts the stream before it, and replies to that one are ignored from then on. So a new question replaces the answer to the last one.
- **Cancels what it leaves.** `abort()`, a new `start()`, unmounting and passing a different `rpc` all stop the running stream, which sends the manager's `cancel` so the server stops generating.
- **Keeps partial answers.** After `abort()` or a failure, `value` keeps the replies that arrived. Only `start()` resets it.
- **Renders.** It re-renders once per reply. With `batch: 'frame'`, it re-renders at most once per animation frame, which keeps fast token streams smooth. The end of the stream renders right away. Browsers pause frames in background tabs; the value catches up when the tab is visible again.
- **Idle timeout.** The manager's `timeout` is the time to wait for each reply, including the first. Pass a longer one to `start()` for models that think before answering.
- **Holds the connection** while mounted, like the other hooks. A running stream also holds it.
- **StrictMode-safe.** If an effect calls `start()`, StrictMode's double mount cancels the first stream and leaves one running. The first request still reaches the server, followed by its cancel.
- **Errors in `reduce`** end the stream with status `'error'`, and send `cancel`.
- **Server rendering.** On the server, `value` is `initial` and `status` is `'idle'`.
