import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { createWebSocket, createWebSocketResponder, useAgentApproval } from '../src';
import type { WebSocketResponder } from '../src';
import { MockImpl, MockWebSocket } from './mock';

type Params = { text: string };
type In = { type: 'call'; id: number; method: string; params?: Params } | { type: 'chat' };
type Out = { type: 'result'; id: number | string; result?: unknown; error?: string };

let n = 0;

function setup() {
  const client = createWebSocket<In, Out>(`ws://approval/${++n}`, {
    WebSocket: MockImpl,
    json: true
  });
  const tools = createWebSocketResponder(client, {
    request: message => (message.type === 'call' ? message : undefined),
    respond: (id, result: { approved: boolean }) => ({ type: 'result', id, result }),
    error: (id, error) => ({ type: 'result', id, error: String(error) })
  });
  return { client, tools };
}

const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));
const call = (id: number, method: string, params?: Params) =>
  act(() => MockWebSocket.last.receive(JSON.stringify({ type: 'call', id, method, params })));

function Approvals({
  tools,
  method = 'approve'
}: {
  tools: WebSocketResponder<Params | undefined, { approved: boolean }> | null;
  method?: string | null;
}) {
  const requests = useAgentApproval(tools, method);
  return (
    <>
      {requests.map(request => (
        <button key={request.id} onClick={() => request.respond({ approved: true })}>
          {request.params?.text}
        </button>
      ))}
    </>
  );
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAgentApproval', () => {
  it('renders waiting requests for its method, and re-renders when one is answered', () => {
    const { tools } = setup();
    tools.onRequest('other');
    const view = render(<Approvals tools={tools} />);
    act(() => MockWebSocket.last.open());
    call(1, 'approve', { text: 'Refund $20?' });
    call(2, 'other', { text: 'Not mine' });
    call(3, 'approve', { text: 'Send email?' });
    expect(view.container.textContent).toBe('Refund $20?Send email?');

    act(() => view.getByText('Refund $20?').click());
    expect(view.container.textContent).toBe('Send email?');
    expect(sent()).toEqual([{ type: 'result', id: 1, result: { approved: true } }]);
  });

  it('registers once under StrictMode, and unregisters on unmount', () => {
    const { client, tools } = setup();
    client.connect();
    const view = render(
      <StrictMode>
        <Approvals tools={tools} />
      </StrictMode>
    );
    act(() => MockWebSocket.last.open());
    call(1, 'approve', { text: 'Refund $20?' });
    expect(view.container.textContent).toBe('Refund $20?');
    expect(sent()).toEqual([]);

    view.unmount();
    call(2, 'approve');
    expect(sent()).toEqual([
      { type: 'result', id: 2, error: expect.stringContaining('NotFoundError') }
    ]);
  });

  it('shows requests still waiting after a remount', () => {
    const { client, tools } = setup();
    client.connect();
    const first = render(<Approvals tools={tools} />);
    act(() => MockWebSocket.last.open());
    call(1, 'approve', { text: 'Refund $20?' });
    first.unmount();
    expect(tools.getSnapshot()).toHaveLength(1);

    const second = render(<Approvals tools={tools} />);
    expect(second.container.textContent).toBe('Refund $20?');
  });

  it('holds the connection while mounted', () => {
    const { client, tools } = setup();
    const view = render(<Approvals tools={tools} />);
    expect(client.getSnapshot().status).toBe('connecting');
    act(() => MockWebSocket.last.open());
    view.unmount();
    act(() => vi.advanceTimersByTime(0));
    expect(client.getSnapshot().status).toBe('idle');
  });

  it('holds nothing for a null responder or method', () => {
    const { tools } = setup();
    const view = render(
      <>
        <Approvals tools={null} />
        <Approvals tools={tools} method={null} />
      </>
    );
    expect(view.container.textContent).toBe('');
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
