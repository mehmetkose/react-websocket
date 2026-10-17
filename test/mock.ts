type Handler = ((event: any) => void) | null;

/** Controllable stand-in for the browser WebSocket. */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  static get last(): MockWebSocket {
    const socket = MockWebSocket.instances.at(-1);
    if (!socket) throw new Error('no socket was created');
    return socket;
  }

  readyState = 0;
  binaryType = 'blob';
  /** Set it to simulate a congested link. */
  bufferedAmount = 0;
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;

  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    if (url === 'invalid') throw new SyntaxError('invalid url');
    MockWebSocket.instances.push(this);
  }

  send(data: unknown) {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 2;
  }

  // Server/network side.

  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Finish a close, whether started by the client or the server. */
  finishClose(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

export const MockImpl = MockWebSocket as unknown as typeof WebSocket;
