---
description: 'react-websocket/replay: createRecordingWebSocket records WebSocket sessions to JSON, and createReplayWebSocket plays them back without a server.'
---

# react-websocket/replay

Record WebSocket sessions and play them back without a server. Both functions return `WebSocket` classes to pass as the [`WebSocket`](./options.md#websocket) option. The entry has no React dependency and no imports, and is about 1.7 kB min+gzip. The guide is [Recording and replay](../guide/replay.md).

## createRecordingWebSocket

```ts
function createRecordingWebSocket(options?: { WebSocket?: typeof WebSocket }): RecordingWebSocket;
```

A `WebSocket` class that records what its connections do. `options.WebSocket` is the one it wraps; the global one by default.

| Member | |
| --- | --- |
| `recording()` | Everything recorded so far, as a new [`WebSocketRecording`](#websocketrecording) |
| `save(filename?)` | Download the recording as a JSON file. Default name `websocket-recording.json` |
| `clear()` | Forget everything recorded so far |

The sockets it creates behave like the wrapped ones. Binary data is received as an `ArrayBuffer` underneath, so it can be recorded at once, and handed to the app as a `Blob` or an `ArrayBuffer` per its `binaryType`.

## createReplayWebSocket

```ts
function createReplayWebSocket(
  recording: WebSocketRecording,
  options?: { speed?: number; waitForSends?: boolean }
): ReplayWebSocket;
```

| Option | | Default |
| --- | --- | --- |
| `speed` | How fast to replay: `1` as recorded, `4` four times faster, `Infinity` as fast as possible | `1` |
| `waitForSends` | Wait for the app to send before replaying what came after a send in the recording | `true` |

| Member | |
| --- | --- |
| `sent` | What the app sent during the replay, one array per connection, as recorded data |
| `done` | Resolves once every recorded connection has been played to its end, after its last `close` event |
| `reset()` | Start again from the first recorded connection. Connections still playing stop where they are, without a `close` event, and the previous `done` resolves. Read `done` again for the new one |

Each socket it creates replays the next recorded connection. One beyond the end of the recording fails with an `error` and a `1006` close. `bufferedAmount` is `0`, and `send()` throws while connecting, like a real socket.

## WebSocketRecording

```ts
interface WebSocketRecording {
  format: 'react-websocket-recording';
  version: 1;
  connections: {
    url: string;
    at: number; // Date.now() when it was created
    events: RecordedEvent[];
  }[];
}

type RecordedEvent =
  | { t: number; type: 'open'; protocol: string }
  | { t: number; type: 'send' | 'message'; data: RecordedData }
  | { t: number; type: 'error' }
  | { t: number; type: 'close'; code: number; reason: string; wasClean: boolean };

type RecordedData = string | { binary: string };
```

`t` is in ms since the connection was created. Text is recorded as it was, and binary data as `{ binary }`, base64. It's plain JSON, so you can write or edit a recording by hand. `Replay.sent` holds `RecordedData` too. A `Blob` the app sends is recorded as `{ binary: '' }` at once, and its bytes are filled in once read.
