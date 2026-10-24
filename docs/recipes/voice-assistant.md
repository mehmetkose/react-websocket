---
title: 'Build a voice assistant and text to speech with React and WebSockets'
description: 'A voice assistant over one WebSocket: microphone audio up, the answer down, interruptions that stop playback and cut the transcript to what was heard, plus streamed text to speech with a download. The server relays to OpenAI.'
---

# Build a voice assistant and text to speech

This guide builds two things on one socket. A voice assistant: the user talks, the model answers out loud, and the user can talk over it. And a narrator: paste text, hear it read aloud as it's generated, and download the audio. The server sits between the browser and OpenAI's Realtime and speech APIs, so the API key never reaches the browser.

The hard parts:

1. **Audio has to stay current.** A microphone frame that arrives late is worse than one that never arrives. While the link is slow or down, frames should be dropped, not queued.
2. **The microphone isn't at 24 kHz.** Browsers record at the device's rate, usually 48 kHz, and Firefox won't connect a microphone to an `AudioContext` at another rate. The app converts.
3. **Interruptions.** When the user talks over the answer, playback stops at once, the model stops generating, and its copy of the answer is cut back to what the user actually heard. [Voice agents and interruptions](../guide/voice.md) explains why each matters. This page builds them into an app.
4. **The conversation outlives the connection.** A reconnect, or a reload, should come back to the same conversation, not a new one.
5. **Speech is a stream.** Text to speech starts playing before the whole text is spoken, and Stop stops the generation too, not only the speaker.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `mic-worklet.js` | The browser's audio thread | 24 kHz frames from the microphone |
| `mic.ts` | The browser | Starts and stops the microphone |
| `playback.ts` | The browser | The `Playback` class from [Voice agents](../guide/voice.md#playing-the-answer) |
| `live.ts` | The browser | The connection, the transcript, interruptions and speech |
| `Assistant.tsx`, `Narrator.tsx` | The browser | The two screens |
| `server.ts` | Node | Relays to OpenAI, keeps conversations across reconnects, and streams speech |

## The protocol

The browser and the server speak their own protocol, not OpenAI's events. The browser doesn't depend on the provider, and the server can switch to another one.

```ts
// protocol.ts: imported by the browser and the server. Audio is 24 kHz mono PCM16.
export type VoiceIn =
  // The user started talking: stop the answer.
  | { type: 'speech-started'; itemId: string }
  // A chunk of the answer's audio, as base64.
  | { type: 'audio'; itemId: string; audio: string }
  // What the user said, once it's transcribed.
  | { type: 'heard'; itemId: string; text: string }
  // The next words of the answer's transcript.
  | { type: 'said'; itemId: string; delta: string }
  // Text to speech: a chunk of audio, the end, or a failure.
  | { type: 'speech'; id: number; audio: string }
  | { type: 'speech-end'; id: number }
  | { type: 'speech-failed'; id: number; error: string };

export type VoiceOut =
  // A microphone frame, as binary.
  | ArrayBuffer
  // Stop answering. `heardMs` is how much of `itemId` the user heard.
  | { type: 'interrupt'; itemId?: string; heardMs?: number }
  | { type: 'speak'; id: number; text: string; voice: string }
  | { type: 'stop-speaking'; id: number };
```

Microphone frames go up as binary messages: 20 ms of audio is 960 bytes, where base64 in JSON would be 1,280 and a parse on each side. The answer comes down as base64 in JSON, the way OpenAI sends it, so the server forwards it without decoding.

## The microphone

An `AudioWorklet` runs on the audio thread and hands the main thread 20 ms frames, converted to 24 kHz PCM16. Serve it as a static file, from `public/` in Vite:

```js
// mic-worklet.js: runs on the audio thread. Turns the microphone's samples, at the device's rate,
// into 20 ms frames of 24 kHz PCM16 for the socket.
class Mic extends AudioWorkletProcessor {
  ratio = sampleRate / 24_000;
  position = 0; // where the next output sample falls in the current input block
  frame = new Int16Array(480);
  length = 0;

  process([input]) {
    const samples = input[0];
    if (!samples) return true;
    // Linear resampling: good enough for speech recognition.
    for (; this.position < samples.length; this.position += this.ratio) {
      const i = Math.floor(this.position);
      const a = samples[i];
      const b = samples[i + 1] ?? a;
      const sample = Math.max(-1, Math.min(1, a + (b - a) * (this.position - i)));
      this.frame[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.length === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(480);
        this.length = 0;
      }
    }
    this.position -= samples.length;
    return true;
  }
}

registerProcessor('mic', Mic);
```

```ts
// mic.ts
import { voice } from './live';

/** Start sending the microphone, and return a function that stops it. */
export async function startMic(): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Without echo cancellation, the answer from the speakers reaches the microphone, and the
    // server hears the user interrupting.
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
  });
  // At the device's rate: some browsers can't connect a microphone to a context at another one.
  const context = new AudioContext();
  await context.audioWorklet.addModule('/mic-worklet.js');
  const source = context.createMediaStreamSource(stream);
  const mic = new AudioWorkletNode(context, 'mic', { numberOfOutputs: 0 });
  mic.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
    // Dropped while disconnected, and while 64 KB are already waiting to go out.
    voice.send(data, { volatile: true, maxBuffered: 64 * 1024 });
  };
  source.connect(mic);

  return () => {
    source.disconnect();
    mic.port.onmessage = null;
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
}
```

- **`volatile`** drops a frame while disconnected instead of queueing it, and **`maxBuffered`** drops one while 64 KB are already waiting to go out on a slow link. Speech stays current, and the server's voice detection keeps up. See [Microphone frames](../guide/voice.md#microphone-frames).
- **`echoCancellation`** keeps the answer coming out of the speakers from reaching the microphone. Without it, the server hears the assistant and thinks the user is interrupting.
- **`numberOfOutputs: 0`**: the worklet only listens, so nothing goes to the speakers.

## The client

```ts
// live.ts
import {
  createWebSocket,
  createWebSocketRequests,
  createWebSocketState,
  retryableClose
} from 'react-websocket';
import { playback } from './playback';
import type { VoiceIn, VoiceOut } from './protocol';

// The conversation's id, for this tab: a reconnect or a reload within 30 s picks it up again.
const session = sessionStorage.getItem('voice-session') ?? crypto.randomUUID();
sessionStorage.setItem('voice-session', session);

const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

export const voice = createWebSocket<VoiceIn, VoiceOut>(
  () => `${scheme}//${location.host}/voice?session=${session}`,
  {
    binaryType: 'arraybuffer',
    // Microphone frames go out as binary, everything else as JSON. The server sends only JSON.
    serialize: message => (message instanceof ArrayBuffer ? message : JSON.stringify(message)),
    parse: data => JSON.parse(data as string),
    // 4409: the conversation moved to another tab. Don't take it back.
    reconnect: { shouldReconnect: close => close.code !== 4409 && retryableClose(close) }
  }
);

