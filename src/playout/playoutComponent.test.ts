// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecentPlayout } from '../../shared/contract';
import { PLAYOUT_LOOKBACK_MS } from './playoutLog';
import PlayoutLog from './PlayoutLog.svelte';

const api = vi.hoisted(() => ({
  fetchPlayoutChannels: vi.fn(),
  fetchPlayoutPage: vi.fn(),
  setClipInactive: vi.fn(),
}));

vi.mock('./playoutLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./playoutLog')>()),
  fetchPlayoutChannels: api.fetchPlayoutChannels,
  fetchPlayoutPage: api.fetchPlayoutPage,
  setClipInactive: api.setClipInactive,
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const NOW = Date.parse('2026-08-29T16:00:00Z');
const event: RecentPlayout = {
  id: 10,
  outputId: 'visualizer-main',
  channelId: 'indie',
  clipId: 'clip-1',
  cursor: 'slot-1',
  title: 'First clip',
  path: 'first.mp4',
  library: 'visualizer',
  source: null,
  previewUrl: '/clips/first.mp4',
  inactive: false,
  durationSec: 60,
  startedAt: '2026-08-29T15:00:00.000Z',
};
const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  api.fetchPlayoutChannels.mockResolvedValue([
    { id: 'indie', name: 'WBRU Indie', accent: '#49d6a2' },
  ]);
  api.fetchPlayoutPage.mockResolvedValue({ items: [] });
  document.body.innerHTML = '';
  resizeWindow(1600, 1000);
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  vi.useRealTimers();
});

async function renderLog(): Promise<void> {
  mounted.push(mount(PlayoutLog, { target: document.body }));
  await vi.waitFor(() => expect(document.querySelector('.loading-state')).toBeNull());
  await tick();
}

function resizeWindow(width: number, height: number): void {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
  });
  window.dispatchEvent(new Event('resize'));
}

function titles(channelId = 'indie'): (string | null)[] {
  return [
    ...document.querySelectorAll(
      '[aria-labelledby="' + channelId + '-heading"] .event-details strong',
    ),
  ].map((element) => element.textContent);
}

// Supply layout measurements that happy-dom does not calculate.
function scrollList(top: number, channelId = 'indie'): HTMLOListElement {
  const list = document.querySelector<HTMLOListElement>(
    `[aria-labelledby="${channelId}-heading"] .event-list`,
  )!;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1000 },
  });
  list.scrollTop = top;
  list.dispatchEvent(new Event('scroll'));
  return list;
}

async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
  await tick();
}

function setSearch(value: string): void {
  const input = document.querySelector<HTMLInputElement>('.search')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

it.each([
  [1600, 1000, 'vertical', 'ArrowLeft', '--preview-width'],
  [390, 844, 'horizontal', 'ArrowUp', '--preview-height'],
] as const)(
  'resizes the preview with its %s by %s window divider',
  async (width, height, orientation, growKey, property) => {
    resizeWindow(width, height);
    await renderLog();
    const divider = document.querySelector<HTMLDivElement>('[aria-label="Resize preview"]')!;
    expect(divider.getAttribute('aria-orientation')).toBe(orientation);
    const initial = Number(divider.getAttribute('aria-valuenow'));
    divider.setPointerCapture = vi.fn();
    divider.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 1,
        clientX: 300,
        clientY: 300,
        button: 0,
        bubbles: true,
      }),
    );
    divider.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        clientX: orientation === 'vertical' ? 200 : 300,
        clientY: orientation === 'horizontal' ? 200 : 300,
        bubbles: true,
      }),
    );
    await tick();
    expect(divider.setPointerCapture).toHaveBeenCalledWith(1);
    expect(divider.getAttribute('aria-valuenow')).toBe(String(initial + 100));
    expect(
      document.querySelector<HTMLElement>('.page-shell')!.style.getPropertyValue(property),
    ).toBe(`${initial + 100}px`);

    divider.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    divider.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 0, clientY: 0, bubbles: true }),
    );
    await tick();
    expect(divider.getAttribute('aria-valuenow')).toBe(String(initial + 100));
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: growKey, bubbles: true }));
    await tick();
    expect(divider.getAttribute('aria-valuenow')).toBe(String(initial + 116));
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await tick();
    expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemin'));
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await tick();
    expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemax'));
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await tick();
    expect(divider.getAttribute('aria-valuenow')).toBe(String(initial));
  },
);

