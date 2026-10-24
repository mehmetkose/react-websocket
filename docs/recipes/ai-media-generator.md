---
title: 'Build an AI image and video generator with React and WebSockets'
description: 'A generation studio over one WebSocket: queued jobs with live progress and previews, a gallery synced across tabs and devices, jobs that keep going through reconnects and reloads, and cancelling.'
---

# Build an AI image and video generator

This guide builds a generation studio: the user types a prompt, picks an image or a video, and watches it come to life. An image takes seconds and a video takes minutes, so most of what the app does happens while the user waits, and while they leave:

1. **Jobs wait their turn.** GPUs, or a provider's concurrency limit, are scarce. A job waits in a queue, and the user should see where it is.
2. **Progress is the product.** A percentage and a preview every few steps make a two-minute wait bearable.
3. **Jobs outlive the page.** The user reloads, switches tabs, closes the laptop. The job keeps going, and the page picks it up again, at the percentage it reached.
4. **One gallery everywhere.** A job started on a phone shows up on the laptop, live.
5. **Cancelling frees the slot.** A job nobody wants should stop using the GPU at once.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `live.ts` | The browser | The connection, the jobs and the gallery |
| `Studio.tsx` | The browser | The page |
| `server.ts` | Node | The queue, the jobs and the gallery |
| `provider.ts` | Node | The model that generates, behind one function |

## The protocol

Each job's events are numbered, so a page can ask for the ones it missed. The gallery comes as a list when the socket opens, then as one job at a time when a job is created or changes:

```ts
// protocol.ts: imported by the browser and the server.
export type Kind = 'image' | 'video';

export type Job = {
  runId: string;
  prompt: string;
  kind: Kind;
  status: 'working' | 'done' | 'failed' | 'cancelled';
  url?: string;
};

/** A job's events. `offset` counts from 1 in each job. */
export type JobEvent =
  | { type: 'queued'; runId: string; offset: number; position: number }
  | { type: 'progress'; runId: string; offset: number; percent: number; preview?: string }
  | { type: 'finished'; runId: string; offset: number; url: string }
  | { type: 'failed'; runId: string; offset: number; error: string };

export type MediaIn =
  | JobEvent
  // Every job the user has, sent when the socket opens.
  | { type: 'jobs'; jobs: Job[] }
  // A job that was created or changed, from any tab or device.
  | { type: 'job'; job: Job };

export type MediaOut =
  | { type: 'generate'; runId: string; prompt: string; kind: Kind }
  | { type: 'resume'; runId: string; after?: number }
  | { type: 'cancel'; runId: string };
```

Previews and results are URLs, not image data. A message stays a few hundred bytes, and the browser loads only the images it shows.

## The client

```ts
// live.ts
import { createWebSocket, createWebSocketRuns, createWebSocketState } from 'react-websocket';
import type { Job, Kind, MediaIn, MediaOut } from './protocol';

// On the same site as the app, so the session cookie authenticates the socket.
const url = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/media`;

export const media = createWebSocket<MediaIn, MediaOut>(url, {
  json: true,
  // A video takes minutes, with quiet stretches between progress events. A ping every 25 s keeps
  // proxies from closing the connection as idle; no answer within 10 s means it's dead.
  heartbeat: { interval: 25_000, pong: 'pong', timeout: 10_000 }
});

export type Progress = { position?: number; percent: number; preview?: string };

export const jobs = createWebSocketRuns(media, {
  name: 'jobs',
  start: ({ prompt, kind }: { prompt: string; kind: Kind }, runId) => ({
    type: 'generate',
    runId,
    prompt,
    kind
  }),
  resume: (runId, after) => ({ type: 'resume', runId, after }),
  cancel: runId => ({ type: 'cancel', runId }),
  event: message =>
    message.type === 'queued' ||
    message.type === 'progress' ||
    message.type === 'finished' ||
    message.type === 'failed'
      ? message
      : undefined,
  done: message => message.type === 'finished',
  error: message => (message.type === 'failed' ? new Error(message.error) : undefined),
  initial: { percent: 0 } as Progress,
  reduce: (progress, message) => {
    if (message.type === 'queued') return { ...progress, position: message.position };
    if (message.type === 'progress') {
      return { percent: message.percent, preview: message.preview ?? progress.preview };
    }
    return { ...progress, percent: 100 };
  }
});

