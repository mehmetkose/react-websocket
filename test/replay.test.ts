import { createChaosWebSocket } from '../src/chaos';
import { createWebSocket } from '../src/core';
import {
  createRecordingWebSocket,
  createReplayWebSocket,
  type WebSocketRecording
} from '../src/replay';
import { MockImpl, MockWebSocket } from './mock';

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const as = (Class: unknown) => Class as typeof WebSocket;

/** A recording with two connections: the first answers a question, then drops. */
const chat: WebSocketRecording = {
  format: 'react-websocket-recording',
  version: 1,
  connections: [
    {
      url: 'ws://chat',
      at: 0,
      events: [
        { t: 10, type: 'open', protocol: '' },
        { t: 20, type: 'message', data: 'welcome' },
        { t: 500, type: 'send', data: 'question' },
        { t: 600, type: 'message', data: 'answer 1' },
        { t: 700, type: 'message', data: 'answer 2' },
        { t: 900, type: 'close', code: 1006, reason: '', wasClean: false }
      ]
    },
    {
      url: 'ws://chat',
      at: 2000,
      events: [
        { t: 5, type: 'open', protocol: 'v1' },
        { t: 50, type: 'message', data: { binary: btoa('\x01\x02') } }
      ]
    }
  ]
};

describe('createRecordingWebSocket', () => {
  it('records each connection: open, sends, messages, errors and closes, with their times', () => {
    const Recorder = createRecordingWebSocket({ WebSocket: MockImpl });
    const client = createWebSocket('ws://chat', {
      WebSocket: as(Recorder),
      binaryType: 'arraybuffer'
    });
    const received: unknown[] = [];
    client.on('message', message => received.push(message));
    client.connect();
    vi.advanceTimersByTime(10);
    MockWebSocket.last.open();
    vi.advanceTimersByTime(15);
    client.send('hi');
    client.send(new Uint8Array([1, 2, 3]));
    MockWebSocket.last.receive('hello');
    MockWebSocket.last.receive(new Uint8Array([9]).buffer);
    MockWebSocket.last.onerror?.(new Event('error'));
    MockWebSocket.last.finishClose(1011, 'bye');

    expect(received).toEqual(['hello', new Uint8Array([9]).buffer]);
    expect(MockWebSocket.instances[0]!.sent).toEqual(['hi', new Uint8Array([1, 2, 3])]);
    const recording = Recorder.recording();
    expect(recording.format).toBe('react-websocket-recording');
    expect(recording.connections).toHaveLength(1);
    expect(recording.connections[0]!.events).toEqual([
      { t: 10, type: 'open', protocol: '' },
      { t: 25, type: 'send', data: 'hi' },
      { t: 25, type: 'send', data: { binary: btoa('\x01\x02\x03') } },
      { t: 25, type: 'message', data: 'hello' },
      { t: 25, type: 'message', data: { binary: btoa('\x09') } },
      { t: 25, type: 'error' },
      { t: 25, type: 'close', code: 1011, reason: 'bye', wasClean: false }
    ]);
    // The client reconnects: a second connection.
    vi.advanceTimersByTime(60_000);
    expect(Recorder.recording().connections).toHaveLength(2);
    Recorder.clear();
    expect(Recorder.recording().connections).toEqual([]);
    client.close();
  });

  it('records the bytes of a Blob once read, and hands binary data over as a Blob by default', async () => {
    vi.useRealTimers();
    const Recorder = createRecordingWebSocket({ WebSocket: MockImpl });
    const socket = new Recorder('ws://blob');
    const received: unknown[] = [];
    socket.onmessage = event => received.push(event.data);
    MockWebSocket.last.open();
    socket.send(new Blob(['ab']));
    MockWebSocket.last.receive(new Uint8Array([7]).buffer);
    expect(received[0]).toBeInstanceOf(Blob);
    await vi.waitFor(() =>
      expect(Recorder.recording().connections[0]!.events[1]).toEqual({
        t: expect.any(Number),
        type: 'send',
        data: { binary: btoa('ab') }
      })
    );
    socket.close();
  });

  it('saves the recording as a JSON file', () => {
    const Recorder = createRecordingWebSocket({ WebSocket: MockImpl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:recording');
    URL.revokeObjectURL = vi.fn();
    Recorder.save('bug.json');
    expect(click).toHaveBeenCalledOnce();
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('bug.json');
    vi.advanceTimersByTime(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording');
    click.mockRestore();
  });
});

describe('createReplayWebSocket', () => {
  it('replays each recorded connection, waiting for the app to send what it sent', async () => {
    const Replay = createReplayWebSocket(chat);
    const client = createWebSocket('ws://chat', {
      WebSocket: as(Replay),
      binaryType: 'arraybuffer',
      reconnect: { minDelay: 1000, jitter: 0 }
    });
    const received: unknown[] = [];
    client.on('message', message => received.push(message));
    client.connect();
    vi.advanceTimersByTime(20);
    expect(client.getSnapshot().status).toBe('open');
    expect(received).toEqual(['welcome']);

    // The app takes 3 s to ask instead of 0.5 s: the answer waits for it.
    vi.advanceTimersByTime(3000);
    expect(received).toEqual(['welcome']);
    client.send('question');
    vi.advanceTimersByTime(99);
    expect(received).toEqual(['welcome']);
    vi.advanceTimersByTime(1);
    expect(received).toEqual(['welcome', 'answer 1']);
    vi.advanceTimersByTime(300);
    expect(received).toEqual(['welcome', 'answer 1', 'answer 2']);
    expect(client.getSnapshot().status).toBe('reconnecting');

    // The client reconnects: the second recorded connection plays.
    vi.advanceTimersByTime(1000 + 50);
    expect(client.socket?.protocol).toBe('v1');
    expect(received.at(-1)).toEqual(new Uint8Array([1, 2]).buffer);
    expect(Replay.sent).toEqual([['question'], []]);
    await expect(Replay.done).resolves.toBeUndefined();

    // A connection beyond the recording is refused.
    client.reconnect();
    vi.advanceTimersByTime(1);
    expect(client.getSnapshot().status).toBe('reconnecting');
    client.close();
  });

  it('plays faster with speed, and follows the clock alone without waitForSends', () => {
    const Replay = createReplayWebSocket(chat, { speed: 10, waitForSends: false });
    const client = createWebSocket('ws://chat', { WebSocket: as(Replay), reconnect: false });
    const received: unknown[] = [];
    client.on('message', message => received.push(message));
    client.connect();
    vi.advanceTimersByTime(60); // 600 ms recorded, at 10x
    expect(received).toEqual(['welcome', 'answer 1']);
    vi.advanceTimersByTime(30);
    expect(client.getSnapshot().status).toBe('closed');
  });

  it('plays everything at once with speed Infinity, and starts over after reset()', async () => {
    const Replay = createReplayWebSocket(chat, { speed: Infinity, waitForSends: false });
    const socket = new Replay('ws://chat');
    const events: string[] = [];
    socket.onopen = () => events.push('open');
    socket.onmessage = event => events.push(String(event.data));
    socket.onclose = event => events.push(`close ${(event as CloseEvent).code}`);
    await vi.runAllTimersAsync();
    expect(events).toEqual(['open', 'welcome', 'answer 1', 'answer 2', 'close 1006']);
    Replay.reset();
    expect(Replay.sent).toEqual([]);
    const again = new Replay('ws://chat');
    await vi.runAllTimersAsync();
    expect(again.readyState).toBe(3);
  });

  it('closes when the app closes, and refuses sends before open', () => {
    const Replay = createReplayWebSocket(chat);
    const socket = new Replay('ws://chat');
    expect(() => socket.send('early')).toThrow('CONNECTING');
    const closes: number[] = [];
    socket.onclose = event => closes.push((event as CloseEvent).code);
    vi.advanceTimersByTime(10);
    socket.close(4001, 'done');
    socket.send('after close');
    vi.advanceTimersByTime(10_000);
    expect(closes).toEqual([4001]);
    expect(Replay.sent).toEqual([[]]);
  });

  it('takes chaos on top, for faults that never happened in the recording', () => {
    const Replay = createReplayWebSocket(chat, { waitForSends: false });
    const Chaos = createChaosWebSocket({ WebSocket: as(Replay) });
    const client = createWebSocket('ws://chat', { WebSocket: Chaos, reconnect: false });
    client.connect();
    vi.advanceTimersByTime(20);
    expect(client.getSnapshot().status).toBe('open');
    Chaos.drop();
    expect(client.getSnapshot().status).toBe('closed');
  });
});
