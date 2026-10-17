import {
  createElement as h,
  useEffect,
  useReducer,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement
} from 'react';
// Types only: the built entry imports nothing from the library at runtime.
import type { Latency, Status, WebSocketClient } from './core';

/** Props for {@link WebSocketDevtools}. */
export interface WebSocketDevtoolsProps {
  /**
   * What to show: clients from `createWebSocket`, and the topics, feeds, latency trackers,
   * outboxes, presence and runs created on them, which are shown with their client. The clients
   * `useWebSocket(url)` shares are listed by themselves, in development.
   */
  sources?: readonly unknown[];
  /** Start with the panel open. @default false */
  open?: boolean;
  /** Which corner of the window it sits in. @default 'bottom-right' */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
}

type AnyClient = WebSocketClient<any, any>;

interface Row {
  client: AnyClient;
  topics: string[];
  feeds: string[];
  latency?: Latency;
  waiting?: number;
  peers?: number;
  runs?: string;
}

const INSPECT = Symbol.for('react-websocket.inspect');
const REGISTRY = Symbol.for('react-websocket.registry');

const isClient = (value: any): value is AnyClient =>
  typeof value?.acquire === 'function' && typeof value.send === 'function' && 'socket' in value;

const COLORS: Record<Status, string> = {
  idle: '#9ca3af',
  connecting: '#60a5fa',
  open: '#34d399',
  reconnecting: '#fbbf24',
  closed: '#f87171'
};

/** Every client to show, with what the sources say about it. */
function collect(sources: readonly unknown[]): Row[] {
  const rows = new Map<AnyClient, Row>();
  const row = (client: AnyClient) => {
    if (!rows.has(client)) rows.set(client, { client, topics: [], feeds: [] });
    return rows.get(client)!;
  };
  const shared = (globalThis as Record<symbol, Map<string, AnyClient> | undefined>)[REGISTRY];
  for (const client of shared?.values() ?? []) row(client);
  for (const source of sources as any[]) {
    if (isClient(source)) {
      row(source);
      continue;
    }
    if (!isClient(source?.client)) continue;
    const entry = row(source.client);
    if (typeof source.position === 'function') {
      for (const topic of source.active())
        entry.feeds.push(`${topic} @${source.position(topic) ?? '–'}`);
    } else if (typeof source.active === 'function') entry.topics.push(...source.active());
    else if (typeof source.add === 'function') entry.waiting = source.getSnapshot().length;
    else if (typeof source.leave === 'function') entry.peers = source.getSnapshot().length;
    else if (typeof source.start === 'function' && typeof source.list === 'function') {
      const runs = source.list() as { status: string }[];
      entry.runs = `${runs.filter(run => run.status === 'streaming').length} streaming, ${runs.length} in all`;
    } else if (typeof source.getSnapshot === 'function' && 'rtt' in source.getSnapshot()) {
      entry.latency = source.getSnapshot();
    }
  }
  return [...rows.values()];
}

const panel: CSSProperties = {
  position: 'fixed',
  zIndex: 2147483647,
  font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#e5e7eb',
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 8,
  boxShadow: '0 8px 24px rgb(0 0 0 / 0.3)'
};

const dot = (status: Status): CSSProperties => ({
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: 4,
  marginRight: 6,
  background: COLORS[status]
});

const noopSubscribe = () => () => {};

