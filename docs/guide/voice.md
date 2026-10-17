---
title: 'Voice agents over WebSockets: audio and interruptions'
description: 'Stream microphone audio to a voice agent over a WebSocket, play its answer, and handle interruptions: stop playback, cancel generation, and truncate the transcript to what the user heard.'
---

# Voice agents and interruptions

A voice agent streams audio both ways over one socket: the microphone up, the answer down. The hard part isn't the streaming, it's the interruption. The user starts talking while the agent is still answering, and four things must happen at once:

1. **Stop playback.** The answer is usually generated faster than it's played, so seconds of it may be queued in the speaker.
2. **Throw away what's queued**, on both sides.
3. **Cancel generation**, so the model stops producing, and paying for, audio nobody will hear.
4. **Report what was actually heard.** The server's transcript has the whole answer it generated. Unless it's cut back to where playback stopped, the model believes the user heard words they never did, and the conversation goes wrong from there.

The library does the transport part. Audio capture and playback stay in your app, and this page shows both.

## The connection

Audio frames are binary, while control messages are JSON, so use a `serialize` and `parse` that let both through:

```ts
// voice.ts
import { createWebSocket } from 'react-websocket';

export const voice = createWebSocket<VoiceIn, VoiceOut | ArrayBuffer>('wss://voice.example.com', {
  binaryType: 'arraybuffer',
  serialize: message => (message instanceof ArrayBuffer ? message : JSON.stringify(message)),
  parse: data => (typeof data === 'string' ? JSON.parse(data) : data)
});
```

## Microphone frames

Send each frame from your `AudioWorklet` as soon as it's captured:

```ts
voice.send(frame, { volatile: true, maxBuffered: 64 * 1024 });
```

- **`volatile`**: while disconnected, a frame is dropped instead of queued. Half a second of speech replayed after a reconnect is worse than none.
- **`maxBuffered`**: while connected on a slow link, a frame is dropped when 64 KB are already waiting to go out, instead of building up lag. Speech stays current, and the server's voice activity detection keeps up.

In Chrome, 50 frames sent while disconnected sent nothing, and 20 half-megabyte frames sent at once with `maxBuffered` at 1 MB sent 3 and dropped 17.

## Playing the answer

The server streams the answer in chunks, faster than real time. Schedule them back to back on a Web Audio clock, and remember when the current item started, so you can tell later how much of it has been played:

```ts
// playback.ts: 24 kHz mono PCM16, as base64 chunks.
export class Playback {
  private context = new AudioContext({ sampleRate: 24_000 });
  private sources = new Set<AudioBufferSourceNode>();
  private endsAt = 0;
  private item?: { id: string; startedAt: number; scheduledMs: number };

  /** Call from a click or key press: browsers only start audio after a user gesture. */
  resume() {
    return this.context.resume();
  }

  play(itemId: string, base64: string) {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer);
    const buffer = this.context.createBuffer(1, samples.length, 24_000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.context.currentTime, this.endsAt);
    source.start(startAt);
    this.endsAt = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);

    if (this.item?.id !== itemId) this.item = { id: itemId, startedAt: startAt, scheduledMs: 0 };
    this.item.scheduledMs += buffer.duration * 1000;
  }

  /** Stop at once, and say how much of the current item reached the speaker. */
  stop(): { itemId: string; heardMs: number } | undefined {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.endsAt = 0;
    const item = this.item;
    this.item = undefined;
    if (!item) return;
    // What's in the output buffer hasn't been heard yet.
    const playedMs = (this.context.currentTime - this.context.outputLatency - item.startedAt) * 1000;
    return { itemId: item.id, heardMs: Math.round(Math.min(item.scheduledMs, Math.max(0, playedMs))) };
  }
}
```

```ts
export const playback = new Playback();

voice.on('message', message => {
  if (message instanceof ArrayBuffer) return;
  if (message.type === 'response.audio.delta') playback.play(message.itemId, message.delta);
  if (message.type === 'input_audio_buffer.speech_started') interrupt(); // the server heard the user
});
```

## The interruption

When the user starts talking, whether the server's voice activity detection says so or a push-to-talk button does, stop playback, then tell the server to stop and how much was heard:

```ts
export function interrupt() {
  const heard = playback.stop();
  voice.send({ type: 'cancel' }, { priority: true });
  if (heard) {
    voice.send({ type: 'truncate', itemId: heard.itemId, heardMs: heard.heardMs }, { priority: true });
  }
}
```

- **`priority`** puts both messages ahead of anything queued. If the connection happens to be down at that moment, they go out first on the next one, before microphone frames or anything else.
- **`heardMs`** comes from the audio clock, not from what arrived, so it's what the speaker played. The server cuts its copy of the answer back to it: OpenAI's Realtime API calls this `conversation.item.truncate` with `audio_end_ms`. Other servers have their own message; the shape above is an example.

In Chrome, against a server streaming audio about two and a half times faster than real time, interrupting 705 ms after the first chunk arrived found 1.7 s of audio received and 1 s of it still scheduled. Playback stopped, no audio arrived after `cancel`, and the server got `cancel`, then `truncate` with `heardMs: 688`: the 705 ms minus Chrome's 16 ms output latency.

## Reconnects

When the connection drops mid-answer, the server usually gives up on that response. Stop playback then too, so the speaker doesn't keep talking while the app reconnects:

```ts
voice.on('close', () => playback.stop());
```

For a voice session that must survive a reconnect, such as a long dictation, keep the session id on your side and pass it in the [`url` function](./authentication.md), so the server can find the session again.

## See also

- [Reconnecting and heartbeats](./reconnecting.md#control-messages-first): `priority` and `maxBuffered`
- [AI agents](./agents.md): tools, approvals and streamed text answers
- [Performance](./performance.md)
