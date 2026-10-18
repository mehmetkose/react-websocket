import { act, render } from '@testing-library/react';
import { createWebSocket, createWebSocketRuns, useAgentRun, type RunStorage } from '../src';
import { MockImpl, MockWebSocket } from './mock';

type In =
  | { type: 'token'; runId: string; offset: number; text: string }
  | { type: 'done'; runId: string; offset: number; text: string }
  | { type: 'failed'; runId: string; offset: number; error: string }
  | { type: 'other' };
type Out =
  | { type: 'run'; runId: string; prompt: string }
  | { type: 'resume'; runId: string; after?: number }
  | { type: 'cancel'; runId: string }
  | { type: 'chat'; text: string };

let n = 0;

function memory(): RunStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key)
  };
}

function setup(storage: RunStorage | null = memory(), url = `ws://runs/${++n}`) {
  const client = createWebSocket<In, Out>(url, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const runs = createWebSocketRuns(client, {
    name: 'chat',
    storage,
    start: (prompt: string, runId) => ({ type: 'run', runId, prompt }),
    resume: (runId, after) => ({ type: 'resume', runId, after }),
    cancel: runId => ({ type: 'cancel', runId }),
    event: message => (message.type === 'other' ? undefined : message),
    done: message => message.type === 'done',
    error: message => (message.type === 'failed' ? message.error : undefined),
    initial: '',
    reduce: (text, message) =>
      message.type === 'other' || message.type === 'failed' ? text : text + message.text
  });
  return { client, runs, storage };
}

const token = (runId: string, offset: number, text = `t${offset} `) =>
  MockWebSocket.last.receive(JSON.stringify({ type: 'token', runId, offset, text }));
const done = (runId: string, offset: number) =>
  MockWebSocket.last.receive(JSON.stringify({ type: 'done', runId, offset, text: 'end' }));
const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));
const reconnect = () => {
  MockWebSocket.last.finishClose(1006);
  vi.advanceTimersByTime(1000);
  MockWebSocket.last.open();
};

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketRuns', () => {
  it('starts a run, folds its events, and forgets it once done', () => {
    const { client, runs, storage } = setup();
    const runId = runs.start('hello', { runId: 'r1' });
    expect(runId).toBe('r1');
    expect(runs.get('r1')).toEqual({
      runId: 'r1',
      status: 'streaming',
      value: '',
      error: undefined
    });
    expect((storage as ReturnType<typeof memory>).data.get('react-websocket-runs:chat')).toBe(
      '{"r1":"keep"}'
    );
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'run', runId: 'r1', prompt: 'hello' }]);
    token('r1', 1);
    token('r1', 2);
    expect(runs.get('r1')?.value).toBe('t1 t2 ');
    done('r1', 3);
    expect(runs.get('r1')).toMatchObject({ status: 'done', value: 't1 t2 end' });
    expect((storage as ReturnType<typeof memory>).data.size).toBe(0);
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot().status).toBe('idle');
  });

  it('resumes after the last event on a new connection, dropping what is replayed twice', () => {
    const { runs } = setup();
    runs.start('hello', { runId: 'r1' });
    MockWebSocket.last.open();
    token('r1', 1);
    token('r1', 2);
    reconnect();
    expect(sent()).toEqual([{ type: 'resume', runId: 'r1', after: 2 }]);
    token('r1', 2);
    token('r1', 3);
    expect(runs.get('r1')?.value).toBe('t1 t2 t3 ');
  });

  it('sends the start again if the connection drops before the first event', () => {
    const { runs } = setup();
    runs.start('hello', { runId: 'r1' });
    MockWebSocket.last.open();
    reconnect();
    expect(sent()).toEqual([{ type: 'run', runId: 'r1', prompt: 'hello' }]);
  });

  it('follows the runs it remembered after a reload, from their first event', () => {
    const storage = memory();
    const before = setup(storage);
    before.runs.start('hello', { runId: 'r1' });
    MockWebSocket.last.open();
    token('r1', 1);
    before.runs.dispose();
    before.client.close();

    const { runs } = setup(storage);
    expect(runs.list().map(run => run.runId)).toEqual(['r1']);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'resume', runId: 'r1' }]);
    token('r1', 1);
    token('r1', 2);
    expect(runs.get('r1')?.value).toBe('t1 t2 ');
  });

  it("aborts a run whose policy is 'cancel' when the connection drops, and cancels it first thing on the next", () => {
    const { client, runs } = setup();
    client.connect();
    runs.start('hello', { runId: 'r1', policy: 'cancel' });
    MockWebSocket.last.open();
    token('r1', 1);
    MockWebSocket.last.finishClose(1006);
    expect(runs.get('r1')).toMatchObject({ status: 'aborted', value: 't1 ' });
    client.send({ type: 'chat', text: 'queued' });
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(sent()).toEqual([
      { type: 'cancel', runId: 'r1' },
      { type: 'chat', text: 'queued' }
    ]);
    // Late events are ignored.
    token('r1', 2);
    expect(runs.get('r1')?.value).toBe('t1 ');
  });

  it('holds the connection until a cancel goes out, even with nothing else holding it', () => {
    const { client, runs } = setup();
    runs.start('hello', { runId: 'r1', policy: 'cancel' });
    MockWebSocket.last.open();
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    expect(client.getSnapshot().status).toBe('reconnecting');
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'cancel', runId: 'r1' }]);
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot().status).toBe('idle');
  });

  it("cancels, rather than follows, a remembered run whose policy is 'cancel'", () => {
    const storage = memory();
    storage.setItem('react-websocket-runs:chat', '{"r1":"cancel","r2":"keep"}');
    const { runs } = setup(storage);
    expect(runs.list().map(run => run.runId)).toEqual(['r2']);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'resume', runId: 'r2' }]);
    // Once no other page has said it follows the run.
    vi.advanceTimersByTime(200);
    expect(sent()).toEqual([
      { type: 'resume', runId: 'r2' },
      { type: 'cancel', runId: 'r1' }
    ]);
    expect(storage.data.get('react-websocket-runs:chat')).toBe('{"r2":"keep"}');
  });

  it("doesn't cancel a remembered run that another page still follows, as from a duplicated tab", async () => {
    vi.useRealTimers();
    const runId = `dup-${++n}`;
    const original = setup();
    original.runs.start('hello', { runId, policy: 'cancel' });
    MockWebSocket.last.open();
    // Duplicating a tab, or `window.open`, copies sessionStorage.
    const copy = () => {
      const storage = memory();
      storage.setItem(
        'react-websocket-runs:chat',
        original.storage!.getItem('react-websocket-runs:chat')!
      );
      return storage;
    };
    const duplicate = setup(copy());
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(MockWebSocket.instances.filter(s => s.url === duplicate.client.url)).toHaveLength(0);
    expect(original.runs.get(runId)?.status).toBe('streaming');

    // Once the page that followed it is gone, a copy cancels it.
    const remembered = copy();
    original.runs.dispose();
    const later = setup(remembered);
    await new Promise(resolve => setTimeout(resolve, 300));
    MockWebSocket.last.open();
    expect(MockWebSocket.last.url).toBe(later.client.url);
    expect(sent()).toEqual([{ type: 'cancel', runId }]);
    duplicate.runs.dispose();
    later.runs.dispose();
  });

  it("sends cancel with `queue: false`, which doesn't queue it", () => {
    const client = createWebSocket<In, Out>(`ws://runs/${++n}`, {
      WebSocket: MockImpl,
      json: true,
      queue: false,
      reconnect: { jitter: 0, minDelay: 1000 }
    });
    const runs = createWebSocketRuns(client, {
      name: `noqueue-${n}`,
      storage: null,
      start: (prompt: string, runId) => ({ type: 'run', runId, prompt }),
      resume: (runId, after) => ({ type: 'resume', runId, after }),
      cancel: runId => ({ type: 'cancel', runId }),
      event: message => (message.type === 'other' ? undefined : message),
      initial: '',
      reduce: text => text,
      policy: 'cancel'
    });
    runs.start('hello', { runId: 'r1' });
    MockWebSocket.last.open();
    token('r1', 1);
    reconnect();
    expect(sent()).toEqual([{ type: 'cancel', runId: 'r1' }]);
    expect(runs.get('r1')?.status).toBe('aborted');
  });

  it("starts nothing for a runId it already knows, and doesn't hold the connection for it", () => {
    const { client, runs } = setup();
    runs.start('hello', { runId: 'r1' });
    MockWebSocket.last.open();
    done('r1', 1);
    vi.runAllTimers();
    expect(client.getSnapshot().status).toBe('idle');

    expect(runs.start('again', { runId: 'r1' })).toBe('r1');
    expect(runs.get('r1')).toMatchObject({ status: 'done', value: 'end' });
    vi.runAllTimers();
    expect(client.getSnapshot().status).toBe('idle');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('abort() sends cancel and ignores later events; delete() forgets the run', () => {
    const { runs } = setup();
    runs.start('hello', { runId: 'r1' });
    MockWebSocket.last.open();
    token('r1', 1);
    runs.abort('r1');
    expect(sent().at(-1)).toEqual({ type: 'cancel', runId: 'r1' });
    token('r1', 2);
    expect(runs.get('r1')).toMatchObject({ status: 'aborted', value: 't1 ' });
    runs.abort('r1');
    expect(sent().filter(message => message.type === 'cancel')).toHaveLength(1);
    runs.delete('r1');
    expect(runs.get('r1')).toBeUndefined();
    expect(runs.list()).toEqual([]);
  });

  it('ends a run with the error an event carries', () => {
    const { runs } = setup();
    runs.start('hello', { runId: 'r1' });
    MockWebSocket.last.open();
    token('r1', 1);
    MockWebSocket.last.receive(
      JSON.stringify({ type: 'failed', runId: 'r1', offset: 2, error: 'quota' })
    );
    expect(runs.get('r1')).toMatchObject({ status: 'error', error: 'quota', value: 't1 ' });
  });

  it('attaches to a run started elsewhere, once', () => {
    const { runs } = setup();
    runs.attach('r9');
    runs.attach('r9');
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'resume', runId: 'r9' }]);
  });

  it('gives each run a unique id by default, and passes other messages by', () => {
    const { runs } = setup();
    const a = runs.start('a');
    const b = runs.start('b');
    expect(a).not.toBe(b);
    MockWebSocket.last.open();
    MockWebSocket.last.receive(JSON.stringify({ type: 'other' }));
    expect(runs.get(a)?.value).toBe('');
  });

  it('works without storage, and when storage fails', () => {
    const none = setup(null);
    none.runs.start('a', { runId: 'r1' });
    expect(none.runs.get('r1')?.status).toBe('streaming');

    const failing: RunStorage = {
      getItem: () => 'not json',
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {}
    };
    const broken = setup(failing);
    expect(() => broken.runs.start('a', { runId: 'r2' })).not.toThrow();
    expect(broken.runs.get('r2')?.status).toBe('streaming');
  });

  it('remembers runs in sessionStorage by default', () => {
    const client = createWebSocket<In, Out>(`ws://runs/${++n}`, { WebSocket: MockImpl });
    const runs = createWebSocketRuns(client, {
      name: 'default',
      start: (prompt: string, runId) => ({ type: 'run' as const, runId, prompt }),
      resume: (runId, after) => ({ type: 'resume' as const, runId, after }),
      event: () => undefined,
      initial: '',
      reduce: text => text
    });
    runs.start('a', { runId: 'r1' });
    expect(sessionStorage.getItem('react-websocket-runs:default')).toBe('{"r1":"keep"}');
    runs.abort('r1');
    expect(sessionStorage.getItem('react-websocket-runs:default')).toBeNull();
    runs.dispose();
  });

  it('stops after dispose()', () => {
    const { client, runs } = setup();
    runs.start('a', { runId: 'r1' });
    MockWebSocket.last.open();
    runs.dispose();
    token('r1', 1);
    expect(runs.get('r1')?.value).toBe('');
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot().status).toBe('idle');
  });
});

describe('useAgentRun', () => {
  it('renders a run as it streams, and attaches to one it does not know', () => {
    const { runs } = setup();
    function Answer({ runId }: { runId: string | null }) {
      const run = useAgentRun(runs, runId);
      return <p>{run ? `${run.status}:${run.value}` : 'none'}</p>;
    }
    const { container, rerender } = render(<Answer runId={null} />);
    expect(container.textContent).toBe('none');

    rerender(<Answer runId="r7" />);
    expect(container.textContent).toBe('streaming:');
    act(() => MockWebSocket.last.open());
    expect(sent()).toEqual([{ type: 'resume', runId: 'r7' }]);
    act(() => token('r7', 1, 'Hi'));
    act(() => done('r7', 2));
    expect(container.textContent).toBe('done:Hiend');
  });
});
