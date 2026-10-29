import { playWithAudioFallback, type MediaHandle } from '../media/playback';
import { createClipQueue } from '../content/clipQueue';
import { createHttpContentClient } from '../content/httpContentClient';
import { createClipLoader } from './clipLoader';
import type { ClipVideoProgramContext, VideoProgram, VideoProgramOptions } from './types';

const LOOKAHEAD = 8;
const SKIP_LIMIT = 10;
const LOAD_TIMEOUT_MS = 15_000;
const START_RETRY_MS = 3_000;
const END_MARGIN_SEC = 1;

function makeVideo(options: VideoProgramOptions): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = options.muted;
  video.playsInline = true;
  video.preload = 'auto';
  options.stage.appendChild(video);
  return video;
}

// Alternate between two video elements so the next catalog clip can preload off-air.
export function createClipVideoProgram(
  options: VideoProgramOptions,
  context: ClipVideoProgramContext,
): VideoProgram {
  const client = createHttpContentClient({
    channel: context.channelId,
    filter: context.filter,
  });
  const queue = createClipQueue(client, {
    queueAhead: LOOKAHEAD,
    initialCursor: context.resumeFrom?.clip.cursor,
  });
  const videos: [HTMLVideoElement, HTMLVideoElement] = [makeVideo(options), makeVideo(options)];
  let active = 0;
  let advancing = false;
  let destroyed = false;
  const lifecycleController = new AbortController();
  // Each buffer skips broken catalog entries within a bounded attempt count.
  const loaders = [
    createClipLoader(videos[0], queue, lifecycleController.signal, {
      loadTimeoutMs: LOAD_TIMEOUT_MS,
      maxLoadAttempts: SKIP_LIMIT,
      endMarginSec: END_MARGIN_SEC,
    }),
    createClipLoader(videos[1], queue, lifecycleController.signal, {
      loadTimeoutMs: LOAD_TIMEOUT_MS,
      maxLoadAttempts: SKIP_LIMIT,
      endMarginSec: END_MARGIN_SEC,
    }),
  ] as const;
  let playback: MediaHandle | null = null;
  let startedClipId: string | null = null;
  let nextReady: Promise<boolean> = Promise.resolve(false);
  let isPreloadingNext = false;

  // Save progress only for the buffer that is currently on-air.
  const saveProgress = (index: number): void => {
    const clip = loaders[index].clip;
    if (!clip || index !== active) return;
    context.onPlaybackUpdate?.({ clip, timeSec: videos[index].currentTime });
  };

  // Replace the active browser play attempt and surface terminal media errors.
  const play = (index: number): void => {
    saveProgress(index);
    playback?.destroy();
    playback = playWithAudioFallback(videos[index], {
      ...options.playHooks,
      onError: (error) => {
        options.playHooks?.onError?.(error);
        const detail = error instanceof Error ? error.message : String(error);
        options.onStatus(`Playback failed: ${detail}`);
        if (index === active && loaders[index].clip) void advance('error');
      },
    });
  };

  const showActive = (): void => {
    videos.forEach((video, index) => video.classList.toggle('on', index === active));
  };

  // Track off-air loading so finished clips can replay without waiting for it.
  const preloadNext = (): Promise<boolean> => {
    isPreloadingNext = true;
    return loaders[1 - active]
      .loadNext()
      .catch(() => false)
      .finally(() => {
        isPreloadingNext = false;
      });
  };

  // Switch to the next buffer, or replay a finished clip while its preload continues.
  const advance = async (reason: 'ended' | 'error'): Promise<void> => {
    if (advancing || destroyed) return;
    advancing = true;
    const idle = 1 - active;
    try {
      if (reason === 'ended' && isPreloadingNext) {
        videos[active].currentTime = 0;
        play(active);
        return;
      }
      const ready = await nextReady;
      if (destroyed) return;
      if (ready) {
        active = idle;
        showActive();
        play(active);
        nextReady = preloadNext();
      } else {
        videos[active].currentTime = 0;
        play(active);
        nextReady = preloadNext();
      }
    } finally {
      advancing = false;
    }
  };

  // Announce actual playback, advance on completion, and save active-buffer progress.
  videos.forEach((video, index) => {
    video.addEventListener('playing', () => {
      if (destroyed || index !== active) return;
      options.onStatus(null);
      const clip = loaders[index].clip;
      // Buffering and replays can emit playing again without changing the clip.
      if (clip && clip.clipId !== startedClipId) {
        startedClipId = clip.clipId;
        context.onClipStart?.(clip);
      }
    });
    video.addEventListener('ended', () => {
      if (videos[active] === video) void advance('ended');
    });
    video.addEventListener('error', () => {
      if (videos[active] === video && loaders[index].clip) void advance('error');
    });
    video.addEventListener('timeupdate', () => saveProgress(index));
  });

  // Restore a viable checkpoint first, otherwise retry until an initial clip loads.
  const start = async (): Promise<void> => {
    const restored = context.resumeFrom ? await loaders[active].restore(context.resumeFrom) : false;
    while (!restored && !destroyed) {
      try {
        if (await loaders[active].loadNext()) break;
        if (destroyed) return;
        options.onStatus('No clips available. Retrying...');
      } catch {
        if (destroyed) return;
        options.onStatus('Program server unavailable. Retrying...');
      }
      // Let teardown interrupt the retry delay instead of waiting for its timer.
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          lifecycleController.signal.removeEventListener('abort', onAbort);
          resolve();
        }, START_RETRY_MS);
        lifecycleController.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (destroyed) return;
    options.onStatus(null);
    showActive();
    play(active);
    nextReady = preloadNext();
  };

  return {
    start,
    destroy() {
      // Capture final progress before aborting requests and removing both buffers.
      if (destroyed) return;
      saveProgress(active);
      destroyed = true;
      lifecycleController.abort();
      playback?.destroy();
      playback = null;
      queue.destroy();
      for (const video of videos) {
        video.pause();
        video.remove();
      }
    },
  };
}
