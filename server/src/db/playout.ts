import { getDatabase } from './connection';
import {
  PLAYOUT_RETENTION_DAYS,
  type CurrentPlayout,
  type ProgramPosition,
  type RecentPlayout,
} from '../../../shared/contract';
import { effectivePlayoutDurationSec } from '../config/playoutPolicy';

// Scheduled start times and media durations are approximate, so titles keep a short expiry margin.
const STALE_GRACE_SEC = 30;

interface CurrentPlayoutRow extends CurrentPlayout {
  publishedYear: number | null;
  cursor: string;
  url: string;
  tags: string;
  ageSec: number;
}

// Filters and pagination cursors for recorded playouts.
interface RecentPlayoutQuery {
  limit?: number;
  outputId?: string;
  channelId?: string;
  beforeId?: number;
  afterId?: number;
  since?: string;
  until?: string;
  search?: string;
}

// Record the clip metadata seen at the start of each scheduled slot.
export function recordPlayout(
  outputId: string,
  channelId: string,
  clipId: string,
  cursor: string,
): boolean {
  const db = getDatabase();
  const insertPlayout = db.prepare(`
    INSERT INTO playout_events (
      output_id, channel_id, clip_id, cursor,
      clip_title, clip_path, clip_library, clip_duration_sec, clip_source
    )
    SELECT ?, ?, c.id, ?, c.title, c.path, c.library, c.duration_sec, m.source
    FROM clips c
    LEFT JOIN clip_metadata m ON m.clip_id = c.id
    WHERE c.id = ?
  `);
  const pruneHistory = db.prepare(`
    DELETE FROM playout_events
    WHERE started_at < datetime('now', ?)
  `);

  return db.transaction(() => {
    const recorded = insertPlayout.run(outputId, channelId, cursor, clipId).changes === 1;
    if (recorded) pruneHistory.run(`-${PLAYOUT_RETENTION_DAYS} days`);
    return recorded;
  })();
}

// History reads newest first. Catch-up reads forward from afterId in recording order.
export function getRecentPlayouts({
  limit = 100,
  outputId,
  channelId,
  beforeId,
  afterId,
  since,
  until,
  search,
}: RecentPlayoutQuery = {}): RecentPlayout[] {
  const db = getDatabase();
  const searchText = search?.trim() || null;
  return db
    .prepare(
      `SELECT p.id, strftime('%Y-%m-%dT%H:%M:%fZ', p.started_at) AS startedAt,
              p.output_id AS outputId, p.channel_id AS channelId,
              p.clip_id AS clipId, p.cursor,
              COALESCE(p.clip_title, c.title) AS title,
              COALESCE(p.clip_path, c.path) AS path,
              COALESCE(p.clip_library, c.library) AS library,
              COALESCE(p.clip_duration_sec, c.duration_sec) AS durationSec,
              CASE WHEN c.available = 1 THEN c.url ELSE NULL END AS previewUrl,
              CASE WHEN p.clip_title IS NULL THEN m.source ELSE p.clip_source END AS source
       FROM playout_events p
       JOIN clips c ON c.id = p.clip_id
       LEFT JOIN clip_metadata m ON m.clip_id = c.id
       WHERE (? IS NULL OR p.output_id = ?)
         AND (? IS NULL OR p.channel_id = ?)
         AND p.id < COALESCE(?, 9223372036854775807)
         AND p.id > COALESCE(?, 0)
         AND (? IS NULL OR p.started_at >= datetime(?))
         AND (? IS NULL OR p.started_at <= datetime(?))
         AND (? IS NULL
              OR instr(lower(COALESCE(p.clip_title, c.title)), lower(?)) > 0
              OR instr(lower(COALESCE(p.clip_path, c.path)), lower(?)) > 0
              OR instr(lower(COALESCE(
                   CASE WHEN p.clip_title IS NULL THEN m.source ELSE p.clip_source END, ''
                 )), lower(?)) > 0)
       ORDER BY p.id ${afterId === undefined ? 'DESC' : 'ASC'}
       LIMIT ?`,
    )
    .all(
      outputId ?? null,
      outputId ?? null,
      channelId ?? null,
      channelId ?? null,
      beforeId ?? null,
      afterId ?? null,
      since ?? null,
      since ?? null,
      until ?? null,
      until ?? null,
      searchText,
      searchText,
      searchText,
      searchText,
      Math.min(1000, Math.max(1, limit)),
    ) as RecentPlayout[];
}

// Load the latest non-expired event with the media fields needed for playback.
function getCurrentPlayoutRow(outputId: string): CurrentPlayoutRow | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT p.output_id AS outputId, p.channel_id AS channelId,
              p.clip_id AS clipId, p.cursor,
              strftime('%Y-%m-%dT%H:%M:%fZ', p.started_at) AS startedAt,
              COALESCE(p.clip_title, c.title) AS title,
              c.published_year AS publishedYear,
              c.url, COALESCE(p.clip_duration_sec, c.duration_sec) AS durationSec,
              COALESCE(m.tags, '[]') AS tags,
              (julianday('now') - julianday(p.started_at)) * 86400 AS ageSec
       FROM playout_events p
       JOIN clips c ON c.id = p.clip_id
       LEFT JOIN clip_metadata m ON m.clip_id = c.id
       WHERE p.output_id = ?
       ORDER BY p.id DESC
       LIMIT 1`,
    )
    .get(outputId) as CurrentPlayoutRow | undefined;

  if (!row) return null;
  if (row.ageSec > effectivePlayoutDurationSec(row.durationSec) + STALE_GRACE_SEC) return null;
  return row;
}

// Keep the title current for the clip's duration plus the expiry margin.
export function getCurrentPlayout(outputId: string): CurrentPlayout | null {
  const row = getCurrentPlayoutRow(outputId);
  if (!row) return null;
  return {
    outputId: row.outputId,
    channelId: row.channelId,
    clipId: row.clipId,
    title: row.title,
    publishedYear: row.publishedYear,
    startedAt: row.startedAt,
    durationSec: row.durationSec,
  };
}

// Return the media and offset needed to join a server-owned timeline.
export function getProgramPosition(outputId: string): ProgramPosition | null {
  const row = getCurrentPlayoutRow(outputId);
  if (!row) return null;
  return {
    clip: {
      clipId: row.clipId,
      title: row.title,
      url: row.url,
      durationSec: row.durationSec,
      cursor: row.cursor,
      tags: JSON.parse(row.tags) as string[],
    },
    timeSec: Math.max(0, row.ageSec),
  };
}
