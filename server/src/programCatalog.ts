import type { ClipRef, VideoSource } from '../../shared/contract';
import { isClipEligibleForRotation } from '../../shared/libraries';
import { matchesTagFilter, type TagFilter } from '../../shared/tagFilter';
import { listProgramClips } from './db';
import { playoutPolicyForLibrary } from './config/playoutPolicy';
import { getUpcomingFromRows } from './program';

// Apply one clip program's library and tag rules before deriving its next slots.
export function getUpcomingProgramClips(
  video: Extract<VideoSource, { kind: 'clips' }>,
  filter: TagFilter,
  after: string | null,
  limit: number,
): ClipRef[] {
  const clips = listProgramClips(video.library).filter(
    (clip) => isClipEligibleForRotation(clip) && matchesTagFilter(clip.tags, filter),
  );
  return getUpcomingFromRows(clips, after, limit, playoutPolicyForLibrary(video.library));
}
