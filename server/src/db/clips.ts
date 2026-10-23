import { getDatabase } from './connection';
import type { ProgramClip } from '../program';
import type { TaggableClip } from '../../../shared/contract';

const parseTags = (raw: string): string[] => JSON.parse(raw) as string[];

// Load the available clips and metadata needed by the program scheduler.
export function listProgramClips(library: string): ProgramClip[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.url, c.library, c.duration_sec,
              COALESCE(m.tags, '[]') AS tags
       FROM clips c
       LEFT JOIN clip_metadata m ON m.clip_id = c.id
       WHERE c.library = ? AND c.available = 1
       ORDER BY c.id`,
    )
    .all(library) as {
    id: string;
    title: string;
    url: string;
    library: string;
    duration_sec: number;
    tags: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    library: row.library,
    durationSec: row.duration_sec,
    tags: parseTags(row.tags),
  }));
}

// Load the complete operator-facing catalog, including editable metadata.
export function listTaggableClips(): TaggableClip[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.url, c.path, c.library,
              COALESCE(m.tags, '[]') AS tags, m.source
       FROM clips c
       LEFT JOIN clip_metadata m ON m.clip_id = c.id
       WHERE c.available = 1
       ORDER BY c.library, c.path, c.url`,
    )
    .all() as {
    id: string;
    title: string;
    url: string;
    path: string;
    library: string;
    tags: string;
    source: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    path: row.path,
    library: row.library,
    tags: parseTags(row.tags),
    source: row.source,
  }));
}
