# Testing

This page shows how to test components that use react-websocket without a real server, using a fake `WebSocket` you control from the test.

## Inject a fake WebSocket

Every client and URL hook accepts a `WebSocket` option: the constructor to use instead of the global one.

```ts
useWebSocket(url, { WebSocket: MockWebSocket });
createWebSocket(url, { WebSocket: MockWebSocket });
```

In app code, you usually don't want test-only options. Two common patterns:

- Create module-level clients in one file and mock that module in tests (`vi.mock('./sockets')`).
- Read the implementation from a parameter or context that tests can override.

## A copy-paste mock

This fake records what was sent and lets the test play the server's part. It's the same mock this library uses for its own tests.

```ts
// test/mock-websocket.ts
type Handler = ((event: any) => void) | null;

/** Controllable stand-in for the browser WebSocket. */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  static get last(): MockWebSocket {
    const socket = MockWebSocket.instances.at(-1);
    if (!socket) throw new Error('no socket was created');
    return socket;
  }

  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;

  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    MockWebSocket.instances.push(this);
  }

  send(data: unknown) {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 2;
  }

  // The server's side.

  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Finish a close, whether started by the client or the server. */
  finishClose(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

export const MockImpl = MockWebSocket as unknown as typeof WebSocket;
```

The client only uses `send`, `close`, `readyState`, `binaryType` and the four `on*` handler properties, so the mock doesn't need anything else.

## A component test

With [Vitest](https://vitest.dev) and [Testing Library](https://testing-library.com/docs/react-testing-library/intro/). Wrap anything that makes the client update React state in `act()`:

```tsx
// test/chat.test.tsx
import { act, render, screen } from '@testing-library/react';
import { useWebSocket } from 'react-websocket';
import { MockImpl, MockWebSocket } from './mock-websocket';

function Chat({ url }: { url: string }) {
  const { status, lastMessage, send } = useWebSocket<{ text: string }, { text: string }>(url, {
    json: true,
    WebSocket: MockImpl
  });
  return (
    <>
      <p>{status}</p>
      <p>{lastMessage?.text ?? 'no messages'}</p>
      <button onClick={() => send({ text: 'hi' })}>Send</button>
    </>
  );
}

beforeEach(() => MockWebSocket.reset());

it('connects, receives and sends', () => {
  render(<Chat url="ws://test/chat-1" />);
  expect(screen.getByText('connecting')).toBeTruthy();

  act(() => MockWebSocket.last.open());
  expect(screen.getByText('open')).toBeTruthy();

  act(() => MockWebSocket.last.receive(JSON.stringify({ text: 'hello' })));
  expect(screen.getByText('hello')).toBeTruthy();

  act(() => screen.getByText('Send').click());
  expect(MockWebSocket.last.sent).toEqual([JSON.stringify({ text: 'hi' })]);
});

it('shows reconnecting when the server drops', () => {
  render(<Chat url="ws://test/chat-2" />);
  act(() => MockWebSocket.last.open());
  act(() => MockWebSocket.last.finishClose(1006));
  expect(screen.getByText('reconnecting')).toBeTruthy();
});
```

## Fake timers for reconnects

Reconnect delays, heartbeats and the deferred close after unmount all use `setTimeout`/`setInterval`, so fake timers make them deterministic. Set `jitter: 0` to get exact delays:

```ts
import { createWebSocket } from 'react-websocket/core';
import { MockImpl, MockWebSocket } from './mock-websocket';

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('backs off exponentially', () => {
  const client = createWebSocket('ws://test/x', {
    WebSocket: MockImpl,
    reconnect: { minDelay: 1000, factor: 2, jitter: 0 }
  });
  client.connect();
  MockWebSocket.last.finishClose(); // first attempt fails

  vi.advanceTimersByTime(999);
  expect(MockWebSocket.instances).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(MockWebSocket.instances).toHaveLength(2);

  MockWebSocket.last.finishClose(); // second attempt fails: next delay is 2000 ms
  vi.advanceTimersByTime(2000);
  expect(MockWebSocket.instances).toHaveLength(3);
});
```

::: tip Suspense with fake timers
React schedules Suspense retries on its own timers. For tests that use `use(client.ready)`, switch to real timers (`vi.useRealTimers()`) and wait with `await screen.findBy…`.
:::

## Isolating tests

Hooks given the same URL share one client, and a client is forgotten only a tick after its last component unmounts. Under fake timers that tick may never run, so a client, and its `lastMessage`, can leak into the next test. Either:

- give each test a unique URL (`ws://test/1`, `ws://test/2`, …), or
- create a module-level client per test with `createWebSocket` and pass it to the hooks, or
- run pending timers after each test (`vi.runOnlyPendingTimers()`).

## The mock-socket library

If you prefer a mock server API, [mock-socket](https://github.com/thoov/mock-socket) works through the same option:

```ts
import { Server, WebSocket as MockSocket } from 'mock-socket';

const server = new Server('ws://test/live');
server.on('connection', socket => socket.send('hello'));

useWebSocket('ws://test/live', { WebSocket: MockSocket as unknown as typeof WebSocket });
```

## Server rendering

During a server render (no `window`) the hooks render `status: 'idle'` and never open a socket, so you can test SSR output with `renderToString` in a Node environment:

```tsx
// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { useWebSocket } from 'react-websocket';

function Live() {
  const { status } = useWebSocket('wss://api.example.com/live');
  return <p>{status}</p>;
}

it('renders idle on the server', () => {
  expect(renderToString(<Live />)).toBe('<p>idle</p>');
});
```

On the server, `client.ready` rejects. See [Server rendering](./ssr.md).
