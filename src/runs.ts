import { createWebSocketFeeds } from './feeds';
import type { WebSocketClient } from './types';

/**
 * What happens to a run when its connection drops: `keep` resumes it on the next connection,
 * for agents that keep working in the background; `cancel` aborts it and tells the server, for
 * a chat answer nobody may be waiting for.
 */
export type RunPolicy = 'keep' | 'cancel';

/** Where a run is: streaming events, or ended. */
export type RunStatus = 'streaming' | 'done' | 'error' | 'aborted';

/** A run's state, reduced from its events. A new object on every change. */
export interface AgentRun<T> {
  readonly runId: string;
  readonly status: RunStatus;
  /** Reduced from the run's events with `reduce`, starting from `initial`. */
  readonly value: T;
  /** What `error` returned for the event that ended the run, when `status` is `'error'`. */
  readonly error: unknown;
}

/** The subset of `Storage` that runs use, so `sessionStorage`, `localStorage` or your own fits. */
export type RunStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Options for {@link createWebSocketRuns}: the messages your server expects and sends. */
export interface WebSocketRunsOptions<Req, T, In, Out> {
  /** Names the runs' entry in `storage`, `react-websocket-runs:<name>`. */
  name: string;
  /**
   * The message that starts a run, with its `runId`. Sent again on a new connection until the
   * run's first event arrives, so the server should start a run only once per `runId`.
   * Annotate `request`: that's what `runs.start()` accepts.
   */
  start: (request: Req, runId: string) => Out;
  /**
   * The message that asks for a run's events after `after`, its last event received, or from
   * the beginning when `after` is `undefined` (after a reload, or for `attach()`). Sent on every
   * new connection while the run is streaming.
   */
  resume: (runId: string, after: number | undefined) => Out;
  /** The message that stops a run, sent by `abort()` and for runs whose policy is `cancel`. */
  cancel?: (runId: string) => Out;
  /**
   * Recognize a run's event: its `runId`, and its `offset`, one more than the event before it.
   * `undefined` for any other message.
   */
  event: (message: In) => { readonly runId: string; readonly offset: number } | null | undefined;
  /** Whether an event is the run's last. The run is `'done'` after reducing it. */
  done?: (message: In) => boolean;
  /** Recognize an event that ends the run with an error: return it, or `undefined`. */
  error?: (message: In) => unknown;
  /** A run's value before its first event. */
  initial: T;
  /** Fold an event into a run's value. Pure. */
  reduce: (value: T, message: In) => T;
  /** @default 'keep' */
  policy?: RunPolicy;
  /**
   * Where to remember streaming runs, so a reload resumes them.
   * @default sessionStorage, where it exists. `null` remembers nothing.
   */
  storage?: RunStorage | null;
}

/** Runs that stream events and survive reconnects and reloads. Create with {@link createWebSocketRuns}. */
export interface WebSocketRuns<Req, T> {
  /** The client the runs stream on. */
  readonly client: WebSocketClient<any, any>;
  /**
   * Start a run and return its `runId`. The start message is sent as soon as the socket is
   * open, and the run is remembered until it ends. `initial` overrides the `initial` option for
   * this run. A `runId` it already knows, streaming or ended, starts nothing: the server starts
   * a run only once per id. `delete()` it first to use the id again.
   */
  start(request: Req, options?: { runId?: string; policy?: RunPolicy; initial?: T }): string;
  /**
   * Follow a run started elsewhere, such as in another tab or before a reload, from its first
   * event. Does nothing for a run it already knows.
   */
  attach(runId: string, options?: { policy?: RunPolicy; initial?: T }): void;
  /** Stop a streaming run: send `cancel`, and make it `'aborted'`. */
  abort(runId: string): void;
  /** A run's state, or `undefined` for one it doesn't know. The same object until it changes. */
  get(runId: string): AgentRun<T> | undefined;
  /** Every run it knows, oldest first. A new array on every change. */
  list(): readonly AgentRun<T>[];
  /** Get notified when a run changes. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Forget a run, aborting it first if it's streaming. */
  delete(runId: string): void;
  /**
   * Forget every run, e.g. on logout or when another user signs in: their values, unsent start
   * requests and pending cancels, here and in `storage`. Sends nothing, so nothing of the
   * previous user's goes out on a later connection; `abort()` runs that should stop on the
   * server first, while connected.
   */
  clear(): void;
  /** Stop following runs, and release the connection. Remembered runs stay remembered. */
  dispose(): void;
}

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

