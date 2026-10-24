---
title: 'Build an AI chatbot with React and WebSockets'
description: 'A complete AI chat app over one WebSocket: streamed answers that survive reconnects and reloads, a Stop button that stops the model, browser tools and approvals, with a Node server that calls Claude.'
---

# Build an AI chatbot

This guide builds a chat app where Claude answers over a WebSocket. Streaming the text is the easy part. The hard parts come from real networks and real users:

1. **The answer outlives the connection.** Wi-Fi drops, a laptop sleeps, the user reloads. The answer should carry on from where it was, without losing or repeating text.
2. **Stop means stop.** When the user clicks Stop, the model should stop generating, and stop billing for it.
3. **The model needs the browser.** Some questions only the browser can answer, like the user's time zone. Some actions need the user's approval before the server takes them.
4. **Tokens arrive fast.** A render per token re-renders the conversation hundreds of times per answer.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `live.ts` | The browser | The connection, the answers, the history and the browser's tools |
| `Chat.tsx` | The browser | The page |
| `server.ts` | Node | Answers that outlive connections, the history, and questions for the browser |
| `model.ts` | Node | Claude, with two tools |

## The protocol

Three kinds of message share the socket: an answer's events, numbered so the client can ask for what it missed, a request for the history and its reply, and questions from the server that the browser answers.

```ts
// protocol.ts: imported by the browser and the server.
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Set while the answer is still being written. */
  runId?: string;
};

/** An answer's events. `offset` counts from 1 in each run. */
export type RunEvent =
  | { type: 'text'; runId: string; offset: number; text: string }
  | { type: 'tool'; runId: string; offset: number; label: string }
  | { type: 'done'; runId: string; offset: number }
  | { type: 'failed'; runId: string; offset: number; error: string };

export type ChatIn =
  | RunEvent
  | { type: 'history'; id: number; messages: ChatMessage[] }
  | { type: 'call'; id: string; method: string; params: Record<string, string> }
  | { type: 'withdraw'; id: string };

export type ChatOut =
  | { type: 'run'; runId: string; chatId: string; prompt: string }
  | { type: 'resume'; runId: string; after?: number }
  | { type: 'cancel'; runId: string }
  | { type: 'history'; id: number; chatId: string }
  | { type: 'result'; id: number | string; result?: unknown; error?: string };
```

## The client

One client, and a manager for each kind of message:

```ts
// live.ts
import {
  createWebSocket,
  createWebSocketRequests,
  createWebSocketResponder,
  createWebSocketRuns
} from 'react-websocket';
import type { ChatIn, ChatOut } from './protocol';

export const chat = createWebSocket<ChatIn, ChatOut>(
  async () => {
    // A short-lived token for every attempt, from the user's logged-in session.
    const response = await fetch('/api/socket-token', { method: 'POST' });
    if (!response.ok) throw new Error(`No token: HTTP ${response.status}`);
    const { token } = (await response.json()) as { token: string };
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/chat?token=${encodeURIComponent(token)}`;
  },
  { json: true }
);

export type Answer = { text: string; activity?: string };

export const answers = createWebSocketRuns(chat, {
  name: 'answers',
  start: ({ chatId, prompt }: { chatId: string; prompt: string }, runId) => ({
    type: 'run',
    runId,
    chatId,
    prompt
  }),
  resume: (runId, after) => ({ type: 'resume', runId, after }),
  cancel: runId => ({ type: 'cancel', runId }),
  event: message =>
    message.type === 'text' ||
    message.type === 'tool' ||
    message.type === 'done' ||
    message.type === 'failed'
      ? message
      : undefined,
  done: message => message.type === 'done',
  error: message => (message.type === 'failed' ? new Error(message.error) : undefined),
  initial: { text: '' } as Answer,
  reduce: (answer, message) => {
    if (message.type === 'text') return { text: answer.text + message.text };
    if (message.type === 'tool') return { ...answer, activity: message.label };
    return { text: answer.text };
  }
});

export const history = createWebSocketRequests(chat, {
  send: (chatId: string, id) => ({ type: 'history', id, chatId }),
  reply: message => (message.type === 'history' ? message.id : undefined)
});

