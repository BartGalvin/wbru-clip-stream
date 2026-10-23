import type { ContentClient } from './contentClient';
import type { ClipRef } from '../../shared/contract';

// The queue coalesces refills and owns the lifetime of its content client.
export interface ClipQueue {
  next(): Promise<ClipRef | null>;
  destroy(): void;
}

// Keep a small client-side lookahead without allowing overlapping page requests.
export function createClipQueue(
  client: ContentClient,
  opts: { queueAhead?: number; initialCursor?: string | null } = {},
): ClipQueue {
  const queueAhead = Math.max(1, opts.queueAhead ?? 8);
  const refillAt = Math.max(1, Math.floor(queueAhead / 2));

  const queue: ClipRef[] = [];
  let cursor: string | null = opts.initialCursor ?? null;
  let refillInFlight: Promise<void> | null = null;
  let destroyed = false;

  // Fetch only enough clips to restore the configured lookahead.
  function refill(): Promise<void> {
    if (destroyed) return Promise.resolve();
    if (refillInFlight) return refillInFlight;
    if (queue.length >= queueAhead) return Promise.resolve();
    refillInFlight = (async () => {
      try {
        const items = await client.upcoming(cursor, queueAhead - queue.length);
        if (!destroyed && items.length) {
          queue.push(...items);
          cursor = items[items.length - 1].cursor;
        }
      } finally {
        refillInFlight = null;
      }
    })();
    return refillInFlight;
  }

  return {
    async next() {
      // Wait for an empty queue, but refill a low queue in the background.
      if (destroyed) return null;
      try {
        if (!queue.length) await refill();
        else if (queue.length <= refillAt) void refill().catch(() => {});
      } catch (error) {
        if (destroyed) return null;
        throw error;
      }
      if (destroyed) return null;
      return queue.shift() ?? null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      queue.length = 0;
      client.destroy();
    },
  };
}