it('debounces typing and uses the final trimmed search', async () => {
  api.fetchPlayoutPage.mockResolvedValue({ items: [event] });
  await renderLog();
  const calls = api.fetchPlayoutPage.mock.calls.length;

  setSearch('fi');
  await vi.advanceTimersByTimeAsync(200);
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(calls);
  setSearch('  first  ');
  await vi.advanceTimersByTimeAsync(249);
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  await tick();
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(calls + 2);
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ channelId: 'indie', search: 'first' }),
  );
});

it.each(['success', 'failure'])(
  'ignores a superseded search %s without disturbing the current preview',
  async (outcome) => {
    const pending = deferred<{ items: RecentPlayout[] }>();
    const replacement = { ...event, id: 11, title: 'Replacement clip' };
    api.fetchPlayoutPage.mockImplementation(({ channelId, search }) => {
      if (channelId && search === 'first') return pending.promise;
      return Promise.resolve({ items: [search === 'second' ? replacement : event] });
    });
    await renderLog();
    setSearch('first');
    await vi.advanceTimersByTimeAsync(250);
    const signal = api.fetchPlayoutPage.mock.lastCall![0].signal as AbortSignal;
    setSearch('second');
    await vi.advanceTimersByTimeAsync(250);
    await tick();
    expect(signal.aborted).toBe(true);
    expect(titles()).toEqual(['Replacement clip']);
    document.querySelector<HTMLButtonElement>('.event-preview')!.click();
    await tick();

    if (outcome === 'success') pending.resolve({ items: [event] });
    else pending.reject(new Error('obsolete search failed'));
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(titles()).toEqual(['Replacement clip']);
    expect(document.querySelector('.clip-preview h3')?.textContent).toBe('Replacement clip');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  },
);

it('releases pagination state when a replacement search fails', async () => {
  const olderPage = deferred<{ items: RecentPlayout[]; nextBeforeId?: number }>();
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [event], nextBeforeId: event.id })
    .mockReturnValueOnce(olderPage.promise)
    .mockRejectedValueOnce(new Error('offline'));
  await renderLog();
  scrollList(900);
  await vi.waitFor(() => expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(3));
  const signal = api.fetchPlayoutPage.mock.lastCall![0].signal as AbortSignal;

  const search = document.querySelector<HTMLInputElement>('.search')!;
  search.value = 'session';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
  await tick();

  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('.header-actions button')?.disabled).toBe(false);
  expect(signal.aborted).toBe(true);
  olderPage.resolve({ items: [{ ...event, id: 9, title: 'Canceled older clip' }] });
  await vi.advanceTimersByTimeAsync(0);
  await tick();
  expect(titles()).toEqual(['First clip']);
});

it('paginates channels independently and ignores repeated scrolls and duplicate rows', async () => {
  const indieOlder = deferred<{ items: RecentPlayout[]; nextBeforeId?: number }>();
  const tvOlder = deferred<{ items: RecentPlayout[] }>();
  const tv = { ...event, id: 20, channelId: 'wbru-tv', title: 'TV clip' };
  api.fetchPlayoutChannels.mockResolvedValue([
    { id: 'indie', name: 'Indie', accent: '#49d6a2' },
    { id: 'wbru-tv', name: 'WBRU TV', accent: '#f1b85b' },
  ]);
  api.fetchPlayoutPage.mockImplementation(({ channelId, beforeId }) => {
    if (beforeId === 10) return indieOlder.promise;
    if (beforeId === 20) return tvOlder.promise;
    if (beforeId === 9) return Promise.resolve({ items: [] });
    const item = channelId === 'indie' ? event : tv;
    return Promise.resolve({ items: [item], nextBeforeId: item.id });
  });
  await renderLog();
  scrollList(900);
  scrollList(900, 'wbru-tv');
  scrollList(900);
  await tick();
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(5);

  tvOlder.resolve({ items: [tv, { ...tv, id: 19, title: 'Older TV clip' }] });
  await vi.waitFor(() => expect(titles('wbru-tv')).toHaveLength(2));
  expect(titles()).toEqual(['First clip']);
  indieOlder.resolve({
    items: [event, { ...event, id: 9, title: 'Older indie clip' }],
    nextBeforeId: 9,
  });
  await vi.waitFor(() => expect(titles()).toHaveLength(2));
  expect(titles('wbru-tv')).toEqual(['TV clip', 'Older TV clip']);
  expect(titles()).toEqual(['First clip', 'Older indie clip']);

  scrollList(900);
  await tick();
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ channelId: 'indie', beforeId: 9 }),
  );
  scrollList(900, 'wbru-tv');
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(6);
});

