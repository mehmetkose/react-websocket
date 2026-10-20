'use client';

/**
 * ServerRingHero — line-art hero animation for react-websocket.
 *
 * A hub server sits in the middle of a ring of client servers. Traffic is
 * asynchronous and overlapping: clients broadcast through the hub to everyone,
 * relay messages to one other client, send ping/pong heartbeats, and now and
 * then drop their link and reconnect with a handshake.
 *
 *  - Zero dependencies (React only), one <canvas>, ~60fps.
 *  - Lines use the CSS `color` of the wrapper, so it follows light/dark themes.
 *  - Messages use `accent`, or the CSS variable --rws-accent, or Rspress's
 *    --rp-c-brand, in that order. Heartbeats and reconnect handshakes have
 *    their own colours (`heartbeat` / --rws-heartbeat, `handshake` / --rws-handshake).
 *  - Click or tap a client to make it broadcast; click the hub to broadcast.
 *  - Pauses offscreen; respects prefers-reduced-motion (static until clicked).
 *  - SSR-safe: nothing touches the DOM until the component mounts.
 *  - The animation itself is in ./mountServerRing, imported when the component
 *    mounts, so the theme bundle every docs page loads doesn't carry it.
 *
 * `mountServerRing(element, options)` mounts the same animation without React
 * (e.g. from a non-React page).
 */

import { useEffect, useRef } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';
import type { ServerRingController, ServerRingOptions } from './mountServerRing';

export type {
  ServerRingController,
  ServerRingEvent,
  ServerRingOptions,
  ServerRingTraffic
} from './mountServerRing';

export interface ServerRingHeroProps extends ServerRingOptions {
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  /** Receives the controller, e.g. to call `controller.current?.send()` from a button. */
  controller?: MutableRefObject<ServerRingController | null>;
}

export function ServerRingHero({
  className,
  style,
  'aria-label': ariaLabel,
  controller,
  ...options
}: ServerRingHeroProps) {
  const host = useRef<HTMLDivElement>(null);
  const ctrl = useRef<ServerRingController | null>(null);
  // The latest options, for an animation that starts once its module has loaded.
  const latest = useRef(options);
  const nodes = options.nodes ?? 8;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let c: ServerRingController | null = null;
    let unmounted = false;
    import('./mountServerRing')
      .then(({ mountServerRing }) => {
        if (unmounted) return;
        c = mountServerRing(el, latest.current);
        ctrl.current = c;
        if (controller) controller.current = c;
      })
      // It's decoration: if the chunk doesn't load, the box stays empty.
      .catch(() => {});
    return () => {
      unmounted = true;
      c?.destroy();
      ctrl.current = null;
      if (controller) controller.current = null;
    };
    // Geometry depends only on `nodes`; everything else is live-updated below.
    // eslint-disable-next-line react/exhaustive-deps
  }, [nodes]);

  useEffect(() => {
    latest.current = options;
    ctrl.current?.update(options);
  });

  return (
    <div
      ref={host}
      className={className}
      role="img"
      aria-label={
        ariaLabel ??
        'Illustration: client servers around a central server exchange messages, broadcasts, heartbeats and reconnects.'
      }
      style={{ position: 'relative', width: '100%', aspectRatio: '7 / 6', ...style }}
    />
  );
}

export default ServerRingHero;
