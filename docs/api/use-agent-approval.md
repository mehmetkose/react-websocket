# useAgentApproval

Render the requests a person answers, such as an agent asking to run a tool, from [`createWebSocketResponder`](./create-websocket-responder.md).

```ts
function useAgentApproval<P, R>(
  responder: WebSocketResponder<P, R> | null | undefined,
  method: string | null | undefined
): readonly IncomingRequest<P, R>[];
```

## Usage

```tsx
import { useAgentApproval } from 'react-websocket';
import { tools } from './agent';

function Approval() {
  const [request] = useAgentApproval(tools, 'approve_tool');
  if (!request) return null;
  return (
    <dialog open>
      <p>{request.params?.summary}</p>
      <button onClick={() => request.respond({ approved: true })}>Approve</button>
      <button onClick={() => request.respond({ approved: false })}>Deny</button>
    </dialog>
  );
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `responder` | `WebSocketResponder<P, R> \| null \| undefined` | From [`createWebSocketResponder`](./create-websocket-responder.md) |
| `method` | `string \| null \| undefined` | The method a person answers. `null` holds nothing |

## Returns

The waiting requests for `method`, oldest first, as [`IncomingRequest`](./create-websocket-responder.md#incomingrequest) objects. Call `respond(result)` or `reject(error)` on one to answer it. Both return `false` if it was already answered or is gone, for example when two tabs show the same dialog.

## Behavior

- **Registers the method.** While mounted, it registers `method` on the responder without a handler, so new requests wait for the UI instead of getting a `NotFoundError` reply. A handler registered later with `onRequest` takes over new requests until it's unregistered.
- **Renders.** It re-renders when a request for `method` arrives or goes away: when it's answered, times out, is cancelled by the server, or its connection closes.
- **Survives remounts.** Requests stay waiting after the component unmounts, so a remounted dialog shows them again. Requests that arrive while nothing is mounted get `NotFoundError`. If the dialog sits inside an [`<Activity>`](../guide/lifecycle.md#activity) that can be hidden, call it in a parent outside the boundary so requests keep waiting while it's hidden.
- **StrictMode-safe.** StrictMode's double mount registers once.
- **Holds the connection** while mounted, like the other hooks.
- **Server rendering.** On the server and during hydration, it returns an empty array.
- **Not only for approvals.** Browser APIs that need a click, such as the file picker or reading the clipboard, can't run in a handler, which runs from a message event. Answer those requests from a button here too.