export const tools = createWebSocketResponder(chat, {
  request: message => (message.type === 'call' ? message : undefined),
  respond: (id, result: unknown) => ({ type: 'result', id, result }),
  error: (id, error) => ({ type: 'result', id, error: String(error) }),
  cancel: message => (message.type === 'withdraw' ? message.id : undefined)
});

// Answered in code: only the browser knows this.
tools.onRequest('get_time_zone', () => Intl.DateTimeFormat().resolvedOptions().timeZone);

// Answered by the user, from <Approval>. Registered here, so a request waits even while no
// dialog is mounted.
tools.onRequest('approve');
```

- **The URL function** runs before every connection attempt, so each one gets a fresh token. `/api/socket-token` is an endpoint in your app that returns a token for the logged-in user, valid for a minute or so. See [Authentication](../guide/authentication.md).
- **`answers`** makes each answer a [resumable run](../guide/agents.md#resumable-runs). After a reconnect it asks the server for the events after the last one it got. After a reload it follows the answer again from its first event. `reduce` builds the text, and shows what the model is doing while it uses a tool.
- **`history`** turns the history request into a promise. It rejects instead of hanging, after 10 seconds or when the connection drops.
- **`tools`** answers the server's questions: the time zone in code, the approval from a dialog.

### Keep or cancel

`answers` uses the default policy, `keep`: when the connection drops, the server keeps writing, and the client picks the answer up again. That's what people expect from a chat app. They come back to the answer. The other policy suits answers nobody comes back for:

| Policy | When the connection drops | When the page reloads | For |
| --- | --- | --- | --- |
| `keep` (default) | The server keeps writing. The client resumes after the last event it got | The new page follows the answer again from its first event | Chat answers, agents that work in the background |
| `cancel` | The client stops the answer, and sends `cancel` first thing on the next connection | The new page sends `cancel` | Expensive answers that are worthless once the user has gone, like autocomplete |

Pass `policy: 'cancel'` to `createWebSocketRuns`, or per answer to `start()`.

## The page

```tsx
// Chat.tsx
import { useEffect, useState } from 'react';
import { useAgentApproval, useAgentRun, useWebSocketStatus } from 'react-websocket';
import { answers, chat, history, tools } from './live';
import type { ChatMessage } from './protocol';

export function Chat({ chatId }: { chatId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    history.request(chatId, { signal: controller.signal }).then(
      reply => reply.type === 'history' && setMessages(reply.messages),
      () => controller.signal.aborted || setFailed(true)
    );
    return () => controller.abort();
  }, [chatId, attempt]);

  function send(prompt: string) {
    const runId = answers.start({ chatId, prompt });
    setMessages(list => [
      ...(list ?? []),
      { id: `${runId}:prompt`, role: 'user', text: prompt },
      { id: runId, role: 'assistant', text: '', runId }
    ]);
  }

  if (failed) return <button onClick={() => setAttempt(n => n + 1)}>Couldn't load. Retry</button>;
  if (!messages) return <p>Loading…</p>;
  return (
    <main>
      <ConnectionBanner />
      <ol>
        {messages.map(message => (
          <li key={message.id} className={message.role}>
            {message.role === 'assistant' ? <Reply message={message} /> : message.text}
          </li>
        ))}
      </ol>
      <Approval />
      <Composer onSend={send} />
    </main>
  );
}

function Reply({ message }: { message: ChatMessage }) {
  // Only an answer that's still being written has a run to follow.
  const run = useAgentRun(answers, message.runId);
  if (!run) return <Text text={message.text} />;
  return (
    <>
      <Text text={run.value.text} />
      {run.status === 'streaming' && (
        <p>
          <span role="status">{run.value.activity ?? (run.value.text ? '' : 'Thinking…')}</span>
          <button onClick={() => answers.abort(run.runId)}>Stop</button>
        </p>
      )}
      {run.status === 'aborted' && <p>Stopped.</p>}
      {run.status === 'error' && <p role="alert">This answer failed. Ask again.</p>}
    </>
  );
}

function Text({ text }: { text: string }) {
  return <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>;
}