/** A job, and whether the server has confirmed it yet. */
export type Card = Job & { unconfirmed?: boolean };

export const gallery = createWebSocketState(media, {
  initialState: [] as Card[],
  reduce: (cards, message) => {
    if (message.type === 'jobs') {
      // Keep the jobs started here that the server hasn't heard of yet, such as one sent
      // while offline: the server's list comes before the queued `generate`.
      const unconfirmed = cards.filter(
        card => card.unconfirmed && !message.jobs.some(job => job.runId === card.runId)
      );
      return [...unconfirmed, ...message.jobs];
    }
    if (message.type === 'job') {
      const { job } = message;
      return cards.some(card => card.runId === job.runId)
        ? cards.map(card => (card.runId === job.runId ? job : card))
        : [job, ...cards];
    }
    return cards;
  }
});

export function generate(prompt: string, kind: Kind) {
  const runId = jobs.start({ prompt, kind });
  gallery.setState(cards => [
    { runId, prompt, kind, status: 'working', unconfirmed: true },
    ...cards
  ]);
}
```

- **The heartbeat** matters more here than in most apps. Between two progress events of a video, nothing may cross the socket for a while, and proxies and load balancers close connections that look idle, often after 60 seconds. The server answers `ping` with `pong`. See [Heartbeats](../guide/reconnecting.md#heartbeats).
- **`jobs`** makes each job a [resumable run](../guide/agents.md#resumable-runs) with the default `keep` policy: the job carries on when the connection drops or the page reloads, and the client asks for the events it missed. The run's id is the job's id, and the server starts each id once, so a `generate` sent twice, by a reconnect or a double click, makes one job.
- **`gallery`** is the server's list of jobs, kept up to date by `job` messages. [`createWebSocketState`](../api/create-websocket-state.md) reduces them, and `setState` adds a card the moment the user clicks Generate, before the server has heard of it.
- **The server's list comes first** on every connection, ahead of anything the client queued while offline. The reducer keeps the cards it hasn't confirmed, so a job started offline doesn't blink out of the gallery when the socket opens.

## The page

```tsx
// Studio.tsx
import { useState } from 'react';
import { useAgentRun, useWebSocketState } from 'react-websocket';
import { gallery, generate, jobs, type Card } from './live';
import type { Kind } from './protocol';

