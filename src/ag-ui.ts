// The build keeps `./core` external, so this entry shares the client with the others.
import {
  createWebSocketRuns,
  type RunPolicy,
  type RunStorage,
  type WebSocketClient,
  type WebSocketRuns
} from './core';

/** A JSON Patch (RFC 6902) operation, as in AG-UI's `STATE_DELTA` and `ACTIVITY_DELTA`. */
export interface JsonPatchOperation {
  readonly op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  /** A JSON Pointer (RFC 6901), such as `/items/0/name`. */
  readonly path: string;
  /** The source of `move` and `copy`. */
  readonly from?: string;
  /** The value to `add`, `replace` with or `test` for. */
  readonly value?: unknown;
}

/** An AG-UI event: `type` is `'RUN_STARTED'`, `'TEXT_MESSAGE_CONTENT'`, `'STATE_DELTA'`, … */
export interface AgUiEvent {
  readonly type: string;
  readonly [field: string]: any;
}

/** A tool call on an assistant message, as in AG-UI. */
export interface AgUiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/** A message in an AG-UI thread. */
export interface AgUiMessage {
  readonly id: string;
  readonly role: 'developer' | 'system' | 'assistant' | 'user' | 'tool' | 'reasoning' | 'activity';
  readonly content?: unknown;
  readonly toolCalls?: readonly AgUiToolCall[];
  /** For a `tool` message, the call it answers. */
  readonly toolCallId?: string;
  /** For an `activity` message. */
  readonly activityType?: string;
  readonly [field: string]: unknown;
}

/** AG-UI's `RunAgentInput`: what a run starts from. */
export interface RunAgentInput {
  readonly threadId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly state?: unknown;
  readonly messages: readonly AgUiMessage[];
  readonly tools: readonly unknown[];
  readonly context: readonly unknown[];
  readonly forwardedProps: unknown;
}

/** A thread's messages and shared state, reduced from AG-UI events. */
export interface AgUiThread<S = unknown> {
  readonly messages: readonly AgUiMessage[];
  /** The shared state, from `STATE_SNAPSHOT` and `STATE_DELTA`. */
  readonly state: S;
  /**
   * `'running'` from `RUN_STARTED`, `'finished'` after `RUN_FINISHED`, `'error'` after
   * `RUN_ERROR`, `'aborted'` when the run was stopped from this side.
   */
  readonly status: 'idle' | 'running' | 'finished' | 'error' | 'aborted';
  /** The step in progress, between `STEP_STARTED` and `STEP_FINISHED`. */
  readonly step?: string;
  /** From `RUN_ERROR`. */
  readonly error?: { readonly message: string; readonly code?: string };
  /** From `RUN_FINISHED`. */
  readonly result?: unknown;
  /**
   * A `STATE_DELTA` couldn't be applied. `state` is the last good one, and later deltas are
   * skipped until a `STATE_SNAPSHOT` arrives.
   */
  readonly stale: boolean;
}

type Json = any;

function unescape(token: string) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => equal(a[key], b[key]));
}

function fail(operation: JsonPatchOperation): never {
  throw new Error(`JSON Patch failed: ${operation.op} ${operation.path}`);
}

/**
 * Apply a JSON Patch (RFC 6902) without changing `document`: what changes is copied, the rest is
 * shared. Throws, leaving `document` as it was, if an operation can't be applied: a missing path,
 * an index out of range, or a failed `test`.
 */
