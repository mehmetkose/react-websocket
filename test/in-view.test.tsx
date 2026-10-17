import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { createWebSocket, createWebSocketTopics, useInView, useWebSocketTopic } from '../src';
import { MockImpl, MockWebSocket } from './mock';

/** A stand-in for the browser's IntersectionObserver that tests drive by hand. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  elements: Element[] = [];
  disconnected = false;
  constructor(
    public callback: (entries: { isIntersecting: boolean; target: Element }[]) => void,
    public options: IntersectionObserverInit
  ) {
    FakeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.elements.push(element);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Report whether the observed element now intersects. */
  set(isIntersecting: boolean) {
    act(() => this.callback([{ isIntersecting, target: this.elements[0]! }]));
  }
}

beforeEach(() => {
  MockWebSocket.reset();
  FakeObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe(props: { rootMargin?: string; initial?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  return <p ref={ref}>{String(useInView(ref, props))}</p>;
}

describe('useInView', () => {
  it('follows whether the element intersects the viewport', () => {
    const { container } = render(<Probe rootMargin="200px" />);
    expect(container.textContent).toBe('false');
    const [observer] = FakeObserver.instances;
    expect(observer!.elements).toEqual([container.firstChild]);
    expect(observer!.options).toEqual({ rootMargin: '200px', threshold: undefined });
    observer!.set(true);
    expect(container.textContent).toBe('true');
    observer!.set(false);
    expect(container.textContent).toBe('false');
  });

  it('starts from `initial`, and stays there without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(render(<Probe initial />).container.textContent).toBe('true');
    expect(render(<Probe />).container.textContent).toBe('false');
  });

  it('disconnects on unmount', () => {
    const { unmount } = render(<Probe />);
    unmount();
    expect(FakeObserver.instances[0]!.disconnected).toBe(true);
  });

  it('switches topic subscriptions as a card scrolls in and out of view', () => {
    vi.useFakeTimers();
    const client = createWebSocket('ws://in-view', { WebSocket: MockImpl, json: true });
    const topics = createWebSocketTopics(client, {
      subscribe: topic => ({ type: 'subscribe', topic }),
      unsubscribe: topic => ({ type: 'unsubscribe', topic })
    });
    function Card() {
      const ref = useRef<HTMLElement>(null);
      useWebSocketTopic(topics, useInView(ref) ? 'run:1:tokens' : 'run:1:status');
      return <article ref={ref} />;
    }
    render(<Card />);
    act(() => MockWebSocket.last.open());
    FakeObserver.instances[0]!.set(true);
    act(() => vi.advanceTimersByTime(0));
    FakeObserver.instances[0]!.set(false);
    act(() => vi.advanceTimersByTime(0));
    expect(MockWebSocket.last.sent.map(data => JSON.parse(data as string))).toEqual([
      { type: 'subscribe', topic: 'run:1:status' },
      { type: 'subscribe', topic: 'run:1:tokens' },
      { type: 'unsubscribe', topic: 'run:1:status' },
      { type: 'subscribe', topic: 'run:1:status' },
      { type: 'unsubscribe', topic: 'run:1:tokens' }
    ]);
    vi.useRealTimers();
  });
});
