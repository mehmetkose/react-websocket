'use client';

import { useWebSocketStatus } from 'react-websocket';
import { live } from '@/lib/live';

/** Re-renders only when the status changes, not on every message. */
export function StatusBadge() {
  const status = useWebSocketStatus(live);
  return (
    <span className="badge" data-status={status}>
      {status}
    </span>
  );
}