export function applyPatch<T>(document: T, operations: readonly JsonPatchOperation[]): T {
  let root: Json = document;

  function get(path: string, operation: JsonPatchOperation): Json {
    let node = root;
    for (const token of path.split('/').slice(1).map(unescape)) {
      if (typeof node !== 'object' || node === null || !Object.hasOwn(node, token)) fail(operation);
      node = node[token];
    }
    return node;
  }

  // Replace the parent of `path` with a copy, change it with `change`, and copy its ancestors.
  function edit(
    path: string,
    operation: JsonPatchOperation,
    change: (parent: Json, key: string) => void
  ) {
    const tokens = path.split('/').slice(1).map(unescape);
    if (!tokens.length) fail(operation);
    const walk = (node: Json, depth: number): Json => {
      if (typeof node !== 'object' || node === null) fail(operation);
      const copy = Array.isArray(node) ? [...node] : { ...node };
      const key = tokens[depth]!;
      if (depth === tokens.length - 1) change(copy, key);
      else if (!Object.hasOwn(node, key)) fail(operation);
      else copy[key] = walk(node[key], depth + 1);
      return copy;
    };
    root = walk(root, 0);
  }

  function index(parent: Json[], key: string, operation: JsonPatchOperation, adding: boolean) {
    // `-` is the end of the array, which only `add` can use.
    const i = key === '-' ? (adding ? parent.length : -1) : /^(0|[1-9]\d*)$/.test(key) ? +key : -1;
    if (i < 0 || i > parent.length - (adding ? 0 : 1)) fail(operation);
    return i;
  }

  function add(path: string, value: Json, operation: JsonPatchOperation) {
    if (path === '') return void (root = value);
    edit(path, operation, (parent, key) => {
      if (Array.isArray(parent)) parent.splice(index(parent, key, operation, true), 0, value);
      else parent[key] = value;
    });
  }

  function remove(path: string, operation: JsonPatchOperation) {
    edit(path, operation, (parent, key) => {
      if (Array.isArray(parent)) parent.splice(index(parent, key, operation, false), 1);
      else if (Object.hasOwn(parent, key)) delete parent[key];
      else fail(operation);
    });
  }

  for (const operation of operations) {
    const { op, path, from, value } = operation;
    if (op === 'add') add(path, value, operation);
    else if (op === 'remove') remove(path, operation);
    else if (op === 'replace') {
      get(path, operation);
      if (path === '') root = value;
      else
        edit(path, operation, (parent, key) => {
          parent[key] = value;
        });
    } else if (op === 'move' || op === 'copy') {
      const moved = get(from ?? fail(operation), operation);
      if (op === 'move') remove(from!, operation);
      add(path, op === 'copy' ? structuredClone(moved) : moved, operation);
    } else if (op === 'test') {
      if (!equal(get(path, operation), value)) fail(operation);
    } else fail(operation);
  }
  return root;
}

function updateMessage(
  thread: AgUiThread<any>,
  id: string | undefined,
  change: (message: AgUiMessage) => AgUiMessage
) {
  return thread.messages.map(message => (message.id === id ? change(message) : message));
}

function appendText(message: AgUiMessage, delta: string | undefined) {
  return { ...message, content: `${(message.content as string | undefined) ?? ''}${delta ?? ''}` };
}

function updateToolCall(
  thread: AgUiThread<any>,
  id: string | undefined,
  change: (call: AgUiToolCall) => AgUiToolCall
) {
  return thread.messages.map(message =>
    message.toolCalls?.some(call => call.id === id)
      ? {
          ...message,
          toolCalls: message.toolCalls.map(call => (call.id === id ? change(call) : call))
        }
      : message
  );
}

/** The last message with a tool call, for chunks that leave out `toolCallId`. */
function lastToolCallId(thread: AgUiThread<any>) {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const calls = thread.messages[i]!.toolCalls;
    if (calls?.length) return calls.at(-1)!.id;
  }
}

/**
 * Fold one AG-UI event into a thread, without changing it. Handles the run lifecycle, steps,
 * text, tool calls and their results, reasoning, activity, and message and state snapshots and
 * deltas. A `STATE_DELTA` that can't be applied marks the thread `stale` instead of throwing.
 * Other events, such as `CUSTOM` and `RAW`, return the thread unchanged.
 *
 * Use it as a `reduce` function, or wrap it to handle events of your own.
 */