it('prepends new events from the periodic history query', async () => {
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [{ ...event, id: 11, title: 'Second clip' }] });
  await renderLog();
  await poll();

  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ afterId: event.id, limit: 1_000 }),
  );
  expect(titles()).toEqual(['Second clip', 'First clip']);
});

it('retries the channel list after an initial connection failure', async () => {
  api.fetchPlayoutChannels.mockRejectedValueOnce(new Error('offline'));
  api.fetchPlayoutPage.mockResolvedValue({ items: [event] });
  await renderLog();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();

  await poll();
  expect(api.fetchPlayoutChannels).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(titles()).toEqual(['First clip']);
});

it('clears a polling error on an empty success and starts an empty log at zero', async () => {
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [] })
    .mockResolvedValueOnce({ items: [] })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [] })
    .mockResolvedValueOnce({ items: [event] });
  await renderLog();
  const updated = document.querySelector('.updated')?.textContent;
  await poll();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();

  await poll();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('.updated')?.textContent).not.toBe(updated);
  await poll();
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: 0 }));
  expect(titles()).toEqual(['First clip']);
});

it('includes events recorded between the initial channel requests without duplicates', async () => {
  const tvEvent = { ...event, id: 12, channelId: 'wbru-tv', title: 'TV clip' };
  const missedEvent = { ...event, id: 11, title: 'Next indie clip' };
  api.fetchPlayoutChannels.mockResolvedValue([
    { id: 'indie', name: 'Indie', accent: '#49d6a2' },
    { id: 'wbru-tv', name: 'WBRU TV', accent: '#f1b85b' },
  ]);
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [tvEvent] })
    .mockResolvedValueOnce({ items: [missedEvent, tvEvent] });
  await renderLog();
  await poll();

  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: 10 }));
  expect(titles()).toEqual(['Next indie clip', 'First clip']);
  expect(titles('wbru-tv')).toEqual(['TV clip']);
});

it('bounds the live view, keeps older pages reachable, and pauses while reading history', async () => {
  const backlog = Array.from({ length: 1_100 }, (_, index) => ({
    ...event,
    id: index + 11,
    title: 'Clip ' + (index + 11),
  }));
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: backlog.slice(0, 1_000) })
    .mockResolvedValueOnce({ items: backlog.slice(1_000) })
    .mockResolvedValueOnce({ items: backlog.slice(900, 1_000).reverse(), nextBeforeId: 911 });
  await renderLog();
  await poll();
  expect(titles()).toHaveLength(100);
  await poll();
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ afterId: 1_010 }),
  );
  expect(titles()).toEqual(
    backlog
      .slice(1_000)
      .reverse()
      .map((item) => item.title),
  );

  const list = scrollList(900);
  await vi.waitFor(() => expect(titles()).toHaveLength(200));
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ beforeId: 1_011 }),
  );
  expect(titles()).toEqual(
    backlog
      .slice(900)
      .reverse()
      .map((item) => item.title),
  );
  const calls = api.fetchPlayoutPage.mock.calls.length;
  await poll();
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(calls);

  list.scrollTop = 0;
  await poll();
  expect(titles()).toHaveLength(100);
});

