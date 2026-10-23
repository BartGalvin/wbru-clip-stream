import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInfo } from '../../shared/contract';
import { waitForChannel, waitForProgramPosition } from './channel';

const RETRY_MS = 25;
const channel: ChannelInfo = {
  id: 'wbru-tv',
  name: 'WBRU TV',
  program: {
    video: {
      kind: 'clips',
      library: 'visualizer',
      filter: { includeTags: [], excludeTags: [], matchAll: false },
    },
    audio: { kind: 'embedded' },
  },
};
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  {
    name: 'channel request',
    request: waitForChannel,
    url: '/api/channel?channel=wbru-tv',
    data: channel,
  },
  {
    name: 'program position',
    request: waitForProgramPosition,
    url: '/api/program/position?channel=wbru-tv',
    data: position,
  },
])('$name startup', ({ name, request, url, data }) => {
  beforeEach(() => vi.useFakeTimers());

  it.each([
    ['503', new Response(null, { status: 503 })],
    ['408', new Response(null, { status: 408 })],
    ['429', new Response(null, { status: 429 })],
    ['network failure', new TypeError('network unavailable')],
    ['timeout', new DOMException('timed out', 'TimeoutError')],
  ])('retries a transient %s and returns the response', async (_name, failure) => {
    const fetcher = vi.fn();
    if (failure instanceof Response) fetcher.mockResolvedValueOnce(failure);
    else fetcher.mockRejectedValueOnce(failure);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetcher);
    const onRetry = vi.fn();
    const result = request('wbru-tv', {
      signal: new AbortController().signal,
      onRetry,
      retryMs: RETRY_MS,
    });

    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(url);
  });

  it.each([400, 401, 403, 404])('surfaces a permanent %s without retrying', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetcher);
    const onRetry = vi.fn();

    await expect(
      request('missing', { signal: new AbortController().signal, onRetry }),
    ).rejects.toThrow(`${name} failed: ${status}`);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid json')));
    const onRetry = vi.fn();

    await expect(
      request('wbru-tv', { signal: new AbortController().signal, onRetry }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not make a request if startup was already canceled', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    controller.abort();

    await expect(request('wbru-tv', { signal: controller.signal, onRetry: vi.fn() })).rejects.toBe(
      controller.signal.reason,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels a pending request without retrying', async () => {
    const fetcher = vi.fn(
      (_url: string, { signal }: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const onRetry = vi.fn();
    const result = request('wbru-tv', { signal: controller.signal, onRetry });

    controller.abort();
    await expect(result).rejects.toBe(controller.signal.reason);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the retry delay immediately on page teardown', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const onRetry = vi.fn();
    const result = request('wbru-tv', {
      signal: controller.signal,
      onRetry,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(await result).toBe(controller.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

it('accepts an empty timeline without retrying', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const onRetry = vi.fn();

  await expect(
    waitForProgramPosition('wbru-tv', { signal: new AbortController().signal, onRetry }),
  ).resolves.toBeNull();
  expect(onRetry).not.toHaveBeenCalled();
});