export type Line = { itemId: string; role: 'user' | 'assistant'; text: string; cut?: boolean };

export const transcript = createWebSocketState(voice, {
  initialState: [] as Line[],
  reduce: (lines, message): Line[] => {
    switch (message.type) {
      case 'speech-started':
        return [...lines, { itemId: message.itemId, role: 'user', text: '' }];
      case 'heard':
        return lines.map(line =>
          line.itemId === message.itemId ? { ...line, text: message.text } : line
        );
      case 'said':
        return lines.some(line => line.itemId === message.itemId)
          ? lines.map(line =>
              line.itemId === message.itemId ? { ...line, text: line.text + message.delta } : line
            )
          : [...lines, { itemId: message.itemId, role: 'assistant', text: message.delta }];
      default:
        return lines;
    }
  },
  batch: 'frame'
});

/** Stop the answer: what's playing, what the model is still generating, and its transcript. */
export function interrupt() {
  const heard = playback.stop();
  voice.send({ type: 'interrupt', ...heard }, { priority: true });
  if (!heard) return;
  transcript.setState(lines =>
    lines.map(line => (line.itemId === heard.itemId ? { ...line, cut: true } : line))
  );
}

voice.on('message', message => {
  if (message.type === 'audio') playback.play(message.itemId, message.audio);
  // The server heard the user start talking over the answer.
  if (message.type === 'speech-started') interrupt();
});

// The server gives up on an answer whose connection drops: stop playing it too.
voice.on('close', () => playback.stop());

