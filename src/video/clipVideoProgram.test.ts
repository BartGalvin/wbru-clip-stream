import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClipRef } from '../../shared/contract';
import type { ContentClient } from '../content/contentClient';
import type { ClipVideoProgramContext, VideoProgramOptions } from './types';

const dependencies = vi.hoisted(() => ({
  createHttpContentClient: vi.fn(),
  playWithAudioFallback: vi.fn(),
}));

vi.mock('../content/httpContentClient', () => ({
  createHttpContentClient: dependencies.createHttpContentClient,
}));
vi.mock('../media/playback', () => ({
  playWithAudioFallback: dependencies.playWithAudioFallback,
}));

import { createClipVideoProgram } from './clipVideoProgram';

// A null load event keeps the video pending until the test supplies an event.
class FakeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  preload = '';
  src = '';
  currentTime = 0;
  duration = 60;
  classList = { toggle: vi.fn() };
  pause = vi.fn();
  remove = vi.fn();

  constructor(private readonly loadEvents: (string | null)[] = []) {
    super();
  }

  load(): void {
    const event = this.loadEvents.length ? this.loadEvents.shift() : 'canplay';
    if (event) queueMicrotask(() => this.dispatchEvent(new Event(event)));
  }
}

function clip(position: number): ClipRef {
  return {
    clipId: `clip-${position}`,
    title: `Clip ${position}`,
    url: `/clips/${position}.mp4`,
    durationSec: 0,
    cursor: String(position),
    tags: [],
  };
}

// Optional dependencies and state exposed by the clip-program test harness.
interface HarnessOptions {
  clips?: ClipRef[];
  upcoming?: ContentClient['upcoming'];
  clientDestroy?: ContentClient['destroy'];
  videos?: [FakeVideo, FakeVideo];
  videoOptions?: Partial<Omit<VideoProgramOptions, 'stage'>>;
  clipContext?: Partial<ClipVideoProgramContext>;
}