export function Studio() {
  const cards = useWebSocketState(gallery);
  return (
    <main>
      <PromptForm />
      <ul className="gallery">
        {cards.map(card => (
          <li key={card.runId}>
            <JobCard card={card} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function PromptForm() {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<Kind>('image');
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        if (!prompt.trim()) return;
        generate(prompt, kind);
        setPrompt('');
      }}
    >
      <input value={prompt} onChange={event => setPrompt(event.target.value)} />
      <select value={kind} onChange={event => setKind(event.target.value as Kind)}>
        <option value="image">Image</option>
        <option value="video">Video</option>
      </select>
      <button>Generate</button>
    </form>
  );
}

function JobCard({ card }: { card: Card }) {
  // Follow the job's events only while it's working. A finished job is in the gallery.
  const run = useAgentRun(jobs, card.status === 'working' ? card.runId : null);

  if (card.status === 'done' && card.url) {
    return card.kind === 'video' ? (
      <video src={card.url} controls aria-label={card.prompt} />
    ) : (
      <img src={card.url} alt={card.prompt} loading="lazy" />
    );
  }
  if (card.status === 'cancelled' || run?.status === 'aborted') return <p>Cancelled</p>;
  if (card.status === 'failed' || run?.status === 'error') {
    return (
      <p role="alert">
        Failed. <button onClick={() => generate(card.prompt, card.kind)}>Try again</button>
      </p>
    );
  }

  const progress = run?.value;
  return (
    <figure>
      {progress?.preview && <img src={progress.preview} alt="" />}
      <figcaption>
        {card.prompt}
        <br />
        {progress?.position
          ? `Waiting: number ${progress.position} in the queue`
          : `Generating… ${progress?.percent ?? 0}%`}
      </figcaption>
      <progress max={100} value={progress?.percent ?? 0} />
      <button onClick={() => jobs.abort(card.runId)}>Cancel</button>
    </figure>
  );
}
```

- **A working card follows its job** with [`useAgentRun`](../api/use-agent-run.md). A job this page started is already followed. One from another tab or device, or from before a reload, is attached when its card mounts and followed from its first event, so it shows the latest percentage and preview at once.
- **A finished card** shows the result from the gallery, and stops following.
- **Cancel** calls `jobs.abort()`, which sends `cancel`. The server frees the slot, and every other tab and device shows the card as cancelled.
- **Try again** starts a new job with the same prompt.

### Telling the user it's done

A video can finish while the user is in another tab. Count the jobs that finish while the page is hidden, in the title:

```ts
// notify.ts: count the jobs that finish while the tab is in the background.
import { media } from './live';

const title = document.title;
let finished = 0;

media.on('message', message => {
  if (message.type !== 'job' || message.job.status !== 'done' || !document.hidden) return;
  finished++;
  document.title = `(${finished}) ${title}`;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  finished = 0;
  document.title = title;
});
```

A `message` listener runs in a background tab too. The gallery store does as well, but a store created with `batch: 'frame'` would wait for the tab to be visible, since browsers pause animation frames in background tabs.

## The server

The server keeps the queue, the jobs and each job's events. It runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name. Everything lives in memory here. Keep the jobs in your database, and with more than one server process, the queue in a shared one too.

### Jobs and their events

```ts
// server.ts
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { userFromCookie } from './auth.ts';
import { simulated as provider } from './provider.ts';
import type { Job, JobEvent, MediaIn, MediaOut } from './protocol.ts';

const SLOTS = 2; // jobs generating at once: your GPUs, or your provider's concurrency limit

type Run = {
  job: Job;
  userId: string;
  events: JobEvent[]; // every event so far, to send again
  sockets: Set<WebSocket>; // the connections following it
  controller: AbortController;
  position: number; // in the queue, or 0
};

const jobsByUser = new Map<string, Job[]>(); // use your database
const runs = new Map<string, Run>();
const queue: Run[] = []; // waiting for a slot, oldest first
const connections = new Map<string, Set<WebSocket>>(); // each user's open sockets
let working = 0;

function send(socket: WebSocket, message: MediaIn) {
  socket.send(JSON.stringify(message));
}

const next = (run: Run) => ({ runId: run.job.runId, offset: run.events.length + 1 });

function emit(run: Run, event: JobEvent) {
  run.events.push(event);
  for (const socket of run.sockets) send(socket, event);
}

/** Show the job's card as it is now, in every tab and on every device of its user. */
function publish(run: Run) {
  const message: MediaIn = { type: 'job', job: run.job };
  for (const socket of connections.get(run.userId) ?? []) send(socket, message);
}

function follow(run: Run, socket: WebSocket, after = 0) {
  for (const event of run.events.slice(after)) send(socket, event);
  if (run.job.status === 'working') run.sockets.add(socket);
}

function finish(run: Run, status: Job['status'], event: JobEvent) {
  run.job.status = status;
  publish(run);
  emit(run, event);
  run.sockets.clear();
  // Keep the events a while for a client that comes back late, then forget them.
  setTimeout(() => runs.delete(run.job.runId), 10 * 60_000);
}
```

`finish` publishes the job before its last event, so a card already shows the result when its run ends.

### The queue

```ts
/** Start jobs while there are free slots, and tell the waiting ones where they are. */
function pump() {
  while (working < SLOTS && queue.length) {
    const run = queue.shift()!;
    run.position = 0;
    working++;
    void runJob(run).finally(() => {
      working--;
      pump();
    });
  }
  queue.forEach((run, index) => {
    if (run.position === index + 1) return;
    run.position = index + 1;
    emit(run, { type: 'queued', ...next(run), position: run.position });
  });
}

async function runJob(run: Run) {
  let reported = -Infinity;
  try {
    const url = await provider.generate(run.job, {
      signal: run.controller.signal,
      onProgress: (percent, preview) => {
        // Every 5 % or with a new preview, not every step: after a reload, a job's events are
        // sent again from the first one.
        if (percent - reported < 5 && !preview) return;
        reported = percent;
        emit(run, { type: 'progress', ...next(run), percent: Math.round(percent), preview });
      }
    });
    run.job.url = url;
    finish(run, 'done', { type: 'finished', ...next(run), url });
  } catch (error) {
    if (run.controller.signal.aborted) {
      // Ends it in the other tabs following it. The one that cancelled it ignores this.
      finish(run, 'cancelled', { type: 'failed', ...next(run), error: 'Cancelled.' });
    } else {
      console.error(error);
      finish(run, 'failed', { type: 'failed', ...next(run), error: 'Generation failed.' });
    }
  }
}

function start(socket: WebSocket, userId: string, message: MediaOut & { type: 'generate' }) {
  const { runId, prompt, kind } = message;
  const job: Job = { runId, prompt, kind, status: 'working' };
  const list = jobsByUser.get(userId) ?? [];
  jobsByUser.set(userId, [job, ...list]);

  const run: Run = {
    job,
    userId,
    events: [],
    sockets: new Set([socket]),
    controller: new AbortController(),
    position: 0
  };
  runs.set(runId, run);
  publish(run);
  queue.push(run);
  pump();
}

function cancel(run: Run) {
  if (run.job.status !== 'working') return;
  const index = queue.indexOf(run);
  if (index < 0) return run.controller.abort(); // generating: runJob() finishes it
  queue.splice(index, 1);
  finish(run, 'cancelled', { type: 'failed', ...next(run), error: 'Cancelled.' });
  pump();
}
```

- **Positions** go out only when they change, so a long queue doesn't send every waiting job a message every time one starts.
- **Progress** goes out every 5 %, or with a new preview. A page that follows a job from its start gets every event again, so the count of events per job should stay small: about two dozen here, however long the video.
- **A cancelled job** ends with a `failed` event, so other tabs that follow it stop too. The gallery shows it as cancelled, not failed, from the job's status.

### The connection

```ts
const isString = (value: unknown) => typeof value === 'string';

/** A client's message, if it's JSON with the fields its type needs. */
function parse(data: string): MediaOut | undefined {
  try {
    const message = JSON.parse(data);
    const type = message?.type;
    if (
      type === 'generate' &&
      isString(message.runId) &&
      isString(message.prompt) &&
      (message.kind === 'image' || message.kind === 'video')
    )
      return message;
    if (type === 'resume' && isString(message.runId) && Number.isInteger(message.after ?? 0))
      return message;
    if (type === 'cancel' && isString(message.runId)) return message;
  } catch {
    // Not JSON.
  }
  return undefined;
}

function connected(socket: WebSocket, userId: string) {
  const sockets = connections.get(userId) ?? new Set();
  connections.set(userId, sockets.add(socket));
  send(socket, { type: 'jobs', jobs: jobsByUser.get(userId) ?? [] });
  socket.on('error', console.error);

  socket.on('message', data => {
    if (String(data) === 'ping') return socket.send('pong');
    const message = parse(String(data));
    if (!message) return socket.close(1003, 'Invalid message');
    const found = runs.get(message.runId);
    const run = found?.userId === userId ? found : undefined;

    switch (message.type) {
      case 'generate':
        // Sent again on every connection until the first event arrives: start each job once.
        if (run) follow(run, socket);
        else if (!found) start(socket, userId, message);
        break;
      case 'resume':
        if (run) follow(run, socket, message.after);
        else {
          const offset = (message.after ?? 0) + 1;
          send(socket, { type: 'failed', runId: message.runId, offset, error: 'Unknown job.' });
        }
        break;
      case 'cancel':
        if (run) cancel(run);
        break;
    }
  });

  socket.on('close', () => {
    sockets.delete(socket);
    for (const run of runs.values()) run.sockets.delete(socket);
  });
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, stream, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // Any site can open a socket to yours with the user's cookies: check where it comes from.
  if (url.pathname !== '/media' || request.headers.origin !== process.env.APP_ORIGIN) {
    return stream.destroy();
  }
  const userId = await userFromCookie(request.headers.cookie);
  wss.handleUpgrade(request, stream, head, socket => {
    if (userId) connected(socket, userId);
    else socket.close(1008, 'Unauthorized'); // the client doesn't retry 1008
  });
});

server.listen(Number(process.env.PORT ?? 8080));
```

The socket is on the same site as the app, so the browser sends the session cookie with the handshake, and `userFromCookie` is the check your app already does for every request. WebSockets aren't covered by CORS, so the `Origin` check is what stops another site from opening a socket with your user's cookies. See [Cookies](../guide/authentication.md#cookies).

`parse` checks every message before the server uses it: JSON, a known `type`, and the fields that type needs. Anything else closes only that socket, with `1003`, which the client doesn't retry. An error thrown in the listener would stop the server, and every user's jobs with it.

### The provider

Everything about the model is behind one function: generate, report progress, return a URL. In development, a stand-in is enough:

```ts
// provider.ts
import { setTimeout as sleep } from 'node:timers/promises';
import type { Kind } from './protocol.ts';

export type Provider = {
  /** Generate the media, report progress, and resolve with its URL. */
  generate(
    job: { prompt: string; kind: Kind },
    options: { signal: AbortSignal; onProgress: (percent: number, preview?: string) => void }
  ): Promise<string>;
};

/** A stand-in for development: a step every 250 ms, and a preview every fifth step. */
export const simulated: Provider = {
  async generate({ prompt, kind }, { signal, onProgress }) {
    const steps = kind === 'video' ? 60 : 20;
    for (let step = 1; step <= steps; step++) {
      await sleep(250, undefined, { signal });
      const percent = (step / steps) * 100;
      onProgress(percent, step % 5 === 0 ? picture(`${Math.round(percent)}%`) : undefined);
    }
    return picture(prompt);
  }
};
```

`picture()` draws its text into an SVG data URL. A hosted model usually takes a job, then reports on it when you ask, or calls a webhook. Either way, call `onProgress` as reports come in, and pass `signal` on, so a cancel reaches the provider:

```ts
// polled.ts: a provider you poll for progress.
import { setTimeout as sleep } from 'node:timers/promises';
import { api, copyToStorage } from './storage-and-api.ts'; // your provider's client, your storage
import type { Provider } from './provider.ts';

export const polled: Provider = {
  async generate(job, { signal, onProgress }) {
    const { id } = await api.create(job, { signal });
    signal.addEventListener('abort', () => void api.cancel(id), { once: true });
    for (;;) {
      await sleep(1000, undefined, { signal });
      const status = await api.get(id, { signal });
      // Result URLs from providers often expire: keep your own copy.
      if (status.state === 'succeeded') return copyToStorage(status.url);
      if (status.state === 'failed') throw new Error(status.error);
      onProgress(status.percent, status.preview);
    }
  }
};
```

With webhooks, keep the `onProgress` of each job in a map by the provider's id, and call it from the webhook's handler. Store the provider's id with the job, too: after a server restart, it's how you find the job again.

## When things go wrong

| What happens | What the user sees | Why |
| --- | --- | --- |
| The connection drops | The card pauses, then jumps to the latest percentage | `jobs` sends `resume` with the last offset it got, and `follow` sends what it missed |
| The user reloads | The card shows the latest percentage and preview at once, and keeps going | The run was remembered in `sessionStorage`, and followed again from its first event |
| They start a job while offline | The card at once, "Generating… 0%", then the job starts when the connection is back | `setState` adds the card. The `generate` waits in the send queue, and the reducer keeps the card through the server's list |
| They open the studio on their phone | Every job, with the working ones live | The server's list, then `useAgentRun` attaches each working job |
| They cancel on the phone | The laptop's card says "Cancelled" | `publish` updates every device, and the `failed` event ends the other runs |
| The connection goes quiet for minutes | Nothing | The heartbeat keeps proxies from closing it. A connection that died is found at the next ping, and the client reconnects |
| A job finishes in a background tab | "(1)" in the tab's title | The `message` listener in `notify.ts` |

In Chrome, against the server on this page with the stand-in provider: three images started at once showed two generating and one "number 1 in the queue". A video reloaded at 8 % came back at 17 % and kept going. A job started while the server was down showed its card right away, and generated once the server was back. A video cancelled from a second browser profile, logged in as the same user, showed "Cancelled" in the first, and its run there ended.

## Testing it

Swap the provider: the stand-in makes every state reachable in seconds, and a test can give it a different speed or make it fail. To exercise the client against network faults, wrap the socket in [`react-websocket/chaos`](../guide/chaos.md) and drop the connection while a video generates.

## See also

- [Build an AI chatbot](./ai-chatbot.md): the same resumable runs for streamed text, with tools and approvals
- [AI agents](../guide/agents.md#resumable-runs), [`createWebSocketRuns`](../api/create-websocket-runs.md), [`useAgentRun`](../api/use-agent-run.md)
- [Message state](../guide/state.md) and [`createWebSocketState`](../api/create-websocket-state.md)
- [Heartbeats](../guide/reconnecting.md#heartbeats) and [Authentication](../guide/authentication.md)