function Approval() {
  const [request] = useAgentApproval(tools, 'approve');
  if (!request) return null;
  return (
    <dialog open>
      <p>{request.params.summary}</p>
      <button onClick={() => request.respond({ approved: true })}>Approve</button>
      <button onClick={() => request.respond({ approved: false })}>Deny</button>
    </dialog>
  );
}

function ConnectionBanner() {
  const status = useWebSocketStatus(chat);
  if (status === 'open' || status === 'idle') return null;
  return <p role="status">{status === 'closed' ? 'Disconnected.' : 'Reconnecting…'}</p>;
}

function Composer({ onSend }: { onSend: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState('');
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        if (!prompt.trim()) return;
        onSend(prompt);
        setPrompt('');
      }}
    >
      <textarea value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button>Send</button>
    </form>
  );
}
```

- **Sending** starts a run and shows both messages at once. While the connection is down, the start message waits in the send queue and goes out when it's back.
- **`Reply`** follows an answer with [`useAgentRun`](../api/use-agent-run.md) only while it has a `runId`, that is, while it's being written. A finished answer from the history is plain text.
- **After a reload**, the history marks the answer still being written with its `runId`, and `answers` has remembered it in `sessionStorage`. The new page follows it from its first event, so the text builds up again and keeps streaming. In another tab or on another device, `useAgentRun` attaches the run it doesn't know, with the same result.
- **Stop** calls `answers.abort()`, which sends `cancel`. The partial answer stays on screen.
- **The approval** comes from `tools`, which registered `'approve'` without a handler. Requests wait there until a dialog answers them.

Each event is one render. The server sends the text every 50 ms, not every token, so that's at most 20 renders a second. If you render Markdown and answers get long, render it from [`useDeferredValue(run.value.text)`](https://react.dev/reference/react/useDeferredValue), so typing in the composer stays responsive while it parses.

## The server

The server keeps each answer's events while it's written, and for a while after, so any connection can catch up on what it missed. It runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name. Everything lives in memory here: keep the history in your database. With more than one server process, a reconnect can reach a different one, so keep the events in a shared store such as Redis streams, or route each user to one process.

### Runs that outlive a connection

```ts
// server.ts
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken } from './auth.ts';
import { generate } from './model.ts';
import type { ChatIn, ChatMessage, ChatOut, RunEvent } from './protocol.ts';

type Call = {
  id: string;
  method: string;
  params: Record<string, string>;
  settle: (answer: { result?: unknown; error?: string }) => void;
};

type Run = {
  runId: string;
  userId: string;
  events: RunEvent[]; // every event so far, to send again
  sockets: Set<WebSocket>; // the connections following it
  calls: Map<string, Call>; // questions for the browser, not answered yet
  controller: AbortController;
  ended: boolean;
};

const chats = new Map<string, ChatMessage[]>(); // use your database
const runs = new Map<string, Run>();

function chatFor(userId: string, chatId: string) {
  const key = `${userId}:${chatId}`;
  let chat = chats.get(key);
  if (!chat) chats.set(key, (chat = []));
  return chat;
}

function send(socket: WebSocket, message: ChatIn) {
  socket.send(JSON.stringify(message));
}

const next = (run: Run) => ({ runId: run.runId, offset: run.events.length + 1 });

function emit(run: Run, event: RunEvent) {
  run.events.push(event);
  for (const socket of run.sockets) send(socket, event);
}

