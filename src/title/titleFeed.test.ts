import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../shared/routes';
import { fetchCurrentPlayout, mountTitleOverlay, startPolling } from './titleFeed';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mountTitleOverlay', () => {
  it.each([
    { publishedYear: undefined, expectedTitle: 'Studio Session' },
    { publishedYear: null, expectedTitle: 'Studio Session' },
    { publishedYear: 2014, expectedTitle: 'Studio Session (2014)' },
  ])('shows $expectedTitle and hides it when stopped', async ({ publishedYear, expectedTitle }) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          outputId: 'wbru-tv',
          channelId: 'wbru-tv',
          clipId: 'clip-1',
          title: 'Studio Session',
          publishedYear,
          startedAt: '2026-08-26T12:00:00.000Z',
          durationSec: 60,
        }),
      ),
    );
    const overlay = {
      classList: { add: vi.fn(), remove: vi.fn() },
      setAttribute: vi.fn(),
    } as unknown as HTMLElement;
    const title = { textContent: '' } as HTMLElement;

    const stop = mountTitleOverlay('wbru-tv', overlay, title);
    await vi.advanceTimersByTimeAsync(0);

    expect(title.textContent).toBe(expectedTitle);
    expect(overlay.classList.add).toHaveBeenCalledWith('visible');
    expect(overlay.setAttribute).toHaveBeenCalledWith('aria-hidden', 'false');

    stop();
    expect(overlay.classList.remove).toHaveBeenCalledWith('visible');
    expect(overlay.setAttribute).toHaveBeenLastCalledWith('aria-hidden', 'true');
  });

  it('updates the year when metadata changes during the same clip', async () => {
    vi.useFakeTimers();
    const playout = {
      outputId: 'wbru-tv',
      channelId: 'wbru-tv',
      clipId: 'clip-1',
      title: 'Studio Session',
      startedAt: '2026-08-26T12:00:00.000Z',
      durationSec: 60,
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ...playout, publishedYear: null }))
        .mockResolvedValueOnce(Response.json({ ...playout, publishedYear: 2014 })),
    );
    const overlay = {
      classList: { add: vi.fn(), remove: vi.fn() },
      setAttribute: vi.fn(),
    } as unknown as HTMLElement;
    const title = { textContent: '' } as HTMLElement;

    const stop = mountTitleOverlay('wbru-tv', overlay, title);
    await vi.advanceTimersByTimeAsync(0);
    expect(title.textContent).toBe('Studio Session');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(title.textContent).toBe('Studio Session (2014)');
    stop();
  });
});

describe('fetchCurrentPlayout', () => {
  it('fetches the current playout response', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        outputId: 'wbru-tv-main',
        channelId: 'wbru-tv',
        clipId: 'clip-1',
        title: 'Studio Session',
        startedAt: '2026-08-26T12:00:00.000Z',
        durationSec: 60,
      }),
    );
    const signal = new AbortController().signal;

    await expect(fetchCurrentPlayout('wbru-tv-main', signal, fetcher)).resolves.toMatchObject({
      clipId: 'clip-1',
      title: 'Studio Session',
    });
    expect(fetcher).toHaveBeenCalledWith(
      `${routes.programCurrent}?output=wbru-tv-main`,
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    );
  });

  it('returns null for an empty current playout', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      fetchCurrentPlayout('main', new AbortController().signal, fetcher),
    ).resolves.toBeNull();
  });

  it('aborts a request that exceeds the polling timeout', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const request = fetchCurrentPlayout('main', new AbortController().signal, fetcher);
    timeout.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('startPolling', () => {
  it('waits for the active poll before starting another', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const stop = startPolling(poll, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(1);

    finish?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
  });

  it('aborts an active poll and does not poll again after stopping', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const poll = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          requestSignal = signal;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );

    const stop = startPolling(poll, 1_000);
    stop();

    expect(requestSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('cancels the next poll when stopped between requests', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(() => Promise.resolve());

    const stop = startPolling(poll, 1_000);
    await vi.advanceTimersByTimeAsync(500);
    stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poll).toHaveBeenCalledTimes(1);
  });
});