export function applyAgUiEvent<S>(thread: AgUiThread<S>, event: AgUiEvent): AgUiThread<S> {
  const e = event;
  const message = (role: AgUiMessage['role'], extra?: object): AgUiThread<S> => ({
    ...thread,
    messages: [...thread.messages, { id: e.messageId, role, content: '', ...extra }]
  });
  const known = (id: string | undefined) => thread.messages.some(m => m.id === id);
  switch (e.type) {
    case 'RUN_STARTED':
      return { ...thread, status: 'running', error: undefined, result: undefined };
    case 'RUN_FINISHED':
      return { ...thread, status: 'finished', step: undefined, result: e.result };
    case 'RUN_ERROR':
      return {
        ...thread,
        status: 'error',
        step: undefined,
        error: { message: e.message, code: e.code }
      };
    case 'STEP_STARTED':
      return { ...thread, step: e.stepName };
    case 'STEP_FINISHED':
      return { ...thread, step: undefined };
    case 'TEXT_MESSAGE_START':
      return message(e.role ?? 'assistant');
    case 'REASONING_MESSAGE_START':
      return message('reasoning');
    case 'TEXT_MESSAGE_CONTENT':
    case 'REASONING_MESSAGE_CONTENT':
      return {
        ...thread,
        messages: updateMessage(thread, e.messageId, m => appendText(m, e.delta))
      };
    case 'TEXT_MESSAGE_CHUNK':
    case 'REASONING_MESSAGE_CHUNK': {
      // Only the first chunk of a message must carry its id.
      const id = e.messageId ?? thread.messages.at(-1)?.id;
      const role = e.type === 'TEXT_MESSAGE_CHUNK' ? (e.role ?? 'assistant') : 'reasoning';
      const next = known(id) ? thread : message(role);
      return { ...next, messages: updateMessage(next, id, m => appendText(m, e.delta)) };
    }
    case 'TOOL_CALL_START':
    case 'TOOL_CALL_CHUNK': {
      const id = e.toolCallId ?? lastToolCallId(thread);
      let next = thread;
      if (
        e.type === 'TOOL_CALL_START' ||
        !thread.messages.some(m => m.toolCalls?.some(c => c.id === id))
      ) {
        const call: AgUiToolCall = {
          id,
          type: 'function',
          function: { name: e.toolCallName, arguments: '' }
        };
        const parent = e.parentMessageId ?? id;
        next = known(parent)
          ? thread
          : { ...thread, messages: [...thread.messages, { id: parent, role: 'assistant' }] };
        next = {
          ...next,
          messages: updateMessage(next, parent, m => ({
            ...m,
            toolCalls: [...(m.toolCalls ?? []), call]
          }))
        };
      }
      if (e.type === 'TOOL_CALL_START') return next;
      return toolArgs(next, id, e.delta);
    }
    case 'TOOL_CALL_ARGS':
      return toolArgs(thread, e.toolCallId, e.delta);
    case 'TOOL_CALL_RESULT':
      return message(e.role ?? 'tool', { toolCallId: e.toolCallId, content: e.content });
    case 'STATE_SNAPSHOT':
      return { ...thread, state: e.snapshot, stale: false };
    case 'STATE_DELTA':
      if (thread.stale) return thread;
      try {
        return { ...thread, state: applyPatch(thread.state, e.delta) };
      } catch {
        return { ...thread, stale: true };
      }
    case 'MESSAGES_SNAPSHOT':
      return { ...thread, messages: e.messages };
    case 'ACTIVITY_SNAPSHOT': {
      if (known(e.messageId) && e.replace === false) return thread;
      const next = known(e.messageId) ? thread : message('activity');
      return {
        ...next,
        messages: updateMessage(next, e.messageId, m => ({
          ...m,
          activityType: e.activityType,
          content: e.content
        }))
      };
    }
    case 'ACTIVITY_DELTA':
      try {
        return {
          ...thread,
          messages: updateMessage(thread, e.messageId, m => ({
            ...m,
            content: applyPatch(m.content, e.patch)
          }))
        };
      } catch {
        return thread;
      }
    default:
      return thread;
  }
}

function toolArgs<S>(thread: AgUiThread<S>, id: string | undefined, delta: string | undefined) {
  return {
    ...thread,
    messages: updateToolCall(thread, id, call => ({
      ...call,
      function: { ...call.function, arguments: call.function.arguments + (delta ?? '') }
    }))
  };
}

/** What the server sends for each event of a run: its run, its offset (from 1), and the event. */
export interface AgUiEnvelope {
  readonly runId: string;
  readonly offset: number;
  readonly event: AgUiEvent;
}

/** Options for {@link createAgUiAgent}. The message formats have defaults; see the guide. */
export interface AgUiAgentOptions<S, In, Out> {
  /** The thread's id, sent in every `RunAgentInput`. A new random one by default. */
  threadId?: string;
  /** The shared state before the first `STATE_SNAPSHOT`, sent with the first run. */
  state?: S;
  /** Names where streaming runs are remembered across reloads. @default 'ag-ui' */
  name?: string;
  /** @default `{ type: 'run', runId, input }` */
  run?: (input: RunAgentInput, runId: string) => Out;
  /** @default `{ type: 'resume', runId, after }` */
  resume?: (runId: string, after: number | undefined) => Out;
  /** @default `{ type: 'cancel', runId }` */
  cancel?: (runId: string) => Out;
  /**
   * The message that asks the server for a `STATE_SNAPSHOT`, sent when a `STATE_DELTA` can't
   * be applied. Without it, the state stays `stale` until the server sends one by itself.
   */
  resync?: (runId: string) => Out;
  /** Recognize a run's event. @default messages shaped like {@link AgUiEnvelope} */
  event?: (message: In) => AgUiEnvelope | null | undefined;
  /** What happens to a run when its connection drops. @default 'keep' */
  policy?: RunPolicy;
  /** Where streaming runs are remembered. @default sessionStorage */
  storage?: RunStorage | null;
}

