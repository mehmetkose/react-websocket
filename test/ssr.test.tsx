// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { createWebSocket, useWebSocket, useWebSocketStatus } from '../src';

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