it.each(['scrolled down', 'loading an older page', 'a clip is selected'])(
  'defers an in-flight poll while %s',
  async (mode) => {
    const loadingOlder = mode === 'loading an older page';
    const pending = deferred<{ items: RecentPlayout[] }>();
    const older = deferred<{ items: RecentPlayout[] }>();
    const next = { ...event, id: 11, title: 'Next clip' };
    api.fetchPlayoutPage
      .mockResolvedValueOnce({ items: [event] })
      .mockResolvedValueOnce({ items: [event], nextBeforeId: loadingOlder ? event.id : undefined })
      .mockReturnValueOnce(pending.promise);
    if (loadingOlder) api.fetchPlayoutPage.mockReturnValueOnce(older.promise);
    api.fetchPlayoutPage.mockResolvedValueOnce({ items: [next] });
    await renderLog();
    await poll();
    await poll();
    expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(3);
    const list = scrollList(loadingOlder ? 900 : mode === 'a clip is selected' ? 0 : 100);
    if (mode === 'a clip is selected') {
      document.querySelector<HTMLButtonElement>('.event-preview')!.click();
      await tick();
    }
    if (loadingOlder) {
      expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ beforeId: 10 }),
      );
      list.scrollTop = 0;
    }
    pending.resolve({ items: [next] });
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(titles()).toEqual(['First clip']);

    older.resolve({ items: [] });
    await tick();
    list.scrollTop = 0;
    if (mode === 'a clip is selected') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await tick();
    }
    await poll();
    expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: 10 }));
    expect(titles()).toEqual(['Next clip', 'First clip']);
  },
);

it('leaves a pending search still when an in-flight poll finishes', async () => {
  const pending = deferred<{ items: RecentPlayout[] }>();
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [event] })
    .mockReturnValueOnce(pending.promise);
  await renderLog();
  await poll();
  setSearch('different');
  pending.resolve({ items: [{ ...event, id: 11, title: 'New live clip' }] });
  await vi.advanceTimersByTimeAsync(0);
  await tick();
  expect(titles()).toEqual(['First clip']);
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(3);
});

it('aborts requests and clears polling and search timers when unmounted', async () => {
  const pending = deferred<{ items: RecentPlayout[] }>();
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [event] })
    .mockReturnValueOnce(pending.promise);
  await renderLog();
  await poll();
  const signal = api.fetchPlayoutPage.mock.lastCall![0].signal as AbortSignal;
  setSearch('different');
  await unmount(mounted.pop()!);
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  pending.resolve({ items: [{ ...event, id: 11 }] });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(3);

  api.fetchPlayoutPage.mockResolvedValue({ items: [event] });
  await renderLog();
  expect(titles()).toEqual(['First clip']);
  expect(document.querySelector<HTMLInputElement>('.search')?.value).toBe('');
  expect(api.fetchPlayoutPage.mock.lastCall![0].signal.aborted).toBe(false);
});

it('removes entries that leave the retained history window', async () => {
  const expiring = {
    ...event,
    startedAt: new Date(NOW - PLAYOUT_LOOKBACK_MS + 1_000).toISOString(),
  };
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [expiring] })
    .mockResolvedValueOnce({ items: [expiring] });
  await renderLog();
  expect(titles()).toEqual(['First clip']);
  await poll();
  expect(titles()).toEqual([]);
});

it('keeps the pane visible and loads video only while a clip is selected', async () => {
  api.fetchPlayoutPage.mockResolvedValue({
    items: [event, { ...event, id: 9, title: 'Second clip', previewUrl: '/clips/second.mp4' }],
  });
  await renderLog();
  expect(document.querySelector('aside.clip-preview')).not.toBeNull();
  expect(document.querySelector('.preview-unavailable')?.textContent).toBe('No clip selected.');
  expect(document.querySelector('video')).toBeNull();
  const calls = api.fetchPlayoutPage.mock.calls.length;

  document.querySelector<HTMLButtonElement>('.event-preview')!.click();
  await tick();
  const video = document.querySelector('video')!;
  expect(video.getAttribute('src')).toBe('/clips/first.mp4');
  expect(video.muted).toBe(true);
  expect(video.controls).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(document.querySelector('aside.clip-preview')).not.toBeNull();
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.querySelector('.event-preview.selected')).not.toBeNull();
  await poll();
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(calls);

  document.querySelectorAll<HTMLButtonElement>('.event-preview')[1].click();
  await tick();
  expect(document.querySelector('video')?.getAttribute('src')).toBe('/clips/second.mp4');
  expect(document.querySelectorAll('video')).toHaveLength(1);
  expect(document.querySelector('video')).not.toBe(video);

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  expect(document.querySelector('.clip-preview')).not.toBeNull();
  expect(document.querySelector('.preview-unavailable')?.textContent).toBe('No clip selected.');
  expect(document.querySelector('video')).toBeNull();
  expect(document.activeElement).toBe(document.querySelectorAll('.event-preview')[1]);
});

