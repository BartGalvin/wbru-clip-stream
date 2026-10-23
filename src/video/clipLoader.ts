import type { ClipRef } from '../../shared/contract';
import type { ClipQueue } from '../content/clipQueue';
import type { PlaybackCheckpoint } from '../content/playbackCheckpoint';

// State and operations for one reusable off-air video buffer.
export interface ClipLoader {
  readonly clip: ClipRef | null;
  loadNext(): Promise<boolean>;
  restore(checkpoint: PlaybackCheckpoint): Promise<boolean>;
}

// Bounds for loading retries, timeouts, and near-end checkpoint rejection.
interface ClipLoaderOptions {
  loadTimeoutMs: number;
  maxLoadAttempts: number;
  endMarginSec: number;
}

// Resolve only when a video can play, with teardown and timeout sharing the failure path.
function loadVideo(
  video: HTMLVideoElement,
  clip: ClipRef,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (loaded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
      if (loaded) resolve();
      else reject(new Error(`load failed: ${clip.url}`));
    };
    const onReady = (): void => finish(true);
    const onError = (): void => finish(false);
    const onAbort = (): void => finish(false);
    const timer = setTimeout(onAbort, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }
    video.addEventListener('canplay', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.src = clip.url;
    video.load();
  });
}

// Own the catalog clip loaded into one reusable video element.
export function createClipLoader(
  video: HTMLVideoElement,
  queue: ClipQueue,
  signal: AbortSignal,
  options: ClipLoaderOptions,
): ClipLoader {
  let loadedClip: ClipRef | null = null;

  const load = async (clip: ClipRef): Promise<void> => {
    loadedClip = null;
    await loadVideo(video, clip, signal, options.loadTimeoutMs);
  };

  return {
    get clip() {
      return loadedClip;
    },
    async loadNext() {
      // Skip isolated bad files without allowing an unbounded loading loop.
      for (let attempt = 0; attempt < options.maxLoadAttempts; attempt++) {
        const clip = await queue.next();
        if (!clip) return false;
        try {
          await load(clip);
          loadedClip = clip;
          return true;
        } catch {
          // A bad catalog entry must not stop the channel.
        }
      }
      return false;
    },
    // Resume only checkpoints that still leave meaningful playback time.
    async restore(checkpoint) {
      try {
        await load(checkpoint.clip);
        const duration = Number.isFinite(video.duration)
          ? video.duration
          : checkpoint.clip.durationSec;
        if (duration > 0 && checkpoint.timeSec >= duration - options.endMarginSec) return false;
        loadedClip = checkpoint.clip;
        video.currentTime = checkpoint.timeSec;
        return true;
      } catch {
        return false;
      }
    },
  };
}