export const speech = createWebSocketRequests(voice, {
  send: ({ text, voice }: { text: string; voice: string }, id) => ({
    type: 'speak',
    id,
    text,
    voice
  }),
  reply: message =>
    message.type === 'speech' || message.type === 'speech-end' || message.type === 'speech-failed'
      ? message.id
      : undefined,
  error: message => (message.type === 'speech-failed' ? new Error(message.error) : undefined),
  done: message => message.type === 'speech-end',
  cancel: id => ({ type: 'stop-speaking', id }),
  timeout: 30_000
});
```

- **The session id** names the conversation. It's kept in `sessionStorage`, so a reconnect or a reload within 30 seconds comes back to the same one on the server. The server closes a socket with `4409` when the same conversation opens in another tab, such as a duplicated one, which copies `sessionStorage`. The client doesn't retry `4409`, so the two tabs don't take it from each other forever.
- **`serialize` and `parse`** let binary frames and JSON share the socket.
- **`transcript`** is a [state store](../guide/state.md) built from the messages. `batch: 'frame'` renders a fast transcript once per frame at most.
- **`interrupt`** stops playback, then sends `interrupt` with `priority`, ahead of anything queued, carrying how much of the answer the user heard. It runs when the server says the user started talking, and from the Stop button.
- **`speech`** turns text to speech into a stream of replies, with [`createWebSocketRequests`](../api/create-websocket-requests.md#streaming-replies). Leaving the stream sends `stop-speaking`.

## The assistant

```tsx
// Assistant.tsx
import { useEffect, useRef, useState } from 'react';
import { useWebSocketState, useWebSocketStatus } from 'react-websocket';
import { interrupt, transcript, voice } from './live';
import { startMic } from './mic';
import { playback } from './playback';

const offline = {
  idle: 'Connecting…',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected. Reload to talk again.'
};

export function Assistant() {
  const status = useWebSocketStatus(voice);
  const lines = useWebSocketState(transcript);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const stopMic = useRef<() => void>(undefined);

  async function talk() {
    try {
      await playback.resume(); // from the click: browsers only start audio after a user gesture
      stopMic.current = await startMic();
      setListening(true);
      setError(undefined);
    } catch {
      setError('The microphone is blocked. Allow it in the address bar.');
    }
  }

  function end() {
    stopMic.current?.();
    interrupt();
    setListening(false);
  }

  useEffect(() => () => stopMic.current?.(), []);

  const label = status === 'open' ? (listening ? 'Listening…' : 'Ready') : offline[status];
  return (
    <section>
      <p role="status">{label}</p>
      {listening ? <button onClick={end}>End</button> : <button onClick={talk}>Talk</button>}
      <button onClick={() => interrupt()}>Stop the answer</button>
      {error && <p role="alert">{error}</p>}
      <ol>
        {lines.map(line => (
          <li key={line.itemId} className={line.role}>
            {line.text || '…'}
            {line.cut && ' (interrupted)'}
          </li>
        ))}
      </ol>
    </section>
  );
}
```

`playback.resume()` runs in the click, because browsers only start audio after a user gesture. The answer streams in faster than it plays, so its transcript runs ahead of the audio. A line marked "interrupted" may show words the user never heard. The model's copy is cut back to what was heard, but the transcript on screen isn't.

## The narrator

Text to speech, with the same socket and the same playback. A second `Playback` keeps the narration apart from the assistant:

```tsx
// Narrator.tsx
import { useRef, useState } from 'react';
import { speech } from './live';
import { Playback } from './playback';
import { toWav } from './wav';

const narration = new Playback();