it('shows lazy thumbnails before opening a video and keeps missing-image rows usable', async () => {
  api.fetchPlayoutPage.mockResolvedValue({
    items: [event, { ...event, id: 9, path: 'moved/first.mp4', previewUrl: null }],
  });
  await renderLog();
  const images = [...document.querySelectorAll<HTMLImageElement>('.event-thumbnail img')];
  expect(images).toHaveLength(2);
  expect(images.map((image) => image.getAttribute('src'))).toEqual([
    '/api/tags/thumbnails/clip-1.jpg',
    '/api/tags/thumbnails/clip-1.jpg',
  ]);
  expect(images.every((image) => image.getAttribute('loading') === 'lazy')).toBe(true);
  expect(document.querySelector('video')).toBeNull();

  images[0].dispatchEvent(new Event('error'));
  expect(images[0].hidden).toBe(true);
  expect(titles()).toEqual(['First clip', 'First clip']);

  images[1].click();
  await tick();
  expect(document.querySelector('.clip-preview h3')?.textContent).toBe('First clip');
  expect(document.querySelector('.preview-unavailable')).not.toBeNull();
});

it('marks all loaded appearances inactive and lets the operator reverse it', async () => {
  const other = { ...event, id: 9, channelId: '360', outputId: '360-server' };
  api.fetchPlayoutChannels.mockResolvedValue([
    { id: 'indie', name: 'WBRU Indie', accent: '#49d6a2' },
    { id: '360', name: 'WBRU 360', accent: '#f1b85b' },
  ]);
  api.fetchPlayoutPage.mockImplementation(({ channelId }) =>
    Promise.resolve({ items: [channelId === '360' ? other : event] }),
  );
  api.setClipInactive.mockImplementation((_clipId, inactive) => Promise.resolve(inactive));
  await renderLog();
  document.querySelector<HTMLButtonElement>('.event-preview')!.click();
  await tick();
  const checkbox = document.querySelector<HTMLInputElement>('.inactive-control input')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(api.setClipInactive).toHaveBeenCalledWith(event.clipId, true));
  await vi.waitFor(() => expect(document.querySelectorAll('.inactive-badge')).toHaveLength(2));
  expect(document.querySelectorAll('.event-preview')).toHaveLength(2);

  document.querySelectorAll<HTMLButtonElement>('.event-preview')[1].click();
  await tick();
  expect(checkbox.checked).toBe(true);
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(api.setClipInactive).toHaveBeenLastCalledWith(event.clipId, false));
  await vi.waitFor(() => expect(document.querySelectorAll('.inactive-badge')).toHaveLength(0));
});

it('restores the inactive checkbox after a failed update and allows retrying', async () => {
  api.fetchPlayoutPage.mockResolvedValue({ items: [event] });
  api.setClipInactive.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(true);
  await renderLog();
  document.querySelector<HTMLButtonElement>('.event-preview')!.click();
  await tick();
  const checkbox = document.querySelector<HTMLInputElement>('.inactive-control input')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('503'),
  );
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(false);
  expect(document.querySelector('.inactive-badge')).toBeNull();

  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('.inactive-badge')).not.toBeNull());
  expect(checkbox.checked).toBe(true);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('finishes an inactive update for the original clip after preview navigation', async () => {
  const pending = deferred<boolean>();
  api.fetchPlayoutPage.mockResolvedValue({
    items: [event, { ...event, id: 9, clipId: 'clip-2', title: 'Second clip' }],
  });
  api.setClipInactive.mockReturnValue(pending.promise);
  await renderLog();
  const rows = document.querySelectorAll<HTMLButtonElement>('.event-preview');
  rows[0].click();
  await tick();
  const checkbox = document.querySelector<HTMLInputElement>('.inactive-control input')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
  expect(checkbox.disabled).toBe(true);
  rows[1].click();
  await tick();
  expect(checkbox.checked).toBe(false);

  pending.resolve(true);
  await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
  expect(checkbox.checked).toBe(false);
  expect(rows[0].querySelector('.inactive-badge')).not.toBeNull();
  expect(rows[1].querySelector('.inactive-badge')).toBeNull();
  rows[0].click();
  await tick();
  expect(checkbox.checked).toBe(true);
});

