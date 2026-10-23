import {
  activeProgram,
  getClipFilter,
  type ClipRef,
  type RecentPlayout,
} from '../../shared/contract';
import { getChannel, listScheduledTargets } from './config/channels';
import { effectivePlayoutDurationSec } from './config/playoutPolicy';
import { getRecentPlayouts, recordPlayout } from './db';
import { getUpcomingProgramClips } from './programCatalog';

export const SCHEDULED_PLAYOUT_RETRY_MS = 30_000;

type ScheduledTarget = ReturnType<typeof listScheduledTargets>[number];
type Timer = ReturnType<typeof setTimeout>;

// Catalog access, recording, and the clock used by each schedule.
interface ScheduledPlayoutDependencies {
  nextClip(channelId: string, after: string | null): ClipRef | null;
  latestPlayout(outputId: string): RecentPlayout | null;
  record(outputId: string, channelId: string, clip: ClipRef): boolean;
  now(): number;
  setTimer(callback: () => void, delayMs: number): Timer;
  clearTimer(timer: Timer): void;
  onError(target: ScheduledTarget, error: unknown): void;
}

// Read the next eligible clip from the channel's active program.
function nextScheduledClip(channelId: string, after: string | null): ClipRef | null {
  const channel = getChannel(channelId);
  if (!channel) return null;
  const video = activeProgram(channel).video;
  if (video.kind !== 'clips') return null;
  const filter = getClipFilter(video);
  if (!filter) return null;
  return getUpcomingProgramClips(video, filter, after, 1)[0] ?? null;
}

const defaultDependencies: ScheduledPlayoutDependencies = {
  nextClip: nextScheduledClip,
  latestPlayout: (outputId) => getRecentPlayouts({ limit: 1, outputId })[0] ?? null,
  record: (outputId, channelId, clip) =>
    recordPlayout(outputId, channelId, clip.clipId, clip.cursor),
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  onError: (target, error) =>
    console.error(`Scheduled playout failed for ${target.channelId}`, error),
};

// Convert the shared duration policy to the timer's millisecond unit.
function playoutDurationMs(durationSec: number): number {
  return Math.round(effectivePlayoutDurationSec(durationSec) * 1_000);
}

// Run one server-owned virtual clip schedule per configured target.
export function startScheduledPlayouts(
  dependencyOverrides: Partial<ScheduledPlayoutDependencies> = {},
): () => void {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const timers = new Map<string, Timer>();
  let stopped = false;

  // Wait until this output's next clip is due.
  const schedule = (target: ScheduledTarget, after: string | null, delayMs: number): void => {
    if (stopped) return;
    const timer = dependencies.setTimer(() => {
      timers.delete(target.outputId);
      advance(target, after);
    }, delayMs);
    timers.set(target.outputId, timer);
  };

  // Record the next slot and schedule its successor.
  const advance = (target: ScheduledTarget, after: string | null): void => {
    if (stopped) return;
    try {
      const clip = dependencies.nextClip(target.channelId, after);
      if (!clip || !dependencies.record(target.outputId, target.channelId, clip)) {
        schedule(target, after, SCHEDULED_PLAYOUT_RETRY_MS);
        return;
      }
      schedule(target, clip.cursor, playoutDurationMs(clip.durationSec));
    } catch (error) {
      dependencies.onError(target, error);
      schedule(target, after, SCHEDULED_PLAYOUT_RETRY_MS);
    }
  };

  // Resume each output after the remaining duration of its last recorded clip.
  for (const target of listScheduledTargets()) {
    const latest = dependencies.latestPlayout(target.outputId);
    if (!latest) {
      advance(target, null);
      continue;
    }
    const remainingMs = Math.max(
      0,
      Date.parse(latest.startedAt) + playoutDurationMs(latest.durationSec) - dependencies.now(),
    );
    schedule(target, latest.cursor, remainingMs);
  }

  return () => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers.values()) dependencies.clearTimer(timer);
    timers.clear();
  };
}
