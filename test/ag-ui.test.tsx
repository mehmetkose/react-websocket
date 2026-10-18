import { act, render } from '@testing-library/react';
import { createWebSocket, useAgUiAgent } from '../src';
import {
  applyAgUiEvent,
  applyPatch,
  createAgUiAgent,
  type AgUiAgentOptions,
  type AgUiEvent,
  type AgUiThread
} from '../src/ag-ui';
import { DatagramImpl, DatagramMockWebSocket, MockImpl, MockWebSocket } from './mock';

const empty: AgUiThread = { messages: [], state: undefined, status: 'idle', stale: false };
const fold = (events: AgUiEvent[], from: AgUiThread = empty) => events.reduce(applyAgUiEvent, from);

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('applyPatch', () => {
  const doc = { a: 1, list: [1, 2, 3], nested: { x: { y: 'z' } }, 'a/b': { '~c': 0 } };

  it('applies every operation without changing the document', () => {
    const before = structuredClone(doc);
    const next = applyPatch<Record<string, unknown>>(doc, [
      { op: 'add', path: '/b', value: 2 },
      { op: 'add', path: '/list/1', value: 9 },
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'remove', path: '/list/0' },
      { op: 'replace', path: '/a', value: 10 },
      { op: 'move', from: '/nested/x', path: '/moved' },
      { op: 'copy', from: '/moved', path: '/copied' },
      { op: 'test', path: '/copied', value: { y: 'z' } },
      { op: 'replace', path: '/a~1b/~0c', value: 1 }
    ]);
    expect(next).toEqual({
      a: 10,
      b: 2,
      list: [9, 2, 3, 4],
      nested: {},
      moved: { y: 'z' },
      copied: { y: 'z' },
      'a/b': { '~c': 1 }
    });
    expect(doc).toEqual(before);
    expect(next.copied).not.toBe(next.moved);
  });

  it('shares what it does not change', () => {
    const next = applyPatch(doc, [{ op: 'replace', path: '/a', value: 2 }]);
    expect(next.list).toBe(doc.list);
    expect(next.nested).toBe(doc.nested);
  });

  it('replaces or adds the whole document at the root path', () => {
    expect(applyPatch(doc, [{ op: 'replace', path: '', value: [1] }])).toEqual([1]);
    expect(applyPatch(doc, [{ op: 'add', path: '', value: 'x' }])).toBe('x');
  });

  it.each([
    { op: 'replace', path: '/missing', value: 1 },
    { op: 'remove', path: '/missing' },
    { op: 'add', path: '/missing/deep', value: 1 },
    { op: 'add', path: '/list/9', value: 1 },
    { op: 'remove', path: '/list/-' },
    { op: 'remove', path: '/list/3' },
    { op: 'add', path: '/list/01', value: 1 },
    { op: 'test', path: '/a', value: 2 },
    { op: 'move', path: '/x' },
    { op: 'remove', path: '' },
    { op: 'nope', path: '/a' },
    // An array's `length` isn't one of its members.
    { op: 'replace', path: '/list/length', value: 1 },
    { op: 'test', path: '/list/length', value: 3 },
    { op: 'add', path: '/list/length/x', value: 1 },
    // A pointer is empty or starts with `/`.
    { op: 'test', path: 'x/a', value: 1 },
    { op: 'copy', from: 'a', path: '/b' },
    // Nothing can move into its own child.
    { op: 'move', from: '/nested', path: '/nested/x/moved' }
  ] as const)('throws on $op $path', operation => {
    expect(() => applyPatch(doc, [operation as never])).toThrow('JSON Patch failed');
    expect(doc.list).toEqual([1, 2, 3]);
  });

  it('adds `__proto__` as a key of its own, as JSON.parse would', () => {
    const next = applyPatch<Record<string, unknown>>({}, [
      { op: 'add', path: '/__proto__', value: { polluted: true } }
    ]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.hasOwn(next, '__proto__')).toBe(true);
    expect(next).toEqual(JSON.parse('{"__proto__":{"polluted":true}}'));
  });
});

