import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClipRef } from '../../shared/contract';
import type { ClipQueue } from '../content/clipQueue';
import { createClipLoader } from './clipLoader';

// Minimal video element that can load, fail, or remain pending.
class FakeVideo extends EventTarget {
  src = '';
  currentTime = 0;
  duration = 60;

  constructor(private readonly loadEvents: Array<'canplay' | 'error' | 'pending'> = []) {
    super();
  }

  load(): void {
    const event = this.loadEvents.shift() ?? 'canplay';
    if (event !== 'pending') queueMicrotask(() => this.dispatchEvent(new Event(event)));
  }
}

function clip(position: number, durationSec = 0): ClipRef {
  return {
    clipId: `clip-${position}`,
    title: `Clip ${position}`,
    url: `/clips/${position}.mp4`,
    durationSec,
    cursor: String(position),
    tags: [],
  };
}

function createQueue(
  ...clips: Array<ClipRef | null>
): ClipQueue & { next: ReturnType<typeof vi.fn> } {
  return {
    next: vi.fn(async () => clips.shift() ?? null),
    destroy: vi.fn(),
  };
}

function createLoader(
  video: FakeVideo,
  queue: ClipQueue,
  controller = new AbortController(),
  options: Partial<{
    loadTimeoutMs: number;
    maxLoadAttempts: number;
    endMarginSec: number;
  }> = {},
) {
  return {
    controller,
    loader: createClipLoader(video as unknown as HTMLVideoElement, queue, controller.signal, {
      loadTimeoutMs: 100,
      maxLoadAttempts: 3,
      endMarginSec: 1,
      ...options,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createClipLoader', () => {
  it('skips an unloadable catalog entry and prepares the next clip', async () => {
    const video = new FakeVideo(['error', 'canplay']);
    const queue = createQueue(clip(1), clip(2));
    const { loader } = createLoader(video, queue);

    await expect(loader.loadNext()).resolves.toBe(true);

    expect(queue.next).toHaveBeenCalledTimes(2);
    expect(video.src).toBe('/clips/2.mp4');
    expect(loader.clip).toEqual(clip(2));
  });

  it('stops after the configured number of failed loads', async () => {
    const video = new FakeVideo(['error', 'error', 'canplay']);
    const queue = createQueue(clip(1), clip(2), clip(3));
    const { loader } = createLoader(video, queue, undefined, { maxLoadAttempts: 2 });

    await expect(loader.loadNext()).resolves.toBe(false);

    expect(queue.next).toHaveBeenCalledTimes(2);
    expect(loader.clip).toBeNull();
  });

  it('restores a prepared clip at its checkpoint', async () => {
    const video = new FakeVideo();
    const { loader } = createLoader(video, createQueue());

    await expect(loader.restore({ clip: clip(7), timeSec: 23 })).resolves.toBe(true);

    expect(video.src).toBe('/clips/7.mp4');
    expect(video.currentTime).toBe(23);
    expect(loader.clip).toEqual(clip(7));
  });

  it('rejects a checkpoint inside the end margin', async () => {
    const video = new FakeVideo();
    const { loader } = createLoader(video, createQueue());

    await expect(loader.restore({ clip: clip(7), timeSec: 59.5 })).resolves.toBe(false);

    expect(loader.clip).toBeNull();
    expect(video.currentTime).toBe(0);
  });

  it('uses catalog duration when media duration is unavailable', async () => {
    const video = new FakeVideo();
    video.duration = Number.NaN;
    const { loader } = createLoader(video, createQueue());

    await expect(loader.restore({ clip: clip(7, 30), timeSec: 29.5 })).resolves.toBe(false);

    expect(loader.clip).toBeNull();
  });

  it('abandons a pending load when its lifecycle is aborted', async () => {
    const video = new FakeVideo(['pending']);
    const { loader, controller } = createLoader(video, createQueue(clip(1), null));
    const loading = loader.loadNext();
    await vi.waitFor(() => expect(video.src).toBe('/clips/1.mp4'));

    controller.abort();

    await expect(loading).resolves.toBe(false);
    expect(loader.clip).toBeNull();
  });

  it('abandons a load after its timeout', async () => {
    vi.useFakeTimers();
    const video = new FakeVideo(['pending']);
    const { loader } = createLoader(video, createQueue(clip(1), null), undefined, {
      loadTimeoutMs: 50,
    });
    const loading = loader.loadNext();

    await vi.advanceTimersByTimeAsync(50);

    await expect(loading).resolves.toBe(false);
    expect(loader.clip).toBeNull();
  });
});