/** Send a connection the events after `after`, then follow the run live on it. */
function follow(run: Run, socket: WebSocket, after = 0) {
  for (const event of run.events.slice(after)) send(socket, event);
  if (run.ended) return;
  run.sockets.add(socket);
  for (const { id, method, params } of run.calls.values()) {
    send(socket, { type: 'call', id, method, params });
  }
}
```

`follow` is the whole resume: the events after the offset the client has, then everything new as it happens. Questions still waiting for an answer go out again too. A question is tied to the connection it arrived on, so the client dropped it when that connection closed.

### Asking the browser

```ts
/** Ask the browsers following the run. The first answer counts. */
function ask(run: Run, method: string, params: Record<string, string>) {
  return new Promise<unknown>((resolve, reject) => {
    const id = randomUUID();
    const settle = ({ result, error }: { result?: unknown; error?: string }) => {
      clearTimeout(timer);
      run.controller.signal.removeEventListener('abort', onAbort);
      run.calls.delete(id);
      // Every other tab showing the question can put it away.
      for (const socket of run.sockets) send(socket, { type: 'withdraw', id });
      if (error === undefined) resolve(result);
      else reject(new Error(error));
    };
    const onAbort = () => settle({ error: 'The answer was stopped.' });
    const timer = setTimeout(() => settle({ error: 'No answer from the user.' }), 5 * 60_000);
    run.controller.signal.addEventListener('abort', onAbort);
    run.calls.set(id, { id, method, params, settle });
    for (const socket of run.sockets) send(socket, { type: 'call', id, method, params });
  });
}
```

Every tab following the answer shows the question. The first answer wins, and `withdraw` takes the dialog away in the others.

### Writing an answer

```ts
async function startRun(socket: WebSocket, userId: string, message: ChatOut & { type: 'run' }) {
  const { runId, chatId, prompt } = message;
  const conversation = chatFor(userId, chatId);
  conversation.push({ id: randomUUID(), role: 'user', text: prompt });
  const reply: ChatMessage = { id: runId, role: 'assistant', text: '', runId };
  conversation.push(reply);

  const run: Run = {
    runId,
    userId,
    events: [],
    sockets: new Set(),
    calls: new Map(),
    controller: new AbortController(),
    ended: false
  };
  runs.set(runId, run);
  follow(run, socket);

  // Send the text every 50 ms instead of every token: fewer messages, and fewer renders.
  let pending = '';
  const flush = () => {
    if (!pending) return;
    emit(run, { type: 'text', ...next(run), text: pending });
    reply.text += pending;
    pending = '';
  };
  const timer = setInterval(flush, 50);

  try {
    await generate(conversation, {
      signal: run.controller.signal,
      onText: text => void (pending += text),
      onActivity: label => {
        flush();
        emit(run, { type: 'tool', ...next(run), label });
      },
      ask: (method, params = {}) => ask(run, method, params)
    });
    flush();
    emit(run, { type: 'done', ...next(run) });
  } catch (error) {
    flush();
    if (run.controller.signal.aborted) {
      // Stopped: end it where it is in the other tabs too. The one that stopped it ignores this.
      emit(run, { type: 'done', ...next(run) });
    } else {
      console.error(error);
      emit(run, { type: 'failed', ...next(run), error: 'The answer failed.' });
    }
  } finally {
    clearInterval(timer);
    delete reply.runId; // the history has the whole answer now
    run.ended = true;
    run.sockets.clear();
    // Keep the events a while for a client that comes back late, then forget them.
    setTimeout(() => runs.delete(runId), 10 * 60_000);
  }
}
```

The answer goes into the history as it's written, so a stopped answer keeps its partial text there too.

### The connection

```ts
const isString = (value: unknown) => typeof value === 'string';

/** A client's message, if it's JSON with the fields its type needs. */
function parse(data: string): ChatOut | undefined {
  try {
    const message = JSON.parse(data);
    const type = message?.type;
    if (type === 'run' && [message.runId, message.chatId, message.prompt].every(isString))
      return message;
    if (type === 'resume' && isString(message.runId) && Number.isInteger(message.after ?? 0))
      return message;
    if (type === 'cancel' && isString(message.runId)) return message;
    if (type === 'history' && isString(message.chatId)) return message;
    if (
      type === 'result' &&
      (isString(message.id) || Number.isInteger(message.id)) &&
      isString(message.error ?? '')
    )
      return message;
  } catch {
    // Not JSON.
  }
  return undefined;
}