function createProgramHarness(options: HarnessOptions = {}) {
  const clips = options.clips ?? [clip(1), clip(2), clip(3)];
  const upcoming = options.upcoming ?? vi.fn(async () => clips);
  const clientDestroy = options.clientDestroy ?? vi.fn();
  const client: ContentClient = { upcoming, destroy: clientDestroy };
  dependencies.createHttpContentClient.mockReturnValue(client);

  const videos = options.videos ?? [new FakeVideo(), new FakeVideo()];
  const videosToCreate = [...videos];
  vi.stubGlobal('document', {
    createElement: vi.fn(() => videosToCreate.shift()),
  });

  const stage = { appendChild: vi.fn() };
  const onStatus = vi.fn();
  const program = createClipVideoProgram(
    {
      muted: true,
      onStatus,
      ...options.videoOptions,
      stage: stage as unknown as HTMLElement,
    },
    {
      channelId: 'indie',
      filter: { includeTags: new Set(), excludeTags: new Set(), matchAll: false },
      ...options.clipContext,
    },
  );

  return { clientDestroy, onStatus, program, stage, upcoming, videos };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('createClipVideoProgram', () => {
  it('announces active playback once per clip and clears status', async () => {
    const onClipStart = vi.fn();
    const harness = createProgramHarness({ clipContext: { onClipStart } });
    await harness.program.start();
    harness.onStatus.mockClear();
    expect(onClipStart).not.toHaveBeenCalled();

    harness.videos[1].dispatchEvent(new Event('playing'));
    expect(harness.onStatus).not.toHaveBeenCalled();
    expect(onClipStart).not.toHaveBeenCalled();
    harness.videos[0].dispatchEvent(new Event('playing'));
    expect(harness.onStatus).toHaveBeenCalledWith(null);
    expect(onClipStart).toHaveBeenCalledWith(clip(1));
    harness.videos[0].dispatchEvent(new Event('waiting'));
    harness.videos[0].dispatchEvent(new Event('playing'));
    expect(onClipStart).toHaveBeenCalledOnce();
    harness.program.destroy();
    harness.videos[0].dispatchEvent(new Event('playing'));
    expect(onClipStart).toHaveBeenCalledOnce();
  });

  it('restores the saved clip and time, then queues the clip after it', async () => {
    const upcoming = vi.fn(async () => [clip(8), clip(9)]);
    const onPlaybackUpdate = vi.fn();
    const harness = createProgramHarness({
      upcoming,
      clipContext: {
        resumeFrom: { clip: clip(7), timeSec: 23 },
        onPlaybackUpdate,
      },
    });

    await harness.program.start();

    expect(harness.videos[0].src).toBe('/clips/7.mp4');
    expect(harness.videos[0].currentTime).toBe(23);
    expect(onPlaybackUpdate).toHaveBeenCalledWith({
      clip: expect.objectContaining({ cursor: '7' }),
      timeSec: 23,
    });
    await vi.waitFor(() => expect(upcoming).toHaveBeenCalledWith('7', 8));
    harness.program.destroy();
  });

  it('moves on when the saved clip is already at its end', async () => {
    const harness = createProgramHarness({
      clips: [clip(8), clip(9)],
      clipContext: {
        resumeFrom: { clip: clip(7), timeSec: 59.5 },
      },
    });

    await harness.program.start();

    expect(harness.videos[0].src).toBe('/clips/8.mp4');
    expect(harness.videos[0].currentTime).toBe(0);
    harness.program.destroy();
  });

  it('double-buffers the next clip and refills the idle video after advancing', async () => {
    vi.useFakeTimers();
    const playbackDestroys = [vi.fn(), vi.fn()];
    dependencies.playWithAudioFallback.mockImplementation(() => ({
      destroy: playbackDestroys[dependencies.playWithAudioFallback.mock.calls.length - 1],
    }));
    const harness = createProgramHarness();

    await harness.program.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.videos[1].src).toBe('/clips/2.mp4');

    harness.videos[0].dispatchEvent(new Event('ended'));

    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(2);
    expect(harness.videos[1].classList.toggle).toHaveBeenLastCalledWith('on', true);
    expect(playbackDestroys[0]).toHaveBeenCalledOnce();
    expect(harness.videos[0].src).toBe('/clips/3.mp4');

    harness.program.destroy();
    expect(playbackDestroys[1]).toHaveBeenCalledOnce();
  });

  it('keeps clip load failures inside preparation', async () => {
    const videos: [FakeVideo, FakeVideo] = [new FakeVideo(['error', 'canplay']), new FakeVideo()];
    const onClipStart = vi.fn();
    const harness = createProgramHarness({ videos, clipContext: { onClipStart } });

    await harness.program.start();

    expect(harness.videos[0].src).toBe('/clips/2.mp4');
    expect(dependencies.playWithAudioFallback).toHaveBeenCalledOnce();
    expect(onClipStart).not.toHaveBeenCalled();
    videos[0].dispatchEvent(new Event('playing'));
    expect(onClipStart).toHaveBeenCalledExactlyOnceWith(clip(2));
    harness.program.destroy();
  });

  it('replays finished clips without interrupting the pending preload', async () => {
    vi.useFakeTimers();
    const videos: [FakeVideo, FakeVideo] = [new FakeVideo(), new FakeVideo([null])];
    videos[0].duration = 5;
    const preload = vi.spyOn(videos[1], 'load');
    const onClipStart = vi.fn();
    const nextClip = { ...clip(2), publishedYear: 2014 };
    const harness = createProgramHarness({
      videos,
      clips: [clip(1), nextClip, clip(3)],
      clipContext: { onClipStart },
    });

    try {
      await harness.program.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(videos[1].src).toBe('/clips/2.mp4');
      expect(onClipStart).not.toHaveBeenCalled();
      videos[0].dispatchEvent(new Event('playing'));
      expect(onClipStart).toHaveBeenCalledExactlyOnceWith(clip(1));

      // Two completed plays must leave the same off-air load running.
      for (const playCount of [2, 3]) {
        await vi.advanceTimersByTimeAsync(5000);
        videos[0].currentTime = 5;
        videos[0].dispatchEvent(new Event('ended'));

        expect(videos[0].currentTime).toBe(0);
        expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(playCount);
        expect(dependencies.playWithAudioFallback).toHaveBeenLastCalledWith(
          videos[0],
          expect.any(Object),
        );
        expect(preload).toHaveBeenCalledOnce();
        videos[0].dispatchEvent(new Event('playing'));
        expect(onClipStart).toHaveBeenCalledOnce();
      }

      videos[1].dispatchEvent(new Event('canplay'));
      await vi.advanceTimersByTimeAsync(0);
      expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(3);

      videos[0].dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(0);
      expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(4);
      expect(videos[1].classList.toggle).toHaveBeenLastCalledWith('on', true);
      expect(videos[0].src).toBe('/clips/3.mp4');
      expect(onClipStart).toHaveBeenCalledOnce();
      videos[1].dispatchEvent(new Event('playing'));
      expect(onClipStart).toHaveBeenCalledTimes(2);
      expect(onClipStart).toHaveBeenLastCalledWith(nextClip);
      videos[0].dispatchEvent(new Event('playing'));
      expect(onClipStart).toHaveBeenCalledTimes(2);
    } finally {
      harness.program.destroy();
    }
  });

  it('retries preparation after its loading attempts are exhausted', async () => {
    vi.useFakeTimers();
    const videos: [FakeVideo, FakeVideo] = [new FakeVideo(), new FakeVideo(Array(10).fill(null))];
    const preload = vi.spyOn(videos[1], 'load');
    const upcoming = vi.fn(async (cursor: string | null, count: number) =>
      Array.from({ length: count }, (_, index) => clip(Number(cursor ?? 0) + index + 1)),
    );
    const harness = createProgramHarness({ videos, upcoming });

    try {
      await harness.program.start();
      await vi.advanceTimersByTimeAsync(150_000);
      expect(preload).toHaveBeenCalledTimes(10);

      videos[0].dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(0);
      expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(2);
      expect(videos[0].classList.toggle).toHaveBeenLastCalledWith('on', true);
      expect(preload).toHaveBeenCalledTimes(11);
      expect(videos[1].src).toBe('/clips/12.mp4');
    } finally {
      harness.program.destroy();
    }
  });

  it('waits for the pending preload instead of replaying an errored clip', async () => {
    vi.useFakeTimers();
    const videos: [FakeVideo, FakeVideo] = [new FakeVideo(), new FakeVideo([null])];
    const harness = createProgramHarness({ videos });

    try {
      await harness.program.start();
      await vi.advanceTimersByTimeAsync(0);
      videos[0].dispatchEvent(new Event('error'));
      await vi.advanceTimersByTimeAsync(0);
      expect(dependencies.playWithAudioFallback).toHaveBeenCalledOnce();

      videos[1].dispatchEvent(new Event('canplay'));
      await vi.advanceTimersByTimeAsync(0);
      expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(2);
      expect(videos[1].classList.toggle).toHaveBeenLastCalledWith('on', true);
    } finally {
      harness.program.destroy();
    }
  });

  it('advances when the on-air element errors at time zero', async () => {
    const harness = createProgramHarness();

    await harness.program.start();
    await vi.waitFor(() => expect(harness.videos[1].src).toBe('/clips/2.mp4'));
    expect(harness.videos[0].currentTime).toBe(0);

    harness.videos[0].dispatchEvent(new Event('error'));

    await vi.waitFor(() => expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(2));
    expect(harness.videos[1].classList.toggle).toHaveBeenLastCalledWith('on', true);
    harness.program.destroy();
  });

  it('reports and advances after a play-promise error', async () => {
    const callerOnError = vi.fn();
    const harness = createProgramHarness({
      videoOptions: { muted: false, playHooks: { onError: callerOnError } },
    });

    await harness.program.start();
    await vi.waitFor(() => expect(harness.videos[1].src).toBe('/clips/2.mp4'));
    const hooks = dependencies.playWithAudioFallback.mock.calls[0][1] as {
      onError?: (error: unknown) => void;
    };
    const error = new DOMException('media unavailable', 'NotSupportedError');

    hooks.onError?.(error);

    expect(callerOnError).toHaveBeenCalledWith(error);
    expect(harness.onStatus).toHaveBeenCalledWith('Playback failed: media unavailable');
    await vi.waitFor(() => expect(dependencies.playWithAudioFallback).toHaveBeenCalledTimes(2));
    expect(harness.videos[1].classList.toggle).toHaveBeenLastCalledWith('on', true);
    harness.program.destroy();
  });

  it('cancels an outstanding content request and destroys once', async () => {
    let rejectRequest!: (reason?: unknown) => void;
    const clientDestroy = vi.fn(() => rejectRequest(new DOMException('aborted', 'AbortError')));
    const upcoming = vi.fn(
      () =>
        new Promise<ClipRef[]>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const harness = createProgramHarness({ clientDestroy, upcoming });
    const starting = harness.program.start();
    await vi.waitFor(() => expect(upcoming).toHaveBeenCalledOnce());

    harness.program.destroy();
    harness.program.destroy();

    await expect(starting).resolves.toBeUndefined();
    expect(clientDestroy).toHaveBeenCalledOnce();
    for (const video of harness.videos) {
      expect(video.remove).toHaveBeenCalledOnce();
    }
  });
});
