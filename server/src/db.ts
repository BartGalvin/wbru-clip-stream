import { openDatabase } from './db/connection';
import { refreshClips } from './db/manifest';
import { createSchema } from './db/schema';

export function initializeDatabase(): void {
  // Open storage, create its schema, then reconcile the filesystem manifest.
  const db = openDatabase();
  createSchema(db);
  refreshClips();
}

export { closeDatabase } from './db/connection';
export { listProgramClips, listTaggableClips } from './db/clips';
export {
  InvalidTagNameError,
  UnknownClipError,
  listTagVocabulary,
  addVocabTag,
  removeVocabTag,
  setClipTagsBatch,
  setClipSources,
} from './db/metadata';
export { syncClips, refreshClips } from './db/manifest';
export {
  recordPlayout,
  getCurrentPlayout,
  getProgramPosition,
  getRecentPlayouts,
} from './db/playout';
