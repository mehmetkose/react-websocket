---
title: 'Record and replay WebSocket sessions'
description: 'Record a WebSocket session to a file and replay it without a server: reproducible bug reports, offline demos, and UI tests that don''t call an AI model on every CI run.'
---

# Recording and replay

A WebSocket bug is hard to reproduce: it depends on what the server sent, in what order, how fast, and what the network did meanwhile. `react-websocket/replay` records a session to a file and plays it back without a server:

- **Bug reports.** "Attach your recording" replaces "it froze after a while".
- **Offline demos.** Show a live dashboard or an agent at work with no backend running.
- **UI tests.** Record an AI model's answer once, then test the UI against it on every CI run, without calling the model, paying for tokens, or getting a different answer each time.

## Recording

`createRecordingWebSocket()` returns a `WebSocket` class that records what its connections do. Pass it as the `WebSocket` option:

```ts
import { createWebSocket } from 'react-websocket';
import { createRecordingWebSocket } from 'react-websocket/replay';

export const Recorder = createRecordingWebSocket();
export const live = createWebSocket(url, { json: true, WebSocket: Recorder });
```

It records each connection's open, every message sent and received, errors and closes, with their times. Get the session back as plain JSON, or download it:

```ts
const recording = Recorder.recording(); // { format, version, connections: [...] }
Recorder.save('session.json'); // e.g. from a "Report a problem" button
Recorder.clear();
```

Binary messages are kept as base64. A recording holds every message, so it can hold auth tokens and personal data: record in development, and ask before saving one from a user's session.

## Replaying

`createReplayWebSocket(recording)` returns a `WebSocket` class that plays the recording back. Each connection the client opens replays the next recorded one: its open, its messages at their recorded times, and its close.

```ts
import { createReplayWebSocket } from 'react-websocket/replay';
import recording from './fixtures/agent-answer.json';

const Replay = createReplayWebSocket(recording, { speed: 4 });
export const agent = createWebSocket(url, { json: true, WebSocket: Replay });
```

- **`speed`** scales the recorded timing: `1` as it happened, `4` four times faster, `Infinity` as fast as possible.
- **Following the app.** By default, what the server sent after a message from the app waits until the app sends a message too, so the replay follows the app: an answer comes after the question, however long the test or the person takes to ask it. `waitForSends: false` follows the recorded clock alone.
- **Running out.** A connection beyond the end of the recording is refused, like a server that's gone, and the client backs off as usual.
- **What the app sent** is in `Replay.sent`, one array per connection, to check in a test. `Replay.done` resolves once every recorded connection has played. `Replay.reset()` starts again from the first.

In Chrome, an agent's eight-word answer took 1.2 s from the server. Its 1.2 KB recording replayed the same answer in 0.34 s at `speed: 4`, with no server running.

### Deterministic replays

The replay doesn't compare what the app sends with what it sent in the recording: it only counts. Messages that depend on ids the app makes up, such as a run id, should use the same ids as in the recording, or the app ignores the replayed answers to them. Ids from counters, such as `createWebSocketRequests`'s, start over with each client, so they match by themselves. For random ones, pass your own in tests: `runs.start(prompt, { runId: 'r-1' })`.

## Faults that never happened

Wrap the replay in [chaos](./chaos.md) to test what the recording didn't contain: a dropped connection mid-answer, lost messages, latency.

```ts
import { createChaosWebSocket } from 'react-websocket/chaos';

const Chaos = createChaosWebSocket({ WebSocket: Replay, latency: [50, 300] });
const agent = createWebSocket(url, { json: true, WebSocket: Chaos });
// …later, in the test:
Chaos.drop();
```

In Chrome, dropping a replayed agent answer after two words left the run streaming with its partial answer while the client reconnected, which is what users see in a real outage, now reproducible on every run.

## In a test

```tsx
import { render, screen } from '@testing-library/react';
import { createReplayWebSocket } from 'react-websocket/replay';
import recording from './fixtures/agent-answer.json';

it('shows the answer', async () => {
  const Replay = createReplayWebSocket(recording, { speed: Infinity });
  render(<Chat client={createWebSocket(url, { json: true, WebSocket: Replay })} />);
  await userEvent.type(screen.getByRole('textbox'), 'Summarize{enter}');
  expect(await screen.findByText(/In short/)).toBeInTheDocument();
  expect(Replay.sent[0]).toHaveLength(1);
});
```

Record fixtures against your real server once, check them in, and record again when the protocol changes.

## See also

- [`react-websocket/replay` API](../api/replay.md)
- [Testing](./testing.md) and [Chaos testing](./chaos.md)
