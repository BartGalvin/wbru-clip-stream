// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const tagger = vi.hoisted(() => ({
  mount: vi.fn(),
  unmount: vi.fn(),
  loadTaggerData: vi.fn(),
  synchronizeCatalog: vi.fn(),
}));

vi.mock('svelte', () => ({ mount: tagger.mount, unmount: tagger.unmount }));
vi.mock('./Tagger.svelte', () => ({ default: {} }));
vi.mock('./taggerActions', () => ({
  loadTaggerData: tagger.loadTaggerData,
  synchronizeCatalog: tagger.synchronizeCatalog,
}));

function navigate(type: 'pagehide' | 'pageshow', persisted: boolean): void {
  // Happy DOM aliases PageTransitionEvent to Event without its persisted property.
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="tagger"></div>';
  tagger.mount.mockImplementation((_component: unknown, { target }: { target: HTMLElement }) => {
    const input = document.createElement('input');
    input.value = 'Unsaved edit';
    target.appendChild(input);
    return { target };
  });
  tagger.unmount.mockImplementation(async ({ target }: { target: HTMLElement }) => {
    target.replaceChildren();
  });
  tagger.loadTaggerData.mockResolvedValue(undefined);
  tagger.synchronizeCatalog.mockResolvedValue(undefined);
});

afterEach(() => {
  navigate('pagehide', false);
  vi.useRealTimers();
});

it('preserves the mounted tagger and one catalog poller across cached navigations', async () => {
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
  const input = document.querySelector('input');
  for (let navigation = 0; navigation < 2; navigation += 1) {
    navigate('pagehide', true);
    expect(tagger.unmount).not.toHaveBeenCalled();
    navigate('pageshow', true);
    expect(document.querySelector('input')).toBe(input);
    expect(input?.value).toBe('Unsaved edit');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(tagger.synchronizeCatalog).toHaveBeenCalledTimes(navigation + 1);
  }
  expect(tagger.mount).toHaveBeenCalledOnce();
  expect(tagger.loadTaggerData).toHaveBeenCalledOnce();

  navigate('pagehide', false);
  expect(tagger.unmount).toHaveBeenCalledOnce();
  expect(document.getElementById('tagger')?.childElementCount).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])(
  'starts polling after initial loading settles across navigation (cached: %s)',
  async (cached) => {
    let finishLoading!: () => void;
    tagger.loadTaggerData.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishLoading = resolve;
      }),
    );
    await import('./main');
    navigate('pagehide', cached);
    navigate('pageshow', cached);
    finishLoading();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(cached ? 1 : 0);
    expect(tagger.unmount).toHaveBeenCalledTimes(cached ? 0 : 1);
    expect(tagger.mount).toHaveBeenCalledOnce();
  },
);
