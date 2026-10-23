import { describe, expect, it, vi } from 'vitest';
import { createClipQueue } from './clipQueue';
import type { ContentClient } from './contentClient';
import type { ClipRef } from '../../shared/contract';

function createFakeClient(options: { total?: number; fail?: () => boolean } = {}) {
  const requests: { after: string | null; limit: number }[] = [];
  const createClipRef = (position: number): ClipRef => ({
    clipId: `clip${position}`,
    title: `clip${position}`,
    url: `/clips/${position}.mp4`,
    durationSec: 0,
    tags: [],
    cursor: String(position),
  });
  const destroy = vi.fn();
  const client: ContentClient = {
    destroy,
    async upcoming(after, limit) {
      requests.push({ after, limit });
      if (options.fail?.()) throw new Error('network down');
      const start = after === null ? 0 : Number(after) + 1;
      const batchSize = Math.max(0, Math.min(limit, (options.total ?? Infinity) - start));
      return Array.from({ length: batchSize }, (_, offset) => createClipRef(start + offset));
    },
  };
  return { client, requests, destroy };
}

describe('createClipQueue', () => {
  it('serves clips in program order, batching requests', async () => {
    const { client, requests } = createFakeClient();
    const queue = createClipQueue(client, { queueAhead: 4 });
    expect((await queue.next())?.clipId).toBe('clip0');
    expect((await queue.next())?.clipId).toBe('clip1');
    expect(requests[0]).toEqual({ after: null, limit: 4 });
  });

  it('advances the cursor between batches (no repeats, no skips)', async () => {
    const { client, requests } = createFakeClient();
    const queue = createClipQueue(client, { queueAhead: 2 });
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) ids.push((await queue.next())!.clipId);
    expect(ids).toEqual(['clip0', 'clip1', 'clip2', 'clip3', 'clip4', 'clip5']);
    for (const request of requests.slice(1)) expect(request.after).not.toBeNull();
  });

  it('continues after an initial played cursor', async () => {
    const { client, requests } = createFakeClient();
    const queue = createClipQueue(client, { queueAhead: 3, initialCursor: '7' });
    expect((await queue.next())?.clipId).toBe('clip8');
    expect(requests[0]).toEqual({ after: '7', limit: 3 });
  });

  it('returns null when the program is empty', async () => {
    const empty = createFakeClient({ total: 0 });
    const queue = createClipQueue(empty.client, { queueAhead: 3 });
    expect(await queue.next()).toBeNull();
  });

  it('coalesces concurrent drains into a single request', async () => {
    const { client, requests } = createFakeClient();
    let resolveBatch!: () => void;
    const delayedClient: ContentClient = {
      ...client,
      upcoming: async (after, limit) => {
        await new Promise<void>((resolve) => (resolveBatch = resolve));
        return client.upcoming(after, limit);
      },
    };
    const queue = createClipQueue(delayedClient, { queueAhead: 4 });
    const firstPull = queue.next();
    const secondPull = queue.next();
    resolveBatch();
    const [firstClip, secondClip] = await Promise.all([firstPull, secondPull]);
    expect(requests).toHaveLength(1);
    expect(firstClip?.clipId).toBe('clip0');
    expect(secondClip?.clipId).toBe('clip1');
  });

  it('reports a transient fetch error and retries on the next pull', async () => {
    let failing = true;
    const { client, requests } = createFakeClient({ fail: () => failing });
    const queue = createClipQueue(client, { queueAhead: 3 });
    await expect(queue.next()).rejects.toThrow('network down');
    failing = false;
    expect((await queue.next())?.clipId).toBe('clip0');
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });

  it('tops up in the background before draining', async () => {
    const { client, requests } = createFakeClient();
    const queue = createClipQueue(client, { queueAhead: 4 });
    await queue.next();
    await queue.next();
    await queue.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.length).toBe(2);
    expect(requests[1].after).toBe('3');
    expect(requests[1].limit).toBe(2);
  });
  it('destroys its client and settles a canceled pull as empty', async () => {
    let rejectRequest!: (reason?: unknown) => void;
    const destroy = vi.fn(() => rejectRequest(new DOMException('aborted', 'AbortError')));
    const client: ContentClient = {
      destroy,
      upcoming: () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    };
    const queue = createClipQueue(client);
    const pending = queue.next();

    queue.destroy();
    queue.destroy();

    await expect(pending).resolves.toBeNull();
    await expect(queue.next()).resolves.toBeNull();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
