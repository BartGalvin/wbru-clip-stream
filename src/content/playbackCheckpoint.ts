import type { ClipRef } from '../../shared/contract';
import type { TagFilter } from '../../shared/tagFilter';

// Checkpoint storage only needs to read and write strings.
type PlaybackStorage = Pick<Storage, 'getItem' | 'setItem'>;

// Clip and elapsed time needed to resume one catalog program.
export interface PlaybackCheckpoint {
  clip: ClipRef;
  timeSec: number;
}

// Load and save this browser's playback position.
export interface PlaybackCheckpointStore {
  load(): PlaybackCheckpoint | null;
  save(checkpoint: PlaybackCheckpoint): void;
}

// A filter change defines a different program and must not resume the old program's clip.
function storageKey(channelId: string, filter: TagFilter): string {
  const scope = {
    channelId,
    include: [...filter.includeTags].sort(),
    exclude: [...filter.excludeTags].sort(),
    matchAll: filter.matchAll,
  };
  return `wbru:clip-playback:v2:${JSON.stringify(scope)}`;
}

function browserStorage(): PlaybackStorage | null {
  // Storage can be disabled even when the browser exposes localStorage.
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Treat persisted browser data as untrusted before resuming playback.
function parseCheckpoint(value: string | null): PlaybackCheckpoint | null {
  if (!value) return null;
  try {
    const checkpoint = JSON.parse(value) as PlaybackCheckpoint;
    const clip = checkpoint?.clip;
    if (
      !clip ||
      typeof clip.clipId !== 'string' ||
      typeof clip.title !== 'string' ||
      typeof clip.url !== 'string' ||
      typeof clip.durationSec !== 'number' ||
      typeof clip.cursor !== 'string' ||
      !Array.isArray(clip.tags) ||
      !clip.tags.every((tag) => typeof tag === 'string') ||
      !Number.isFinite(checkpoint.timeSec) ||
      checkpoint.timeSec < 0
    ) {
      return null;
    }
    return checkpoint;
  } catch {
    return null;
  }
}

// Save whole-second positions, skipping repeat writes for the same clip and second.
export function createPlaybackCheckpointStore(
  channelId: string,
  filter: TagFilter,
  storage: PlaybackStorage | null = browserStorage(),
): PlaybackCheckpointStore {
  const key = storageKey(channelId, filter);
  let lastSaved = '';
  return {
    load() {
      try {
        return parseCheckpoint(storage?.getItem(key) ?? null);
      } catch {
        return null;
      }
    },
    save(checkpoint) {
      const timeSec = Math.floor(checkpoint.timeSec);
      const signature = `${checkpoint.clip.cursor}:${timeSec}`;
      if (signature === lastSaved) return;
      try {
        storage?.setItem(key, JSON.stringify({ ...checkpoint, timeSec }));
        lastSaved = signature;
      } catch {
        // Playback should continue when storage is unavailable or full.
      }
    },
  };
}
