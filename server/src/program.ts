import type { ClipRef } from '../../shared/contract';
import { DEFAULT_PLAYOUT_POLICY, type PlayoutPolicy } from './config/playoutPolicy';
import { lapOrder, programOrderFingerprint } from './lapOrder';

// Catalog fields used to order clips and supply their playback metadata.
export interface ProgramClip {
  id: string;
  title: string;
  publishedYear?: number | null;
  url: string;
  durationSec: number;
  library: string;
  tags: string[];
}

// Cursors pair an order fingerprint with an absolute program position.
interface ProgramCursor {
  fingerprint: number;
  position: number;
}

const encodeCursor = (fingerprint: number, position: number): string =>
  Buffer.from(`${fingerprint.toString(36)}:${position}`).toString('base64url');

// Missing, stale, or malformed cursors restart from the current program's first slot.
const decodeCursor = (cursor: string | null): ProgramCursor | null => {
  if (!cursor) return null;
  const match = /^([0-9a-z]+):(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) return null;

  const fingerprint = Number.parseInt(match[1], 36);
  const position = Number(match[2]);
  if (
    !Number.isSafeInteger(fingerprint) ||
    fingerprint < 0 ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position >= Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return { fingerprint, position };
};

// Each lap plays every clip once, with cursors providing stateless pagination.
export function getUpcomingFromRows(
  clips: ProgramClip[],
  after: string | null,
  limit: number,
  policy: PlayoutPolicy = DEFAULT_PLAYOUT_POLICY,
): ClipRef[] {
  const clipCount = clips.length;
  if (clipCount === 0) return [];
  const fingerprint = programOrderFingerprint(clips, policy);
  const decodedCursor = decodeCursor(after);
  const startPosition = decodedCursor?.fingerprint === fingerprint ? decodedCursor.position + 1 : 0;
  const items: ClipRef[] = [];
  // Reuse each lap order for every requested position that falls within it.
  let currentLap = -1;
  let currentLapOrder: number[] = [];
  for (let offset = 0; offset < limit; offset++) {
    const position = startPosition + offset;
    const lap = Math.floor(position / clipCount);
    if (lap !== currentLap) {
      currentLapOrder = lapOrder(clips, lap, policy, fingerprint);
      currentLap = lap;
    }
    const clipIndex = currentLapOrder[position % clipCount];
    const clip = clips[clipIndex];
    items.push({
      clipId: clip.id,
      title: clip.title,
      publishedYear: clip.publishedYear ?? null,
      url: clip.url,
      durationSec: clip.durationSec,
      tags: clip.tags,
      cursor: encodeCursor(fingerprint, position),
    });
  }
  return items;
}
