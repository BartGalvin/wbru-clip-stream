import { VISUALIZER_LIBRARY } from '../../../shared/libraries';

export const UNKNOWN_CLIP_DURATION_SEC = 10;
const SHORT_CLIP_MAX_SEC = 45;
const LONG_CLIP_MIN_SEC = 20 * 60;
const CLIP_SPACING_SHORT = 2;
const CLIP_SPACING_LONG = 1;

// Give clips without measured durations a finite slot on the shared timeline.
export function effectivePlayoutDurationSec(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return UNKNOWN_CLIP_DURATION_SEC;
  return Math.max(1, durationSec);
}

// Station policy for spacing short, long, and black-and-white clips.
export interface PlayoutPolicy {
  readonly duration: {
    readonly short: {
      readonly maxExclusiveSec: number;
      readonly clipsBetween: number;
    };
    readonly long: {
      readonly minExclusiveSec: number;
      readonly clipsBetween: number;
    };
  };
  readonly blackAndWhite?: {
    readonly tags: readonly string[];
  };
}

export const DEFAULT_PLAYOUT_POLICY: PlayoutPolicy = {
  duration: {
    short: {
      maxExclusiveSec: SHORT_CLIP_MAX_SEC,
      clipsBetween: CLIP_SPACING_SHORT,
    },
    long: {
      minExclusiveSec: LONG_CLIP_MIN_SEC,
      clipsBetween: CLIP_SPACING_LONG,
    },
  },
};

export const VISUALIZER_PLAYOUT_POLICY: PlayoutPolicy = {
  ...DEFAULT_PLAYOUT_POLICY,
  blackAndWhite: {
    tags: ['black and white', 'blackwhite'],
  },
};

export function playoutPolicyForLibrary(library: string): PlayoutPolicy {
  return library === VISUALIZER_LIBRARY.id ? VISUALIZER_PLAYOUT_POLICY : DEFAULT_PLAYOUT_POLICY;
}