/** An AG-UI agent over a WebSocket. Create with {@link createAgUiAgent}. */
export interface AgUiAgent<S> {
  /** The client the runs stream on. */
  readonly client: WebSocketClient<any, any>;
  /** The runs underneath, from `createWebSocketRuns`. */
  readonly runs: WebSocketRuns<RunAgentInput, AgUiThread<S>>;
  /**
   * Start a run with the thread so far plus `input.messages`, which show up in the thread right
   * away. A run that's still streaming is aborted first. Returns the run's id.
   */
  run(
    input?: {
      messages?: readonly AgUiMessage[];
      tools?: readonly unknown[];
      context?: readonly unknown[];
      forwardedProps?: unknown;
    },
    options?: { policy?: RunPolicy }
  ): string;
  /** Stop the run that's streaming, if any. */
  abort(): void;
  /** The thread as of the latest run. The same object until it changes. */
  getSnapshot(): AgUiThread<S>;
  /** Get notified when the thread changes. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Stop following runs, and release the connection. */
  dispose(): void;
}

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

const isEnvelope = (message: any): AgUiEnvelope | undefined =>
  typeof message?.runId === 'string' &&
  typeof message.offset === 'number' &&
  typeof message.event?.type === 'string'
    ? message
    : undefined;

const ENDS = new Set(['RUN_FINISHED', 'RUN_ERROR']);

/**
 * Run an [AG-UI](https://docs.ag-ui.com) agent over a WebSocket. Each run streams AG-UI events,
 * which are folded into the thread's messages and shared state with {@link applyAgUiEvent}.
 * Runs come from `createWebSocketRuns`, so they resume after a reconnect or a reload, and a
 * state delta that can't be applied asks for a snapshot (`resync`).
 *
 * AG-UI doesn't define messages for WebSockets, so the defaults are small: the client sends
 * `{ type: 'run', runId, input }`, `{ type: 'resume', runId, after }` and
 * `{ type: 'cancel', runId }`, and the server sends `{ runId, offset, event }`, with `offset`
 * counting each run's events from 1. Each option replaces one of them.
 *
 * @example
 * ```ts
 * import { createAgUiAgent } from 'react-websocket/ag-ui';
 *
 * export const agent = createAgUiAgent(createWebSocket(url, { json: true }));
 *
 * agent.run({ messages: [{ id: crypto.randomUUID(), role: 'user', content: 'Plan my week' }] });
 * ```
 */
export function createAgUiAgent<S = unknown, In = any, Out = any>(
  client: WebSocketClient<In, Out>,
  options: AgUiAgentOptions<S, NoInfer<In>, NoInfer<Out>> = {}
): AgUiAgent<S> {
  const threadId = options.threadId ?? randomId();
  const empty: AgUiThread<S> = {
    messages: [],
    state: options.state as S,
    status: 'idle',
    stale: false
  };
  let base = empty;
  let snapshot = empty;
  const listeners = new Set<() => void>();
  // Runs that already asked for a snapshot after a failed delta.
  const resynced = new Set<string>();
  const event = options.event ?? isEnvelope;
  const send = (message: unknown) => client.send(message as Out, { volatile: true });

  const runs = createWebSocketRuns<RunAgentInput, AgUiThread<S>, In, Out>(client, {
    name: options.name ?? 'ag-ui',
    start: options.run ?? ((input, runId) => ({ type: 'run', runId, input }) as Out),
    resume: options.resume ?? ((runId, after) => ({ type: 'resume', runId, after }) as Out),
    cancel: options.cancel ?? (runId => ({ type: 'cancel', runId }) as Out),
    event: message => event(message),
    done: message => ENDS.has(event(message)!.event.type),
    initial: empty,
    reduce: (thread, message) => applyAgUiEvent(thread, event(message)!.event),
    policy: options.policy,
    storage: options.storage
  });

  function update() {
    const latest = runs.list().at(-1);
    let next = latest ? latest.value : base;
    if (latest?.status === 'aborted' && next.status === 'running')
      next = { ...next, status: 'aborted' };
    if (latest?.value.stale && options.resync && !resynced.has(latest.runId)) {
      resynced.add(latest.runId);
      send(options.resync(latest.runId));
    }
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }
  const off = runs.subscribe(update);
  update();

  function abort() {
    for (const run of runs.list()) runs.abort(run.runId);
  }

  return {
    client,
    runs,
    run(input = {}, runOptions) {
      abort();
      const runId = randomId();
      base = { ...snapshot, messages: [...snapshot.messages, ...(input.messages ?? [])] };
      runs.start(
        {
          threadId,
          runId,
          state: base.state,
          messages: base.messages,
          tools: input.tools ?? [],
          context: input.context ?? [],
          forwardedProps: input.forwardedProps ?? {}
        },
        { runId, initial: { ...base, status: 'running' }, policy: runOptions?.policy }
      );
      return runId;
    },
    abort,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      off();
      runs.dispose();
    }
  };
}