// How long a page waits for another to say it's following a run found in storage, before
// cancelling it. A duplicated tab, or one opened with `window.open`, gets a copy of
// `sessionStorage` while the page that started the run is still following it.
const CLAIM_WAIT = 200;

function defaultStorage(): RunStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Reading `sessionStorage` throws where storage is blocked, e.g. some sandboxed iframes.
    return null;
  }
}

/**
 * Stream runs, such as an AI agent's answer, that survive reconnects and page reloads.
 *
 * - `start(request)` sends `start(request, runId)` and follows the run's events, folding them
 *   into its value with `reduce`.
 * - Each event carries an `offset`. On a new connection, a streaming run sends
 *   `resume(runId, after)` with the last offset received, so the server sends what was missed,
 *   and duplicates are dropped.
 * - Streaming runs are remembered in `sessionStorage`. After a reload they're followed again from
 *   their first event, rebuilding the value, so `list()` or `useAgentRun` can show them.
 * - A run whose policy is `cancel` is aborted when its connection drops, and `cancel` is sent
 *   first thing on the next one.
 *
 * Built on `createWebSocketFeeds`, with each run a topic. While runs are streaming, it holds
 * the client's connection.
 *
 * @example
 * ```ts
 * export const runs = createWebSocketRuns(agent, {
 *   name: 'chat',
 *   start: (prompt: string, runId) => ({ type: 'run', runId, prompt }),
 *   resume: (runId, after) => ({ type: 'resume', runId, after }),
 *   cancel: runId => ({ type: 'cancel', runId }),
 *   event: message => (message.type === 'token' || message.type === 'done' ? message : undefined),
 *   done: message => message.type === 'done',
 *   initial: '',
 *   reduce: (text, message) => text + message.text
 * });
 *
 * const runId = runs.start('Summarize this thread');
 * ```
 */