it('steps through earlier and later plays, loading an older page when needed', async () => {
  const middle = { ...event, id: 9, title: 'Middle clip' };
  const oldest = { ...event, id: 8, title: 'Oldest clip' };
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({ items: [event, middle], nextBeforeId: middle.id })
    .mockResolvedValueOnce({ items: [oldest] });
  await renderLog();
  document.querySelector<HTMLButtonElement>('.event-preview')!.click();
  await tick();
  const previous = document.querySelector<HTMLButtonElement>('[aria-label="Previous clip"]')!;
  const next = document.querySelector<HTMLButtonElement>('[aria-label="Next clip"]')!;
  const firstVideo = document.querySelector('video');
  expect(next.disabled).toBe(true);

  previous.click();
  await tick();
  expect(document.querySelector('.clip-preview h3')?.textContent).toBe('Middle clip');
  // Repeated plays of the same media still start a fresh preview.
  expect(document.querySelector('video')).not.toBe(firstVideo);
  expect(next.disabled).toBe(false);
  previous.click();
  await vi.waitFor(() =>
    expect(document.querySelector('.clip-preview h3')?.textContent).toBe('Oldest clip'),
  );
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ channelId: 'indie', beforeId: middle.id }),
  );
  expect(previous.disabled).toBe(true);
  next.click();
  await tick();
  expect(document.querySelector('.clip-preview h3')?.textContent).toBe('Middle clip');
});

it('switches channels by clicking a row and keeps navigation inside that channel', async () => {
  const tv = { ...event, id: 12, channelId: 'wbru-tv', title: 'TV clip' };
  api.fetchPlayoutChannels.mockResolvedValue([
    { id: 'indie', name: 'Indie', accent: '#49d6a2' },
    { id: 'wbru-tv', name: 'WBRU TV', accent: '#f1b85b' },
  ]);
  api.fetchPlayoutPage.mockImplementation(async ({ channelId }) => ({
    items: channelId === 'wbru-tv' ? [tv] : [event, { ...event, id: 9 }],
  }));
  await renderLog();
  document.querySelector<HTMLButtonElement>('.event-preview')!.click();
  await tick();
  document.querySelector<HTMLButtonElement>('[data-event-id="12"]')!.click();
  await tick();
  expect(document.querySelector('.clip-preview h3')?.textContent).toBe('TV clip');
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Previous clip"]')!.disabled).toBe(
    true,
  );
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Next clip"]')!.disabled).toBe(
    true,
  );
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  expect(document.querySelector('.clip-preview')).not.toBeNull();
  expect(document.querySelector('video')).toBeNull();
});

it('keeps a clicked selection when an older page finishes loading', async () => {
  const older = deferred<{ items: RecentPlayout[] }>();
  api.fetchPlayoutPage
    .mockResolvedValueOnce({ items: [event] })
    .mockResolvedValueOnce({
      items: [event, { ...event, id: 9, title: 'Middle clip' }],
      nextBeforeId: 9,
    })
    .mockReturnValueOnce(older.promise);
  await renderLog();
  document.querySelector<HTMLButtonElement>('[data-event-id="9"]')!.click();
  await tick();
  document.querySelector<HTMLButtonElement>('[aria-label="Previous clip"]')!.click();
  await tick();
  document.querySelector<HTMLButtonElement>('[data-event-id="10"]')!.click();
  older.resolve({ items: [{ ...event, id: 8, title: 'Oldest clip' }] });
  await vi.waitFor(() => expect(titles()).toHaveLength(3));
  expect(document.querySelector('.clip-preview h3')?.textContent).toBe('First clip');
});