function connected(socket: WebSocket, userId: string) {
  socket.on('error', console.error);
  socket.on('message', data => {
    const message = parse(String(data));
    if (!message) return socket.close(1003, 'Invalid message');
    const found = 'runId' in message ? runs.get(message.runId) : undefined;
    const run = found?.userId === userId ? found : undefined;

    switch (message.type) {
      case 'run':
        // Sent again on every connection until the first event arrives: start each run once.
        if (run) follow(run, socket);
        else if (!found) void startRun(socket, userId, message);
        break;
      case 'resume':
        if (run) follow(run, socket, message.after);
        else {
          const offset = (message.after ?? 0) + 1;
          send(socket, { type: 'failed', runId: message.runId, offset, error: 'Unknown answer.' });
        }
        break;
      case 'cancel':
        run?.controller.abort();
        break;
      case 'history':
        send(socket, {
          type: 'history',
          id: message.id,
          messages: chatFor(userId, message.chatId)
        });
        break;
      case 'result':
        for (const run of runs.values()) {
          if (run.userId === userId) run.calls.get(String(message.id))?.settle(message);
        }
        break;
    }
  });

  socket.on('close', () => {
    for (const run of runs.values()) run.sockets.delete(socket);
  });
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, stream, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== '/chat') return stream.destroy();
  const userId = await verifyToken(url.searchParams.get('token'));
  wss.handleUpgrade(request, stream, head, socket => {
    if (userId) connected(socket, userId);
    else socket.close(1008, 'Unauthorized'); // the client doesn't retry 1008
  });
});

server.listen(Number(process.env.PORT ?? 8080));
```

These are the rules `createWebSocketRuns` expects from a server:

- **`run` starts an answer once per id.** The client sends it again on every new connection until the first event arrives, so a second `run` with a known id carries on as a `resume` from the start.
- **`resume` sends the events after `after`**, then follows the answer live. Without `after`, after a reload, it sends them all.
- **An id it doesn't know** gets a `failed` event with the next offset, which ends the answer on the client.
- **Every run belongs to a user.** A `resume` or a `cancel` for someone else's run is ignored.

`verifyToken` checks the token from the URL and returns the user's id. A bad token is closed with `1008`, which the client doesn't retry.

`parse` checks every message before the server uses it: JSON, a known `type`, and the fields that type needs. Anything else closes only that socket, with `1003`, which the client doesn't retry. An error thrown in the listener would stop the server and every answer being written.

### Claude

The model's side is one function. It streams the text, and runs Claude's tools, which can ask the browser:

```ts
// model.ts: the answer, from Claude.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { bookMeeting } from './calendar.ts';
import type { ChatMessage } from './protocol.ts';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

export type Turn = {
  signal: AbortSignal;
  onText: (text: string) => void;
  onActivity: (label: string) => void;
  /** Ask the user's browser, and wait for its answer. */
  ask: (method: string, params?: Record<string, string>) => Promise<unknown>;
};