export function Narrator() {
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'speaking' | 'failed'>('idle');
  const [download, setDownload] = useState<string>();
  const controller = useRef<AbortController>(undefined);

  async function speak() {
    controller.current?.abort();
    const abort = (controller.current = new AbortController());
    await narration.resume();
    setState('speaking');
    const chunks: string[] = [];
    try {
      for await (const reply of speech.stream({ text, voice: 'marin' }, { signal: abort.signal })) {
        if (reply.type !== 'speech') continue;
        narration.play('narration', reply.audio);
        chunks.push(reply.audio);
      }
      if (download) URL.revokeObjectURL(download);
      setDownload(URL.createObjectURL(toWav(chunks)));
      setState('idle');
    } catch {
      if (!abort.signal.aborted) setState('failed');
    }
  }

  function stop() {
    controller.current?.abort(); // sends stop-speaking: the server stops generating
    narration.stop();
    setState('idle');
  }

  return (
    <section>
      <textarea value={text} onChange={event => setText(event.target.value)} />
      {state === 'speaking' ? (
        <button onClick={stop}>Stop</button>
      ) : (
        <button onClick={speak} disabled={!text.trim()}>
          Read aloud
        </button>
      )}
      {state === 'failed' && <p role="alert">Couldn't read it aloud. Try again.</p>}
      {download && state === 'idle' && (
        <a href={download} download="speech.wav">
          Download
        </a>
      )}
    </section>
  );
}
```

The audio plays as it arrives. When it's all there, the chunks become a WAV file to download:

```ts
// wav.ts: 24 kHz mono PCM16 chunks, as a WAV file.
export function toWav(chunks: string[]): Blob {
  const parts = chunks.map(chunk => Uint8Array.from(atob(chunk), char => char.charCodeAt(0)));
  const size = parts.reduce((total, part) => total + part.length, 0);
  const header = new DataView(new ArrayBuffer(44));
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  header.setUint32(4, 36 + size, true);
  write(8, 'WAVEfmt ');
  header.setUint32(16, 16, true); // the format chunk's size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, 24_000, true); // samples per second
  header.setUint32(28, 48_000, true); // bytes per second
  header.setUint16(32, 2, true); // bytes per sample
  header.setUint16(34, 16, true); // bits per sample
  write(36, 'data');
  header.setUint32(40, size, true);
  return new Blob([header, ...parts], { type: 'audio/wav' });
}
```

Stop aborts the stream, which sends `stop-speaking`. The server aborts its request to OpenAI, so the rest of the text isn't generated.

## The server

The server keeps a connection to OpenAI for each conversation, and relays between it and the browser. It runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name.

### The relay

```ts
// server.ts
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { userFromCookie } from './auth.ts';
import type { VoiceIn, VoiceOut } from './protocol.ts';

// Check OpenAI's model list for the current realtime model.
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1';
const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

/** The Realtime API's events this server reads. */
type RealtimeEvent =
  | { type: 'response.created' | 'response.done' }
  | { type: 'input_audio_buffer.speech_started'; item_id: string }
  | {
      type: 'conversation.item.input_audio_transcription.completed';
      item_id: string;
      transcript: string;
    }
  | { type: 'response.output_audio.delta'; item_id: string; delta: string }
  | { type: 'response.output_audio_transcript.delta'; item_id: string; delta: string }
  | { type: 'error'; error: { message: string } };

type Session = {
  userId: string;
  upstream: WebSocket; // to OpenAI
  socket?: WebSocket; // to the browser, while it's connected
  responding: boolean;
  sentMs: Map<string, number>; // how much audio of each item went to the browser
  idle?: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, Session>();

function send(session: Session, message: VoiceIn) {
  session.socket?.send(JSON.stringify(message));
}

function openSession(id: string, userId: string): Session {
  const upstream = new WebSocket(REALTIME_URL, { headers });
  const session: Session = { userId, upstream, responding: false, sentMs: new Map() };
  sessions.set(id, session);

  upstream.on('open', () => {
    upstream.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: 'You are a friendly voice assistant. Keep your answers short.',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24_000 },
              transcription: { model: 'gpt-4o-mini-transcribe' },
              // Answers when the user stops talking, and stops answering when they start.
              turn_detection: { type: 'semantic_vad' }
            },
            output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: 'marin' }
          }
        }
      })
    );
  });

  upstream.on('message', data => {
    const event = JSON.parse(String(data)) as RealtimeEvent;
    switch (event.type) {
      case 'response.created':
      case 'response.done':
        session.responding = event.type === 'response.created';
        break;
      case 'input_audio_buffer.speech_started':
        send(session, { type: 'speech-started', itemId: event.item_id });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        send(session, { type: 'heard', itemId: event.item_id, text: event.transcript });
        break;
      case 'response.output_audio.delta': {
        const ms = Buffer.byteLength(event.delta, 'base64') / 48; // 24 kHz, 2 bytes a sample
        session.sentMs.set(event.item_id, (session.sentMs.get(event.item_id) ?? 0) + ms);
        send(session, { type: 'audio', itemId: event.item_id, audio: event.delta });
        break;
      }
      case 'response.output_audio_transcript.delta':
        send(session, { type: 'said', itemId: event.item_id, delta: event.delta });
        break;
      case 'error':
        console.error(event.error.message);
        break;
    }
  });

  // A failed connection to OpenAI ends this session only: 'close' follows every 'error'.
  upstream.on('error', console.error);
  upstream.on('close', () => {
    sessions.delete(id);
    session.socket?.close(1011, 'Session ended'); // the browser reconnects to a new one
  });
  return session;
}
```

- **`semantic_vad`** lets OpenAI decide when the user has finished talking, and answer. When the user starts talking over an answer, it cancels the answer by itself, and sends `input_audio_buffer.speech_started`, which the browser turns into an interruption.
- **`sentMs`** counts the audio of each answer that went to the browser: 48 bytes per millisecond at 24 kHz.
- **When OpenAI closes the session**, or the connection to it fails, the browser's socket is closed with `1011`. The client reconnects, and gets a new conversation.

### Interruptions

```ts
type Interrupt = Extract<VoiceOut, { type: 'interrupt' }>;
type Speak = Extract<VoiceOut, { type: 'speak' }>;