// `NoInfer`: take `In` and `Out` from the client only; `Req` comes from how `start` annotates
// its parameter, and `T` from `initial`.
export function createWebSocketRuns<Req, T, In, const Out>(
  client: WebSocketClient<In, Out>,
  options: WebSocketRunsOptions<Req, T, NoInfer<In>, NoInfer<Out>>
): WebSocketRuns<Req, T> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const key = `react-websocket-runs:${options.name}`;
  const runs = new Map<string, AgentRun<T>>();
  // Start requests not yet answered by an event, sent again on a new connection.
  const starting = new Map<string, Req>();
  const policies = new Map<string, RunPolicy>();
  const releases = new Map<string, () => void>();
  // Cancels waiting for the next connection, each with a way to take it back.
  const cancels = new Set<() => void>();
  const listeners = new Set<() => void>();
  let list: readonly AgentRun<T>[] = [];

  const feeds = createWebSocketFeeds(client, {
    subscribe: (runId, after) =>
      after === undefined && starting.has(runId)
        ? options.start(starting.get(runId)!, runId)
        : options.resume(runId, after),
    sequence: message => {
      const event = options.event(message);
      return event && { topic: event.runId, seq: event.offset };
    }
  });

  function read(): Record<string, RunPolicy> {
    try {
      return JSON.parse(storage?.getItem(key) ?? '{}') as Record<string, RunPolicy>;
    } catch {
      return {};
    }
  }

  function remember(runId: string, policy: RunPolicy | undefined) {
    if (!storage) return;
    const stored = read();
    if (policy) stored[runId] = policy;
    else delete stored[runId];
    try {
      if (Object.keys(stored).length) storage.setItem(key, JSON.stringify(stored));
      else storage.removeItem(key);
    } catch {
      // Full or blocked: the run still streams, but won't survive a reload.
    }
  }

  function set(runId: string, patch: Partial<AgentRun<T>>) {
    const run = runs.get(runId);
    runs.set(runId, {
      ...(run ?? { runId, status: 'streaming', value: options.initial, error: undefined }),
      ...patch
    });
    list = [...runs.values()];
    for (const listener of [...listeners]) listener();
  }

  /** Stop following a run that ended. */
  function end(runId: string, patch: Partial<AgentRun<T>>) {
    releases.get(runId)?.();
    releases.delete(runId);
    starting.delete(runId);
    policies.delete(runId);
    remember(runId, undefined);
    set(runId, patch);
  }

  function follow(runId: string, policy: RunPolicy, value = options.initial) {
    policies.set(runId, policy);
    remember(runId, policy);
    set(runId, { value });
    releases.set(runId, feeds.acquire(runId));
  }

  function cancel(runId: string) {
    const message = options.cancel;
    if (!message) return;
    if (client.socket?.readyState === 1) return void client.send(message(runId));
    // Not through the queue, which `queue: false` turns off: hold the connection, and send it
    // from an `open` listener, ahead of anything queued.
    const release = client.acquire();
    const drop = () => {
      cancels.delete(drop);
      off();
      release();
    };
    const off = client.on('open', () => {
      cancels.delete(drop);
      off();
      client.send(message(runId));
      release();
    });
    cancels.add(drop);
  }

  function abort(runId: string) {
    if (runs.get(runId)?.status !== 'streaming') return;
    cancel(runId);
    end(runId, { status: 'aborted' });
  }

  let status = client.getSnapshot().status;
  const offs = [
    feeds.on('message', message => {
      const event = options.event(message);
      if (!event || runs.get(event.runId)?.status !== 'streaming') return;
      const { runId } = event;
      starting.delete(runId);
      const error = options.error?.(message);
      if (error !== undefined) return end(runId, { status: 'error', error });
      const value = options.reduce(runs.get(runId)!.value, message);
      if (options.done?.(message)) end(runId, { status: 'done', value });
      else set(runId, { value });
    }),
    client.subscribe(() => {
      const previous = status;
      status = client.getSnapshot().status;
      if (previous !== 'open' || status === 'open') return;
      // The connection dropped: runs that shouldn't outlive it stop here.
      for (const [runId, policy] of policies) if (policy === 'cancel') abort(runId);
    }),
    feeds.dispose
  ];

  // Pages using the same storage say which runs they follow, so a copy of it doesn't cancel them.
  // Not on a server, where an open channel would keep the process alive.
  const channel =
    storage && typeof window !== 'undefined' && typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(key)
      : undefined;
  const claimed = new Set<string>();
  if (channel) {
    channel.onmessage = ({ data }: MessageEvent<{ who?: string; mine?: string } | null>) => {
      if (data?.mine) claimed.add(data.mine);
      else if (data?.who && policies.has(data.who)) channel.postMessage({ mine: data.who });
    };
    offs.push(() => channel.close());
  }

  // Runs that were streaming before a reload: follow them again, or stop those that shouldn't
  // outlive their page, unless another page still follows them.
  const stale: string[] = [];
  for (const [runId, policy] of Object.entries(read())) {
    if (policy !== 'cancel') follow(runId, policy);
    else if (channel) {
      stale.push(runId);
      channel.postMessage({ who: runId });
    } else {
      cancel(runId);
      remember(runId, undefined);
    }
  }
  if (stale.length) {
    const timer = setTimeout(() => {
      for (const runId of stale) {
        if (claimed.has(runId) || policies.has(runId)) continue;
        cancel(runId);
        remember(runId, undefined);
      }
    }, CLAIM_WAIT);
    offs.push(() => clearTimeout(timer));
  }

  return {
    client,
    start(request, { runId = randomId(), policy = options.policy ?? 'keep', initial } = {}) {
      if (runs.has(runId)) return runId;
      starting.set(runId, request);
      follow(runId, policy, initial);
      return runId;
    },
    attach(runId, { policy = options.policy ?? 'keep', initial } = {}) {
      if (!runs.has(runId)) follow(runId, policy, initial);
    },
    abort,
    get: runId => runs.get(runId),
    list: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    delete(runId) {
      abort(runId);
      if (runs.delete(runId)) {
        list = [...runs.values()];
        for (const listener of [...listeners]) listener();
      }
    },
    clear() {
      for (const release of releases.values()) release();
      releases.clear();
      for (const drop of [...cancels]) drop();
      // Runs found in storage that would be cancelled once nobody claims them.
      stale.length = 0;
      starting.clear();
      policies.clear();
      try {
        storage?.removeItem(key);
      } catch {
        // Blocked storage: nothing was remembered there.
      }
      if (!runs.size) return;
      runs.clear();
      list = [];
      for (const listener of [...listeners]) listener();
    },
    dispose() {
      for (const release of releases.values()) release();
      releases.clear();
      for (const off of offs) off();
    }
  };
}
