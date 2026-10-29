import type { TagFilter } from '../../shared/tagFilter';
import type { PlayHooks } from '../media/playback';
import type { PlaybackCheckpoint } from '../content/playbackCheckpoint';
import type { ClipRef } from '../../shared/contract';

// Common lifecycle exposed by every video source implementation.
export interface VideoProgram {
  start(): Promise<void>;
  destroy(): void;
}

// DOM, audio, and status callbacks shared by all video programs.
export interface VideoProgramOptions {
  stage: HTMLElement;
  muted: boolean;
  playHooks?: PlayHooks;
  onStatus(message: string | null): void;
}

// Catalog-specific context for filtering and playback resumption.
export interface ClipVideoProgramContext {
  channelId: string;
  filter: TagFilter;
  resumeFrom?: PlaybackCheckpoint | null;
  // Called when a different clip starts playing in the active buffer.
  onClipStart?: (clip: ClipRef) => void;
  onPlaybackUpdate?: (checkpoint: PlaybackCheckpoint) => void;
}
