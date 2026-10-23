import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir, getDatabase } from './connection';
import { markCatalogChanged } from '../tagRevision';

// File-owned clip fields written by the indexer.
export interface ManifestClip {
  id: string;
  title: string;
  url: string;
  path: string;
  library: string;
  durationSec: number;
  publishedYear?: number | null;
}

// Read the local scan cache, or return null before the first index.
export function readManifest(): ManifestClip[] | null {
  const clipsManifest = join(getDataDir(), 'clips-cache.json');
  if (!existsSync(clipsManifest)) return null;
  const value: unknown = JSON.parse(readFileSync(clipsManifest, 'utf8'));
  if (!Array.isArray(value)) throw new Error('clips-cache.json must contain an array of clips');
  return value as ManifestClip[];
}

// Clip metadata remains durable when catalog availability changes.
export function syncClips(manifestClips: ManifestClip[]): {
  added: number;
  removed: number;
  total: number;
} {
  const db = getDatabase();
  const manifestClipIds = new Set(manifestClips.map((clip) => clip.id));
  let added = 0;
  let removed = 0;
  let changed = false;
  const markClipUnavailable = db.prepare('UPDATE clips SET available = 0 WHERE id = ?');
  const upsertClip = db.prepare(`
    INSERT INTO clips (id, title, url, path, library, duration_sec, published_year, available)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      path = excluded.path,
      library = excluded.library,
      duration_sec = excluded.duration_sec,
      published_year = excluded.published_year,
      available = 1
    WHERE clips.title IS NOT excluded.title
       OR clips.url IS NOT excluded.url
       OR clips.path IS NOT excluded.path
       OR clips.library IS NOT excluded.library
       OR clips.duration_sec IS NOT excluded.duration_sec
       OR clips.published_year IS NOT excluded.published_year
       OR clips.available IS NOT excluded.available
  `);
  // Reconcile availability and current file metadata as one catalog change.
  db.transaction(() => {
    const existing = db.prepare('SELECT id, available FROM clips').all() as {
      id: string;
      available: number;
    }[];
    const existingById = new Map(existing.map((row) => [row.id, row.available === 1]));
    for (const row of existing) {
      if (row.available === 1 && !manifestClipIds.has(row.id)) {
        changed = markClipUnavailable.run(row.id).changes > 0 || changed;
        removed++;
      }
    }
    for (const clip of manifestClips) {
      if (existingById.get(clip.id) !== true) added++;
      changed =
        upsertClip.run(
          clip.id,
          clip.title,
          clip.url,
          clip.path,
          clip.library,
          clip.durationSec,
          clip.publishedYear ?? null,
        ).changes > 0 || changed;
    }
  })();
  if (changed) markCatalogChanged();
  return { added, removed, total: manifestClips.length };
}

// An absent manifest never makes existing catalog clips unavailable.
export function refreshClips(): { added: number; removed: number; total: number } {
  const manifest = readManifest();
  if (manifest) return syncClips(manifest);
  const db = getDatabase();
  const existing = (
    db.prepare('SELECT COUNT(*) AS n FROM clips WHERE available = 1').get() as { n: number }
  ).n;
  if (existing > 0) {
    console.warn(
      `refreshClips: clips-cache.json missing - keeping the existing ` +
        `${existing}-clip catalog (run index-clips to regenerate the manifest).`,
    );
  }
  return { added: 0, removed: 0, total: existing };
}
