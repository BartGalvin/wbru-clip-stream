import { describe, expect, it, vi } from 'vitest';
import type { RecentPlayout } from '../../shared/contract';
import { routes } from '../../shared/routes';
import {
  fetchPlayoutChannels,
  fetchPlayoutPage,
  PLAYOUT_LOOKBACK_MS,
  PLAYOUT_PAGE_SIZE,
} from './playoutLog';

const NOW = Date.parse('2026-08-29T16:00:00Z');

function event(overrides: Partial<RecentPlayout> = {}): RecentPlayout {
  return {
    id: 1,
    outputId: 'visualizer-main',
    channelId: 'indie',
    clipId: 'clip-1',
    cursor: 'slot-1',
    title: 'First clip',
    path: 'first.mp4',
    library: 'visualizer',
    source: null,
    previewUrl: '/clips/first.mp4',
    durationSec: 60,
    startedAt: '2026-08-29T15:00:00.000Z',
    ...overrides,
  };
}

describe('playout history', () => {
  it('lists server-timed channels from channel configuration', async () => {
    const channels = [
      { id: 'indie', name: 'Indie', timeline: 'server' },
      { id: 'preview', name: 'Preview' },
      { id: 'wbru-tv', name: 'WBRU TV', timeline: 'server' },
    ];
    const signal = new AbortController().signal;
    const fetcher = vi.fn().mockResolvedValue(Response.json(channels));

    await expect(fetchPlayoutChannels({ signal, fetcher })).resolves.toEqual([
      { id: 'indie', name: 'Indie', accent: '#49d6a2' },
      { id: 'wbru-tv', name: 'WBRU TV', accent: '#f1b85b' },
    ]);
    expect(fetcher).toHaveBeenCalledWith(routes.channels, { cache: 'no-store', signal });
  });

  it('fetches one channel page with a search and retention cutoff', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json([event()]));
    const signal = new AbortController().signal;

    await expect(
      fetchPlayoutPage({
        channelId: 'indie',
        search: '  first  ',
        signal,
        fetcher,
        nowMs: NOW,
      }),
    ).resolves.toEqual({ items: [event()] });

    const [request, options] = fetcher.mock.calls[0] as [string, RequestInit];
    const url = new URL(request, 'http://localhost');
    expect(url.pathname).toBe(routes.tagsPlayout);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      channel: 'indie',
      limit: String(PLAYOUT_PAGE_SIZE),
      since: new Date(NOW - PLAYOUT_LOOKBACK_MS).toISOString(),
      q: 'first',
    });
    expect(options).toEqual({ cache: 'no-store', signal });
  });

  it('returns a cursor when another page may be available', async () => {
    const batch = Array.from({ length: PLAYOUT_PAGE_SIZE }, (_, index) =>
      event({ id: 200 - index }),
    );
    const fetcher = vi.fn().mockResolvedValue(Response.json(batch));

    const page = await fetchPlayoutPage({
      channelId: '360',
      beforeId: 201,
      fetcher,
      nowMs: NOW,
    });

    expect(page).toEqual({ items: batch, nextBeforeId: 101 });
    const [request] = fetcher.mock.calls[0] as [string];
    expect(new URL(request, 'http://localhost').searchParams.get('beforeId')).toBe('201');
  });

  it('fetches new events across all channels without an older-page cursor', async () => {
    const batch = [event({ id: 100 }), event({ id: 101 })];
    const fetcher = vi.fn().mockResolvedValue(Response.json(batch));

    const page = await fetchPlayoutPage({
      afterId: 99,
      limit: 2,
      fetcher,
      nowMs: NOW,
    });

    expect(page).toEqual({ items: batch });
    const [request] = fetcher.mock.calls[0] as [string];
    const params = new URL(request, 'http://localhost').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      limit: '2',
      since: new Date(NOW - PLAYOUT_LOOKBACK_MS).toISOString(),
      afterId: '99',
    });
  });

  it('surfaces a failed history request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(fetchPlayoutPage({ channelId: 'wbru-tv', fetcher, nowMs: NOW })).rejects.toThrow(
      '503',
    );
  });

  it('keeps pagination and search inside a historical time window', async () => {
    const until = '2026-08-25T18:30:00.000Z';
    const fetcher = vi.fn().mockResolvedValue(Response.json([]));
    await fetchPlayoutPage({
      channelId: 'indie',
      beforeId: 200,
      search: 'session',
      until,
      nowMs: NOW,
      fetcher,
    });
    expect(
      Object.fromEntries(new URL(fetcher.mock.calls[0][0], 'http://localhost').searchParams),
    ).toEqual({
      channel: 'indie',
      beforeId: '200',
      q: 'session',
      until,
      limit: String(PLAYOUT_PAGE_SIZE),
      since: new Date(NOW - PLAYOUT_LOOKBACK_MS).toISOString(),
    });
  });
});
