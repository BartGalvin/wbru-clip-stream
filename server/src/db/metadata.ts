import type { ClipTagUpdate } from '../../../shared/contract';
import { markCatalogChanged } from '../tagRevision';
import { getDatabase } from './connection';

// Signals that a metadata mutation referenced a clip outside the active catalog.
export class UnknownClipError extends Error {}
// Signals that a tag cannot be represented by the comma-separated URL format.
export class InvalidTagNameError extends Error {}

// Normalized result of applying one source label to a validated clip batch.
export interface ClipSourceBatch {
  ids: string[];
  source: string | null;
}

const parseTags = (raw: string): string[] => JSON.parse(raw) as string[];

function assertValidTagName(tag: string): void {
  if (tag.includes(',')) throw new InvalidTagNameError('tag names cannot contain commas');
}

// Normalize tag input once before storing its JSON representation.
function normalizeTags(tags: string[]): string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  normalized.forEach(assertValidTagName);
  return normalized;
}

// Preserve the operator-defined vocabulary order.
export function listTagVocabulary(): string[] {
  const db = getDatabase();
  return (db.prepare('SELECT tag FROM tag_vocab ORDER BY position').all() as { tag: string }[]).map(
    ({ tag }) => tag,
  );
}

// Append a new vocabulary tag without disturbing the existing order.
export function addVocabTag(tag: string): string[] {
  const db = getDatabase();
  const clean = tag.trim();
  assertValidTagName(clean);
  const changed = clean
    ? db
        .prepare(
          `INSERT OR IGNORE INTO tag_vocab (tag, position)
       SELECT ?, COALESCE(MAX(position), -1) + 1 FROM tag_vocab`,
        )
        .run(clean).changes > 0
    : false;
  if (changed) markCatalogChanged();
  return listTagVocabulary();
}

// Remove a tag from both the vocabulary and every clip in one transaction.
export function removeVocabTag(tag: string): { vocab: string[]; affected: number } {
  const db = getDatabase();
  let affected = 0;
  let changed = false;
  const rows = db.prepare('SELECT clip_id, tags FROM clip_metadata').all() as {
    clip_id: string;
    tags: string;
  }[];
  const update = db.prepare('UPDATE clip_metadata SET tags = ? WHERE clip_id = ?');

  db.transaction(() => {
    changed = db.prepare('DELETE FROM tag_vocab WHERE tag = ?').run(tag).changes > 0;
    for (const row of rows) {
      const tags = parseTags(row.tags);
      const next = tags.filter((value) => value !== tag);
      if (next.length === tags.length) continue;
      update.run(JSON.stringify(next), row.clip_id);
      affected++;
      changed = true;
    }
  })();

  if (changed) markCatalogChanged();
  return { vocab: listTagVocabulary(), affected };
}

// Validate and replace a batch of clip tags in one transaction.
export function setClipTagsBatch(updates: ClipTagUpdate[]): ClipTagUpdate[] {
  const db = getDatabase();
  const normalized = updates.map(({ id, tags }) => ({ id, tags: normalizeTags(tags) }));
  const exists = db.prepare('SELECT 1 FROM clips WHERE id = ? AND available = 1');
  const update = db.prepare(
    `INSERT INTO clip_metadata (clip_id, tags, source) VALUES (?, ?, NULL)
     ON CONFLICT(clip_id) DO UPDATE SET tags = excluded.tags
     WHERE clip_metadata.tags IS NOT excluded.tags`,
  );

  const changed = db.transaction(() => {
    for (const { id } of normalized) {
      if (!exists.get(id)) throw new UnknownClipError(`unknown clip id: ${id}`);
    }
    let didChange = false;
    for (const { id, tags } of normalized) {
      didChange = update.run(id, JSON.stringify(tags)).changes > 0 || didChange;
    }
    return didChange;
  })();

  if (changed) markCatalogChanged();
  return normalized;
}

// Apply one tag change while preserving the clip's remaining metadata.
export function setClipTag(id: string, tag: string, enabled: boolean): ClipTagUpdate {
  const db = getDatabase();
  const cleanTag = tag.trim();
  assertValidTagName(cleanTag);
  return db.transaction(() => {
    const row = db.prepare('SELECT tags FROM clip_metadata WHERE clip_id = ?').get(id) as
      | { tags: string }
      | undefined;
    const tags = parseTags(row?.tags ?? '[]');
    return setClipTagsBatch([
      { id, tags: enabled ? [...tags, cleanTag] : tags.filter((value) => value !== cleanTag) },
    ])[0];
  })();
}

// Validate the whole batch before applying one source value atomically.
export function setClipSources(ids: string[], source: string | null): ClipSourceBatch {
  const db = getDatabase();
  const uniqueIds = [...new Set(ids)];
  const clean = source?.trim() || null;
  const exists = db.prepare('SELECT 1 FROM clips WHERE id = ? AND available = 1');
  const update = db.prepare(`
    INSERT INTO clip_metadata (clip_id, tags, source) VALUES (?, '[]', ?)
    ON CONFLICT(clip_id) DO UPDATE SET source = excluded.source
    WHERE clip_metadata.source IS NOT excluded.source
  `);

  const result = db.transaction(() => {
    for (const id of uniqueIds) {
      if (!exists.get(id)) throw new UnknownClipError(`unknown clip id: ${id}`);
    }
    let changed = false;
    for (const id of uniqueIds) changed = update.run(id, clean).changes > 0 || changed;
    return { value: { ids: uniqueIds, source: clean }, changed };
  })();
  if (result.changed) markCatalogChanged();
  return result.value;
}