it('clears preview navigation when a new search replaces the log', async () => {
  api.fetchPlayoutPage.mockResolvedValue({ items: [event] });
  await renderLog();
  document.querySelector<HTMLButtonElement>('.event-preview')!.click();
  await tick();
  const search = document.querySelector<HTMLInputElement>('.search')!;
  search.value = 'different';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
  await tick();
  expect(document.querySelector('.clip-preview')).not.toBeNull();
  expect(document.querySelector('.preview-unavailable')?.textContent).toBe('No clip selected.');
  expect(document.querySelector('video')).toBeNull();
  expect(document.querySelector('.event-preview.selected')).toBeNull();
});

it.each([null, '/clips/missing.mp4'])(
  'keeps the log entry readable when preview media is unavailable (%s)',
  async (previewUrl) => {
    api.fetchPlayoutPage.mockResolvedValue({ items: [{ ...event, previewUrl }] });
    await renderLog();
    document.querySelector<HTMLButtonElement>('.event-preview')!.click();
    await tick();
    if (previewUrl) {
      document.querySelector('video')!.dispatchEvent(new Event('error'));
      await tick();
    }
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('.preview-unavailable')).not.toBeNull();
    expect(document.querySelector('.clip-preview h3')?.textContent).toBe(event.title);
    expect(titles()).toEqual([event.title]);
  },
);

// Native date/time inputs hold local wall-clock values, without a UTC suffix.
function enterTime(date: string, time = ''): void {
  for (const [type, value] of [
    ['date', date],
    ['time', time],
  ]) {
    const input = document.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document
    .querySelector('.time-navigation')!
    .dispatchEvent(new Event('submit', { cancelable: true }));
}

it('uses the chosen local time for every channel, older pages, and searches until returning to Live', async () => {
  api.fetchPlayoutChannels.mockResolvedValue([
    { id: 'indie', name: 'WBRU Indie', accent: '#49d6a2' },
    { id: 'wbru-tv', name: 'WBRU TV', accent: '#f1b85b' },
  ]);
  api.fetchPlayoutPage.mockResolvedValue({ items: [event], nextBeforeId: event.id });
  await renderLog();
  api.fetchPlayoutPage.mockClear();
  enterTime('2026-08-25', '14:30');
  const until = new Date('2026-08-25T14:30').toISOString();
  await vi.waitFor(() => expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(2));
  await tick();
  for (const channelId of ['indie', 'wbru-tv']) {
    expect(api.fetchPlayoutPage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId, until }),
    );
  }
  await poll();
  expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(2);

  scrollList(900);
  await vi.waitFor(() => expect(api.fetchPlayoutPage).toHaveBeenCalledTimes(3));
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ beforeId: event.id, until }),
  );

  const search = document.querySelector<HTMLInputElement>('.search')!;
  search.value = 'first';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
  await tick();
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ search: 'first', until }),
  );

  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('.time-navigation button[aria-pressed]')!.click();
  await vi.waitFor(() =>
    expect(
      document.querySelector('.time-navigation button[aria-pressed]')?.getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  await poll();
  expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ afterId: event.id }),
  );
  expect(api.fetchPlayoutPage.mock.lastCall![0].until).toBeUndefined();
});

it('jumps to the end of a date and moves by local calendar day', async () => {
  await renderLog();
  enterTime('2026-08-25');
  await vi.waitFor(() =>
    expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ until: new Date('2026-08-25T23:59:59').toISOString() }),
    ),
  );
  await tick();
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Previous day"]')!.disabled).toBe(
      false,
    ),
  );
  document.querySelector<HTMLButtonElement>('[aria-label="Previous day"]')!.click();
  await vi.waitFor(() =>
    expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ until: new Date('2026-08-24T23:59:59').toISOString() }),
    ),
  );
  await tick();
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Next day"]')!.disabled).toBe(
      false,
    ),
  );
  document.querySelector<HTMLButtonElement>('[aria-label="Next day"]')!.click();
  await vi.waitFor(() =>
    expect(api.fetchPlayoutPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ until: new Date('2026-08-25T23:59:59').toISOString() }),
    ),
  );
});