describe('applyAgUiEvent', () => {
  it('folds the run lifecycle and steps', () => {
    let thread = fold([{ type: 'RUN_STARTED', threadId: 't', runId: 'r' }]);
    expect(thread.status).toBe('running');
    thread = fold([{ type: 'STEP_STARTED', stepName: 'plan' }], thread);
    expect(thread.step).toBe('plan');
    thread = fold([{ type: 'STEP_FINISHED', stepName: 'plan' }], thread);
    expect(thread.step).toBeUndefined();
    expect(fold([{ type: 'RUN_FINISHED', result: 42 }], thread)).toMatchObject({
      status: 'finished',
      result: 42
    });
    expect(fold([{ type: 'RUN_ERROR', message: 'boom', code: 'E1' }], thread)).toMatchObject({
      status: 'error',
      error: { message: 'boom', code: 'E1' }
    });
  });

  it('builds text and reasoning messages from starts, contents and chunks', () => {
    const thread = fold([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', role: 'user', delta: 'A' },
      { type: 'TEXT_MESSAGE_CHUNK', delta: 'B' },
      { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'hmm' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r2', delta: 'so' }
    ]);
    expect(thread.messages).toEqual([
      { id: 'm1', role: 'assistant', content: 'Hello' },
      { id: 'm2', role: 'user', content: 'AB' },
      { id: 'r1', role: 'reasoning', content: 'hmm' },
      { id: 'r2', role: 'reasoning', content: 'so' }
    ]);
  });

  it('builds tool calls on their parent message, and their results', () => {
    const thread = fold([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'search', parentMessageId: 'm1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"q":' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '1}' },
      { type: 'TOOL_CALL_END', toolCallId: 't1' },
      { type: 'TOOL_CALL_RESULT', messageId: 'm2', toolCallId: 't1', content: 'found' },
      { type: 'TOOL_CALL_CHUNK', toolCallId: 't2', toolCallName: 'open', delta: '{' },
      { type: 'TOOL_CALL_CHUNK', delta: '}' }
    ]);
    expect(thread.messages).toEqual([
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":1}' } }
        ]
      },
      { id: 'm2', role: 'tool', toolCallId: 't1', content: 'found' },
      {
        id: 't2',
        role: 'assistant',
        toolCalls: [{ id: 't2', type: 'function', function: { name: 'open', arguments: '{}' } }]
      }
    ]);
  });

  it('applies state deltas, and marks the state stale instead of applying the rest after one fails', () => {
    let thread = fold([
      { type: 'STATE_SNAPSHOT', snapshot: { count: 0 } },
      { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/count', value: 1 }] }
    ]);
    expect(thread).toMatchObject({ state: { count: 1 }, stale: false });
    thread = fold(
      [
        { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/gone/x', value: 1 }] },
        { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/count', value: 2 }] }
      ],
      thread
    );
    expect(thread).toMatchObject({ state: { count: 1 }, stale: true });
    thread = fold([{ type: 'STATE_SNAPSHOT', snapshot: { count: 5 } }], thread);
    expect(thread).toMatchObject({ state: { count: 5 }, stale: false });
  });

  it('takes message snapshots and activity snapshots and deltas', () => {
    let thread = fold([
      { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u1', role: 'user', content: 'hi' }] },
      { type: 'ACTIVITY_SNAPSHOT', messageId: 'a1', activityType: 'plan', content: { steps: [] } },
      {
        type: 'ACTIVITY_DELTA',
        messageId: 'a1',
        activityType: 'plan',
        patch: [{ op: 'add', path: '/steps/-', value: 'one' }]
      },
      {
        type: 'ACTIVITY_DELTA',
        messageId: 'a1',
        activityType: 'plan',
        patch: [{ op: 'remove', path: '/nope' }]
      }
    ]);
    expect(thread.messages).toEqual([
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a1', role: 'activity', activityType: 'plan', content: { steps: ['one'] } }
    ]);
    thread = fold(
      [
        {
          type: 'ACTIVITY_SNAPSHOT',
          messageId: 'a1',
          activityType: 'plan',
          content: 'kept',
          replace: false
        }
      ],
      thread
    );
    expect(thread.messages[1]!.content).toEqual({ steps: ['one'] });
    thread = fold(
      [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'a1', activityType: 'plan', content: 'new' }],
      thread
    );
    expect(thread.messages[1]!.content).toBe('new');
  });

  it('returns the thread unchanged for other events', () => {
    expect(
      fold([
        { type: 'CUSTOM', name: 'x', value: 1 },
        { type: 'RAW', event: {} }
      ])
    ).toBe(empty);
  });
});

describe('createAgUiAgent', () => {
  type Sent = { type: string; runId: string; input?: any; after?: number };

  function setup(options: AgUiAgentOptions<{ count: number }, any, any> = {}) {
    const client = createWebSocket(`ws://ag-ui/${Math.random()}`, {
      WebSocket: MockImpl,
      json: true,
      reconnect: { jitter: 0, minDelay: 1000 }
    });
    const agent = createAgUiAgent<{ count: number }>(client, {
      threadId: 'thread-1',
      state: { count: 0 },
      storage: null,
      ...options
    });
    return { client, agent };
  }
  const sent = (): Sent[] => MockWebSocket.last.sent.map(data => JSON.parse(data as string));
  let offset = 0;
  const emit = (runId: string, event: AgUiEvent) =>
    MockWebSocket.last.receive(JSON.stringify({ runId, offset: ++offset, event }));
  beforeEach(() => {
    offset = 0;
  });

  it('starts a run with the thread so far, and folds its events into the thread', () => {
    const { agent } = setup();
    const runId = agent.run({ messages: [{ id: 'u1', role: 'user', content: 'Hi' }] });
    expect(agent.getSnapshot()).toMatchObject({
      status: 'running',
      messages: [{ id: 'u1', role: 'user', content: 'Hi' }]
    });
    MockWebSocket.last.open();
    expect(sent()).toEqual([
      {
        type: 'run',
        runId,
        input: {
          threadId: 'thread-1',
          runId,
          state: { count: 0 },
          messages: [{ id: 'u1', role: 'user', content: 'Hi' }],
          tools: [],
          context: [],
          forwardedProps: {}
        }
      }
    ]);
    emit(runId, { type: 'RUN_STARTED', threadId: 'thread-1', runId });
    emit(runId, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' });
    emit(runId, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hello' });
    emit(runId, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/count', value: 1 }] });
    emit(runId, { type: 'RUN_FINISHED', threadId: 'thread-1', runId });
    expect(agent.getSnapshot()).toMatchObject({
      status: 'finished',
      state: { count: 1 },
      messages: [
        { id: 'u1', role: 'user' },
        { id: 'm1', role: 'assistant', content: 'Hello' }
      ]
    });

    // The next run carries the whole thread and state.
    const next = agent.run({ messages: [{ id: 'u2', role: 'user', content: 'More' }] });
    expect(sent().at(-1)!.input).toMatchObject({
      runId: next,
      state: { count: 1 },
      messages: [{ id: 'u1' }, { id: 'm1' }, { id: 'u2' }]
    });
  });

  it('resumes a run after a reconnect', () => {
    const { agent } = setup();
    const runId = agent.run();
    MockWebSocket.last.open();
    emit(runId, { type: 'RUN_STARTED', threadId: 'thread-1', runId });
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'resume', runId, after: 1 }]);
  });

  it('asks once for a snapshot when a state delta fails', () => {
    const { agent } = setup({ resync: runId => ({ type: 'resync', runId }) });
    const runId = agent.run();
    MockWebSocket.last.open();
    emit(runId, { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/gone' }] });
    emit(runId, { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/gone' }] });
    expect(agent.getSnapshot().stale).toBe(true);
    expect(sent().filter(message => message.type === 'resync')).toEqual([
      { type: 'resync', runId }
    ]);
    emit(runId, { type: 'STATE_SNAPSHOT', snapshot: { count: 7 } });
    expect(agent.getSnapshot()).toMatchObject({ stale: false, state: { count: 7 } });
  });

  it('asks for a snapshot again each time the state goes stale', () => {
    const { agent } = setup({ resync: runId => ({ type: 'resync', runId }) });
    const runId = agent.run();
    MockWebSocket.last.open();
    emit(runId, { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/gone' }] });
    emit(runId, { type: 'STATE_SNAPSHOT', snapshot: { count: 7 } });
    emit(runId, { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/gone' }] });
    expect(sent().filter(message => message.type === 'resync')).toHaveLength(2);
    emit(runId, { type: 'STATE_SNAPSHOT', snapshot: { count: 8 } });
    emit(runId, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/count', value: 9 }] });
    expect(agent.getSnapshot()).toMatchObject({ stale: false, state: { count: 9 } });
  });

  it("asks for a snapshot on the socket's reliable stream, not as a datagram", () => {
    const client = createWebSocket(`ws://ag-ui/${Math.random()}`, {
      WebSocket: DatagramImpl,
      json: true
    });
    const agent = createAgUiAgent(client, {
      storage: null,
      resync: runId => ({ type: 'resync', runId })
    });
    const runId = agent.run();
    MockWebSocket.last.open();
    emit(runId, { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/gone' }] });
    expect(sent().at(-1)).toEqual({ type: 'resync', runId });
    expect((MockWebSocket.last as DatagramMockWebSocket).datagrams).toEqual([]);
  });

  it("starts the next run from the last good state, and applies that run's deltas", () => {
    const { agent } = setup();
    const first = agent.run();
    MockWebSocket.last.open();
    emit(first, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/count', value: 1 }] });
    emit(first, { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/gone' }] });
    emit(first, { type: 'RUN_FINISHED', threadId: 'thread-1', runId: first });
    expect(agent.getSnapshot()).toMatchObject({ stale: true, state: { count: 1 } });

    const next = agent.run();
    expect(sent().at(-1)!.input.state).toEqual({ count: 1 });
    expect(agent.getSnapshot().stale).toBe(false);
    offset = 0;
    emit(next, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/count', value: 2 }] });
    expect(agent.getSnapshot()).toMatchObject({ stale: false, state: { count: 2 } });
  });

  it('aborts the streaming run when a new one starts, or on abort()', () => {
    const { agent } = setup();
    const first = agent.run();
    MockWebSocket.last.open();
    emit(first, { type: 'RUN_STARTED', threadId: 'thread-1', runId: first });
    agent.run();
    expect(sent()).toContainEqual({ type: 'cancel', runId: first });
    expect(agent.runs.get(first)?.status).toBe('aborted');
    agent.abort();
    expect(agent.getSnapshot().status).toBe('aborted');
  });

  it('uses custom message formats', () => {
    const { agent } = setup({
      run: (input, runId) => ({ op: 'go', id: runId, threadId: input.threadId }),
      event: (message: any) =>
        message.kind === 'agui'
          ? { runId: message.id, offset: message.n, event: message.e }
          : undefined
    });
    const runId = agent.run();
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ op: 'go', id: runId, threadId: 'thread-1' }]);
    MockWebSocket.last.receive(
      JSON.stringify({ kind: 'agui', id: runId, n: 1, e: { type: 'RUN_STARTED', runId } })
    );
    expect(agent.getSnapshot().status).toBe('running');
  });

  it('renders with useAgUiAgent', () => {
    const { agent } = setup();
    function Thread() {
      const thread = useAgUiAgent(agent);
      return (
        <p>{thread.messages.map(message => String(message.content)).join('|') || thread.status}</p>
      );
    }
    const { container } = render(<Thread />);
    expect(container.textContent).toBe('idle');
    let runId = '';
    act(() => {
      runId = agent.run({ messages: [{ id: 'u1', role: 'user', content: 'Hi' }] });
    });
    act(() => MockWebSocket.last.open());
    act(() => {
      emit(runId, { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' });
      emit(runId, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hey' });
    });
    expect(container.textContent).toBe('Hi|Hey');
    agent.dispose();
  });
});
