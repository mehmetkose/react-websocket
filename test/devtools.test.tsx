import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import {
  createWebSocket,
  createWebSocketFeeds,
  createWebSocketLatency,
  createWebSocketPresence,
  createWebSocketRuns,
  createWebSocketTopics,
  useWebSocket
} from '../src';
import { WebSocketDevtools } from '../src/devtools';
import { createWebSocketOutbox, memoryStorage } from '../src/outbox';
import { MockImpl, MockWebSocket } from './mock';

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The value shown for `name` in the panel. */
const fact = (name: string) =>
  [...document.querySelectorAll('dt')].find(dt => dt.textContent === name)?.nextElementSibling
    ?.textContent;

describe('WebSocketDevtools', () => {
  it('shows each client with its queue, messages, and what its sources say', async () => {
    const live = createWebSocket<any, any>('ws://devtools/live', {
      WebSocket: MockImpl,
      json: true
    });
    const topics = createWebSocketTopics(live, { subscribe: topic => ({ type: 'sub', topic }) });
    const latency = createWebSocketLatency(live, {
      ping: id => ({ type: 'ping', id }),
      pong: message => (message.type === 'pong' ? message : undefined)
    });
    const presence = createWebSocketPresence(live, {
      send: (state: number) => ({ type: 'here', state }),
      receive: message => (message.type === 'here' ? message : undefined)
    });
    const outbox = createWebSocketOutbox(live, {
      name: 'devtools',
      storage: memoryStorage(),
      send: (order: number, id) => ({ type: 'order', id, order })
    });
    const runs = createWebSocketRuns(live, {
      name: 'devtools',
      storage: null,
      start: (prompt: string, runId) => ({ type: 'run', runId, prompt }),
      resume: (runId, after) => ({ type: 'resume', runId, after }),
      event: () => undefined,
      initial: '',
      reduce: text => text
    });
    const other = createWebSocket('ws://devtools/other', { WebSocket: MockImpl });
    const feeds = createWebSocketFeeds(other, {
      subscribe: (topic, after) => ({ topic, after }),
      sequence: () => undefined
    });

    render(
      <WebSocketDevtools
        sources={[topics, latency, presence, outbox, runs, feeds, live, {}, null]}
      />
    );
    const toggle = screen.getByRole('button');
    expect(toggle.textContent).toBe('WebSocket · 2 clients');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'WebSocket clients' })).toBeDefined();

    await outbox.ready;
    live.connect();
    topics.acquire('prices');
    feeds.acquire('room');
    live.send({ type: 'queued' });
    act(() => vi.advanceTimersByTime(500));
    expect(fact('status')).toBe('connecting');
    expect(fact('queued')).toBe('1');
    expect(fact('topics')).toBe('prices');
    expect(fact('feeds')).toBe('room @–');
    expect(fact('rtt')).toBe('–');
    expect(fact('presence')).toBe('0 peers');
    expect(fact('runs')).toBe('0 streaming, 0 in all');

    act(() => {
      MockWebSocket.instances[0]!.open();
      MockWebSocket.instances[0]!.receive(JSON.stringify({ type: 'hello' }));
      MockWebSocket.instances[0]!.receive(JSON.stringify({ type: 'pong', id: 1 }));
    });
    act(() => vi.advanceTimersByTime(500));
    expect(fact('status')).toBe('open');
    expect(fact('queued')).toBe('0');
    expect(fact('received')).toBe('2');
    expect(fact('rtt')).toMatch(/^\d+ ms$/);

    fireEvent.click(toggle);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('lists the clients useWebSocket shares by URL', () => {
    function Live() {
      useWebSocket('ws://devtools/shared', { WebSocket: MockImpl });
      return null;
    }
    render(
      <>
        <Live />
        <WebSocketDevtools open position="top-left" />
      </>
    );
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('button').textContent).toMatch(/client/);
    expect(screen.getByText('ws://devtools/shared')).toBeDefined();
    expect(fact('status')).toBe('connecting');
  });

  it('renders nothing on the server, and says when there are no clients', () => {
    expect(renderToString(<WebSocketDevtools open />)).toBe('');
    const shared = (globalThis as Record<symbol, Map<string, unknown>>)[
      Symbol.for('react-websocket.registry')
    ]!;
    const saved = [...shared];
    shared.clear();
    render(<WebSocketDevtools open />);
    expect(screen.getByText('No clients yet.')).toBeDefined();
    for (const [key, value] of saved) shared.set(key, value);
  });
});
