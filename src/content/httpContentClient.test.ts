import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpContentClient, fetchProgramPosition } from './httpContentClient';

afterEach(() => vi.unstubAllGlobals());

describe('createHttpContentClient', () => {
  it('times out a stalled request instead of hanging', async () => {
    // The request remains pending until its timeout signal aborts.
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'TimeoutError')),
          );
        }),
    );
    const client = createHttpContentClient({ timeoutMs: 25 });
    await expect(client.upcoming(null, 4)).rejects.toThrow();
  });

  it('sends channel + tag filter on every request', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const client = createHttpContentClient({
      channel: 'all',
      filter: { includeTags: new Set(['indie']), excludeTags: new Set(), matchAll: false },
    });
    await client.upcoming(null, 4);
    expect(urls[0]).toContain('include=indie');
    expect(urls[0]).toContain('channel=all');
  });

  it('loads the current server position and accepts an empty timeline', async () => {
    const position = {
      clip: {
        clipId: 'clip-1',
        title: 'Studio Session',
        url: '/clips/session.mp4',
        durationSec: 60,
        cursor: 'cursor-1',
        tags: [],
      },
      timeSec: 18,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(position), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);

    const controller = new AbortController();
    await expect(fetchProgramPosition('wbru-tv', controller.signal)).resolves.toEqual(position);
    expect(fetcher.mock.calls[0][0]).toBe('/api/program/position?channel=wbru-tv');
    await expect(fetchProgramPosition('wbru-tv', controller.signal)).resolves.toBeNull();
  });

  it('aborts all outstanding requests when destroyed', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error('missing request signal'));
            return;
          }
          signals.push(init.signal);
          init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    const client = createHttpContentClient({
      channel: 'wbru-tv',
    });

    const requests = [client.upcoming(null, 4), client.upcoming('next-cursor', 4)];
    client.destroy();

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const results = await Promise.allSettled(requests);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
  });
});