function interrupt(session: Session, { itemId, heardMs = 0 }: Interrupt) {
  const upstream = session.upstream;
  if (upstream.readyState !== WebSocket.OPEN) return;
  if (session.responding) upstream.send(JSON.stringify({ type: 'response.cancel' }));
  // Cut the answer back to what the user heard, so the model doesn't think they heard the rest.
  if (itemId && heardMs < (session.sentMs.get(itemId) ?? 0)) {
    const truncate = { type: 'conversation.item.truncate', item_id: itemId, content_index: 0 };
    upstream.send(JSON.stringify({ ...truncate, audio_end_ms: Math.floor(heardMs) }));
  }
}
```

Over a WebSocket, OpenAI can't know how much of the answer was played: the browser buffered it. `conversation.item.truncate` tells it. It's skipped when the user heard the whole answer: there's nothing to cut, and `audio_end_ms` can't be more than the audio there is.

### Text to speech

```ts
/** Text to speech, streamed: raw 24 kHz PCM16 as it's generated. */
async function speak(session: Session, { id, text, voice }: Speak, signal: AbortSignal) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm' }),
    signal
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  let odd = Buffer.alloc(0); // a byte of a sample split across two chunks
  for await (const chunk of response.body) {
    const bytes = Buffer.concat([odd, chunk]);
    const whole = bytes.length - (bytes.length % 2);
    odd = bytes.subarray(whole);
    if (!whole) continue;
    send(session, { type: 'speech', id, audio: bytes.subarray(0, whole).toString('base64') });
  }
  send(session, { type: 'speech-end', id });
}
```

The `pcm` format is raw 24 kHz PCM16 with no header, streamed as it's generated. A chunk can end in the middle of a sample, so the odd byte waits for the next chunk.

### The connection

```ts
const isString = (value: unknown) => typeof value === 'string';

/** A text message from the browser, if it's JSON with the fields its type needs. */
function parse(data: string): Exclude<VoiceOut, ArrayBuffer> | undefined {
  try {
    const message = JSON.parse(data);
    const type = message?.type;
    if (
      type === 'interrupt' &&
      isString(message.itemId ?? '') &&
      Number.isFinite(message.heardMs ?? 0)
    )
      return message;
    if (
      type === 'speak' &&
      Number.isInteger(message.id) &&
      isString(message.text) &&
      isString(message.voice)
    )
      return message;
    if (type === 'stop-speaking') return message;
  } catch {
    // Not JSON.
  }
  return undefined;
}

