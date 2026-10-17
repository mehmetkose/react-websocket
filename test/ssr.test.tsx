// @vitest-environment node
import { renderToString } from 'react-dom/server';
import {
  createWebSocket,
  createWebSocketResponder,
  createWebSocketState,
  useAgentApproval,
  useWebSocket,
  useWebSocketState,
  useWebSocketStatus
} from '../src';

it('renders idle on the server without opening a socket', () => {
  // Node ships a global WebSocket; make sure we never reach for it during SSR.
  const spy = vi.spyOn(globalThis, 'WebSocket' as never);
  const chat = createWebSocket('ws://example.test/chat');

  function App() {
    const { status } = useWebSocket('ws://example.test/live');
    const chatStatus = useWebSocketStatus(chat);
    return <p>{`${status}/${chatStatus}`}</p>;
  }

  expect(renderToString(<App />)).toBe('<p>idle/idle</p>');
  expect(spy).not.toHaveBeenCalled();
});

it('drops sends on the server instead of queueing them forever', () => {
  const logger = vi.fn();
  const chat = createWebSocket<unknown, string>('ws://example.test/chat', { logger });
  expect(chat.send('hello')).toBe(false);
  expect(logger).toHaveBeenCalledWith('dropped message: no WebSocket implementation available');
});

it('rejects ready on the server', async () => {
  const chat = createWebSocket('ws://example.test/chat');
  await expect(chat.ready).rejects.toThrow('server render');
});

it('renders useWebSocketState from initialState on the server', () => {
  const prices = createWebSocket<{ price: number }>('ws://example.test/prices');
  const store = createWebSocketState(prices, {
    initialState: { price: 0 },
    reduce: (_, message) => message
  });
  function Price() {
    return <p>{useWebSocketState(store, state => state.price)}</p>;
  }
  expect(renderToString(<Price />)).toBe('<p>0</p>');
});

it('renders no approvals on the server', () => {
  const agent = createWebSocket<{ id: number; method: string }, unknown>('ws://example.test/agent');
  const tools = createWebSocketResponder(agent, {
    request: message => message,
    respond: (id, result) => ({ id, result }),
    error: (id, error) => ({ id, error: String(error) })
  });
  function Approvals() {
    return <p>{useAgentApproval(tools, 'approve').length}</p>;
  }
  expect(renderToString(<Approvals />)).toBe('<p>0</p>');
});
