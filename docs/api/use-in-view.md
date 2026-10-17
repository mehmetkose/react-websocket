---
description: 'useInView: whether an element is on screen, from an IntersectionObserver, to stream full detail only for the WebSocket topics on screen.'
---

# useInView

Whether an element is on screen, from an `IntersectionObserver`. Pick a topic with it, so components stream full detail only while they're visible.

```ts
function useInView(
  ref: RefObject<Element | null>,
  options?: { rootMargin?: string; threshold?: number; initial?: boolean }
): boolean;
```

## Usage

```tsx
import { useRef } from 'react';
import { useInView, useWebSocketTopic } from 'react-websocket';

function RunCard({ id }: { id: string }) {
  const ref = useRef<HTMLElement>(null);
  useWebSocketTopic(feeds, useInView(ref) ? `run:${id}:tokens` : `run:${id}:status`);
  return <article ref={ref}>…</article>;
}
```

The guide is [Dashboards of many runs](../guide/agents.md#dashboards-of-many-runs).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `ref` | `RefObject<Element \| null>` | The element to watch |
| `options.rootMargin` | `string` | Optional. Grow (or shrink) the viewport by this much, like the `IntersectionObserver` option, e.g. `'200px'` to count an element as visible a little before it is |
| `options.threshold` | `number` | Optional. How much of the element must be visible, from `0` (any of it, the default) to `1` (all of it) |
| `options.initial` | `boolean` | Optional. The value before the first observation, on the server, and where `IntersectionObserver` doesn't exist. Default `false` |

## Returns

`true` while the element intersects the viewport, inside any scrolling containers it's in.

## Behavior

- **Clipping.** The viewport is the root, and scrolling containers clip it, so a card scrolled out of a panel counts as off screen.
- **Changing options.** A new `rootMargin` or `threshold` starts a new observer.
- **Without `IntersectionObserver`.** It stays at `initial`. Every current browser has it.