function connected(socket: WebSocket, session: Session) {
  clearTimeout(session.idle);
  // The conversation opened somewhere else, such as a duplicated tab: it moves there.
  session.socket?.close(4409, 'Opened in another tab');
  session.socket = socket;
  const speaking = new Map<number, AbortController>();
  socket.on('error', console.error);

  socket.on('message', (data, isBinary) => {
    const { upstream } = session;
    if (isBinary) {
      // A microphone frame. Dropped until OpenAI's socket is open, like the browser drops them.
      if (upstream.readyState !== WebSocket.OPEN) return;
      const audio = Buffer.from(data as Buffer).toString('base64');
      return upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    }
    const message = parse(String(data));
    if (!message) return socket.close(1003, 'Invalid message');
    switch (message.type) {
      case 'interrupt':
        interrupt(session, message);
        break;
      case 'speak': {
        const controller = new AbortController();
        speaking.set(message.id, controller);
        speak(session, message, controller.signal)
          .catch(error => {
            if (controller.signal.aborted) return;
            console.error(error);
            send(session, { type: 'speech-failed', id: message.id, error: 'Speech failed.' });
          })
          .finally(() => speaking.delete(message.id));
        break;
      }
      case 'stop-speaking':
        speaking.get(message.id)?.abort();
        break;
    }
  });

  socket.on('close', () => {
    for (const controller of speaking.values()) controller.abort();
    if (session.socket !== socket) return;
    session.socket = undefined;
    // Keep the conversation for 30 s, for a reconnect or a reload.
    session.idle = setTimeout(() => session.upstream.close(), 30_000);
  });
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, stream, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== '/voice' || request.headers.origin !== process.env.APP_ORIGIN) {
    return stream.destroy();
  }
  const userId = await userFromCookie(request.headers.cookie);
  const id = url.searchParams.get('session') ?? '';
  wss.handleUpgrade(request, stream, head, socket => {
    if (!userId || !id) return socket.close(1008, 'Unauthorized');
    const existing = sessions.get(id);
    if (existing && existing.userId !== userId) return socket.close(1008, 'Unauthorized');
    connected(socket, existing ?? openSession(id, userId));
  });
});

server.listen(Number(process.env.PORT ?? 8080));
```

- **A frame that arrives before OpenAI's socket is open** is dropped, as the browser drops frames while it's disconnected.
- **When the browser disconnects**, the conversation waits 30 seconds for it, then closes. A reload comes back within that.
- **Each conversation belongs to a user.** A session id from someone else is refused.
- **`parse` checks every text message** before the server uses it: JSON, a known `type`, and the fields that type needs. Anything else closes only that socket, with `1003`, which the client doesn't retry. An error thrown in the listener would stop the server and end every conversation.

## When things go wrong

| What happens | What the user hears or sees | Why |
| --- | --- | --- |
| They talk over the answer | The answer stops at once, and the model answers what they just said | `speech-started`, then `interrupt` with `priority` and `heardMs` |
| They click "Stop the answer" | The same | `interrupt()`. The server sends `response.cancel` only if an answer is in progress |
| The link gets slow | Their speech stays current. Some frames are dropped | `maxBuffered: 64 * 1024` |
| The connection drops mid-answer | The answer stops, "Reconnecting…", then the same conversation | `voice.on('close')` stops playback. The session id brings back the conversation |
| They reload | The same conversation, with an empty transcript | The session id in `sessionStorage`. Keep the transcript there too to bring it back |
| They duplicate the tab | The new tab has the conversation. The old one says "Disconnected" | `4409`, which the client doesn't retry |
| The microphone is blocked | "The microphone is blocked. Allow it in the address bar." | `getUserMedia` rejects |
| They stop the narration | Silence, and no more audio generated | `stop-speaking` aborts the request to OpenAI |

In Chrome, against the server on this page with a stand-in for OpenAI that streams the answer 2.5 times faster than real time: interrupting 700 ms into a three-second answer stopped it after 1.6 s of audio had arrived, and the server sent `conversation.item.truncate` with `audio_end_ms: 640`. A reload opened no new session upstream. Stop on a narration aborted the request to the speech API 500 ms in, and a finished narration downloaded as a 3.06 s WAV file, which Chrome decoded.

## Testing it

Point `REALTIME_URL` and the speech URL at a stand-in server that speaks the same events, as above. It can script a conversation: the user talks, the assistant answers, the user talks over it, so every path runs in seconds, without an API key. To test interruptions in the browser without a microphone, replace `getUserMedia` with an oscillator: `const context = new AudioContext(); const tone = context.createOscillator(); const out = context.createMediaStreamDestination(); tone.connect(out); tone.start();`, then return `out.stream`.

## See also

- [Voice agents and interruptions](../guide/voice.md): the playback clock, `heardMs` and the reasons behind each step
- [Build an AI chatbot](./ai-chatbot.md): the same assistant in text, with tools and approvals
- [Reconnecting](../guide/reconnecting.md#control-messages-first): `priority`, `volatile` and `maxBuffered`
- [`createWebSocketRequests`](../api/create-websocket-requests.md#streaming-replies) and [`createWebSocketState`](../api/create-websocket-state.md)