export async function generate(conversation: ChatMessage[], turn: Turn): Promise<void> {
  // Tool inputs here are a few short fields, so they stay buffered: the API validates them
  // before they arrive.
  const tools = [
    betaZodTool({
      name: 'get_time_zone',
      description: "The user's IANA time zone, from their browser.",
      inputSchema: z.object({}),
      run: async () => {
        turn.onActivity('Checking your time zone…');
        return String(await turn.ask('get_time_zone'));
      }
    }),
    betaZodTool({
      name: 'book_meeting',
      description: "Book a meeting in the user's calendar. The user approves it first.",
      inputSchema: z.object({
        title: z.string(),
        start: z.string().describe('ISO 8601 date and time, with the offset'),
        minutes: z.number().int().positive()
      }),
      run: async meeting => {
        turn.onActivity('Waiting for your approval…');
        const { title, start, minutes } = meeting;
        const summary = `Book “${title}” at ${start} for ${minutes} minutes?`;
        const { approved } = (await turn.ask('approve', { summary })) as { approved: boolean };
        if (!approved) return 'The user declined. Do not book it.';
        await bookMeeting(meeting);
        return 'Booked.';
      }
    })
  ];

  const runner = anthropic.beta.messages.toolRunner(
    {
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      output_config: { effort: 'medium' },
      // A declined request is run again on the model Anthropic recommends for it.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'You are the assistant in a chat app. Answer in plain text.',
      // Earlier turns as text. Answers stopped before any text are left out.
      messages: conversation
        .filter(message => message.text)
        .map(message => ({ role: message.role, content: message.text })),
      tools,
      stream: true
    },
    { signal: turn.signal }
  );

  let separator = ''; // between the text before a tool call and the text after it
  for await (const stream of runner) {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        turn.onText(separator + event.delta.text);
        separator = '';
      }
    }
    const message = await stream.finalMessage();
    if (message.content.some(block => block.type === 'text')) separator = '\n\n';
    if (message.stop_reason === 'refusal') throw new Error('The model declined to answer.');
    if (message.stop_reason === 'max_tokens' && message.content.some(b => b.type === 'tool_use')) {
      throw new Error('A tool call was cut off.');
    }
  }
}
```

- **The tool runner** from `@anthropic-ai/sdk` calls the tools and loops until Claude is done. `betaZodTool` checks each tool's input against its schema before `run` sees it.
- **The approval is a tool's `run`**: it asks the browser and waits. A person can take minutes, so `ask` gives up after five.
- **`signal`** aborts the request to Anthropic when the user clicks Stop, so the model stops generating.
- **`fallbacks: 'default'`** retries a request Claude's safety classifiers decline on the model Anthropic recommends for it. If every model declines, the answer fails.

## When things go wrong

| What happens | What the user sees | Why |
| --- | --- | --- |
| The connection drops mid-answer | "Reconnecting…", then the text carries on from where it stopped | `answers` sends `resume` with the last offset it got. `follow` sends the rest |
| The user reloads mid-answer | The answer builds up again and keeps streaming | The run was remembered in `sessionStorage`, and followed from its first event |
| They open the chat in another tab | The answer that's being written, live | The history marks it with its `runId`, and `useAgentRun` attaches it |
| A question is waiting when the connection drops | The dialog goes away, and comes back on the next connection | Questions are tied to their connection, and `follow` sends them again |
| They answer in one tab | The dialog goes away in the others | `withdraw` |
| They click Stop | The partial answer, and "Stopped." Other tabs see the answer end there | `cancel` aborts the model's request, and the server ends the run with `done` for the other tabs. The partial answer stays in the history |
| The server restarts | Answers in progress fail: "This answer failed. Ask again." | The runs lived in memory. Keep their events in a shared store to survive deploys, and see [`migrate()`](../guide/reconnecting.md#deploys-without-reconnect-storms) |
| The token expires | Nothing | The URL function fetches a fresh one for each attempt |
| The user logs out elsewhere | "Disconnected." | The server closes with `1008`, and the client stops retrying |

In Chrome, against the server on this page with a stand-in for the model, an answer reloaded halfway through and an answer whose connection was dropped halfway through (`chat.reconnect()`) both finished with every word exactly once. An approval waiting when the connection dropped came back on the next one. A stand-in sending 400 text deltas in 2.2 seconds reached the page as 45 messages.

## Testing it

To test the UI without calling the model every time, record a real answer once with [`react-websocket/replay`](../guide/replay.md) and replay it in your tests. Run ids are random, and the replayed events carry the recorded one, so in tests start the answer with that id: `answers.start(request, { runId: 'r-1' })`.

To see the recovery for yourself, wrap the socket in [`react-websocket/chaos`](../guide/chaos.md) in development and drop the connection mid-answer:

```ts
import { createChaosWebSocket } from 'react-websocket/chaos';

export const Chaos = createChaosWebSocket({ latency: [20, 200] });
// In live.ts, in development: createWebSocket(url, { json: true, WebSocket: Chaos })

Chaos.drop(); // from the console, mid-answer
```

## See also

- [AI agents](../guide/agents.md): tools, approvals, streaming and resumable runs in depth
- [AG-UI](../guide/ag-ui.md), if your agent framework speaks the AG-UI protocol
- [`createWebSocketRuns`](../api/create-websocket-runs.md), [`useAgentRun`](../api/use-agent-run.md), [`createWebSocketResponder`](../api/create-websocket-responder.md), [`useAgentApproval`](../api/use-agent-approval.md)
- [Authentication](../guide/authentication.md) and [Reconnecting](../guide/reconnecting.md)