function Client({ row, received }: { row: Row; received: number }) {
  const { client } = row;
  const { status, attempt } = client.getSnapshot();
  const inspect = (client as unknown as Record<symbol, (() => { queued: number }) | undefined>)[
    INSPECT
  ];
  const facts: [string, string | number][] = [
    ['status', attempt ? `${status} (attempt ${attempt})` : status],
    ['queued', inspect?.().queued ?? '–'],
    ['buffered', `${client.socket?.bufferedAmount ?? 0} B`],
    ['received', received]
  ];
  if (row.latency) {
    const { rtt } = row.latency;
    facts.push(['rtt', rtt === undefined ? '–' : `${Math.round(rtt)} ms`]);
  }
  if (row.waiting !== undefined) facts.push(['outbox', `${row.waiting} waiting`]);
  if (row.peers !== undefined) facts.push(['presence', `${row.peers} peers`]);
  if (row.runs) facts.push(['runs', row.runs]);
  if (row.topics.length) facts.push(['topics', row.topics.join(', ')]);
  if (row.feeds.length) facts.push(['feeds', row.feeds.join(', ')]);
  const url = typeof client.url === 'string' ? client.url : (client.socket?.url ?? 'url()');
  return h(
    'section',
    { style: { padding: '8px 12px', borderTop: '1px solid #374151' } },
    h(
      'div',
      { style: { fontWeight: 600, wordBreak: 'break-all' } },
      h('span', { style: dot(status) }),
      url
    ),
    h(
      'dl',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '2px 12px',
          margin: '6px 0 0'
        }
      },
      facts.flatMap(([name, value]) => [
        h('dt', { key: `${name}-t`, style: { color: '#9ca3af' } }, name),
        h('dd', { key: `${name}-d`, style: { margin: 0, wordBreak: 'break-all' } }, String(value))
      ])
    )
  );
}

/**
 * A panel in a corner of the page that shows each WebSocket client: its status and attempts,
 * what's queued and buffered, how many messages it received, and the round-trip time, topics,
 * feeds, outbox, presence and runs of the `sources` that use it. For development: render it only
 * there, for example behind `import.meta.env.DEV`.
 *
 * @example
 * ```tsx
 * import { WebSocketDevtools } from 'react-websocket/devtools';
 *
 * {import.meta.env.DEV && <WebSocketDevtools sources={[live, topics, latency]} />}
 * ```
 */
export function WebSocketDevtools({
  sources = [],
  open: initiallyOpen = false,
  position = 'bottom-right'
}: WebSocketDevtoolsProps): ReactElement | null {
  const [open, setOpen] = useState(initiallyOpen);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [received] = useState(() => new WeakMap<AnyClient, number>());
  // Nothing on the server, so hydration matches.
  const browser = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
  const rows = browser ? collect(sources) : [];
  const clients = rows.map(row => row.client);

  // Refresh twice a second: what it shows changes faster than it's worth re-rendering for.
  useEffect(() => {
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, []);
  // After every render, count the messages of clients that appeared since, such as a URL that
  // a component started using.
  const [listening] = useState(() => new Map<AnyClient, () => void>());
  useEffect(() => {
    for (const client of clients) {
      if (listening.has(client)) continue;
      listening.set(
        client,
        client.on('message', () => received.set(client, (received.get(client) ?? 0) + 1))
      );
    }
  });
  useEffect(
    () => () => {
      for (const off of listening.values()) off();
      listening.clear();
    },
    [listening]
  );

  if (!browser) return null;
  const [vertical, horizontal] = position.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const worst = (['closed', 'reconnecting', 'connecting', 'open', 'idle'] as Status[]).find(
    status => clients.some(client => client.getSnapshot().status === status)
  );
  return h(
    'div',
    { style: { ...panel, [vertical]: 12, [horizontal]: 12, maxWidth: 420 } },
    h(
      'button',
      {
        type: 'button',
        'aria-expanded': open,
        onClick: () => setOpen(!open),
        style: {
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
          padding: '6px 12px',
          fontWeight: 600
        }
      },
      h('span', { style: dot(worst ?? 'idle') }),
      `WebSocket · ${clients.length} client${clients.length === 1 ? '' : 's'}`
    ),
    open &&
      h(
        'div',
        {
          role: 'region',
          'aria-label': 'WebSocket clients',
          style: { maxHeight: '60vh', overflow: 'auto' }
        },
        rows.length
          ? rows.map((row, i) =>
              h(Client, { key: i, row, received: received.get(row.client) ?? 0 })
            )
          : h('p', { style: { margin: 0, padding: '8px 12px' } }, 'No clients yet.')
      )
  );
}
