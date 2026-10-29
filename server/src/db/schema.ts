import type Database from 'better-sqlite3';

const PLAYOUT_SNAPSHOT_COLUMNS = [
  ['clip_title', 'TEXT'],
  ['clip_path', 'TEXT'],
  ['clip_library', 'TEXT'],
  ['clip_duration_sec', 'REAL'],
  ['clip_source', 'TEXT'],
] as const;

// Ensure playout records can retain the title, path, duration, and source captured at playback.
function addMissingPlayoutSnapshotColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(playout_events)').all() as { name: string }[]).map(
      ({ name }) => name,
    ),
  );
  for (const [name, type] of PLAYOUT_SNAPSHOT_COLUMNS) {
    if (columns.has(name)) continue;
    db.exec(`ALTER TABLE playout_events ADD COLUMN ${name} ${type}`);
  }
}

export function createSchema(db: Database.Database): void {
  // Create the current tables and lookup indexes when the database is first opened.
  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      url          TEXT NOT NULL,
      path         TEXT NOT NULL,
      library      TEXT NOT NULL,
      duration_sec REAL NOT NULL,
      published_year INTEGER,
      available    INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS clip_metadata (
      clip_id TEXT PRIMARY KEY,
      tags    TEXT NOT NULL DEFAULT '[]',
      source  TEXT
    );

    CREATE TABLE IF NOT EXISTS tag_vocab (
      tag      TEXT PRIMARY KEY,
      position INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS metadata_changes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      changed_at   TEXT NOT NULL,
      batch_id     TEXT NOT NULL,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      field        TEXT NOT NULL,
      before_value TEXT NOT NULL,
      after_value  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS metadata_changes_entity
    ON metadata_changes (entity_type, entity_id, id);

    CREATE INDEX IF NOT EXISTS metadata_changes_batch
    ON metadata_changes (batch_id);

    CREATE TABLE IF NOT EXISTS playout_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      output_id  TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      clip_id    TEXT NOT NULL,
      cursor     TEXT NOT NULL,
      clip_title TEXT,
      clip_path TEXT,
      clip_library TEXT,
      clip_duration_sec REAL,
      clip_source TEXT
    );

    CREATE INDEX IF NOT EXISTS clips_library_available
    ON clips (library, available);

    CREATE INDEX IF NOT EXISTS playout_events_started_at
    ON playout_events (started_at);

    CREATE INDEX IF NOT EXISTS playout_events_output_started_at
    ON playout_events (output_id, started_at);
  `);
  // Existing catalogs gain the upload year without rewriting clip records.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('clips') WHERE name = 'published_year'").get()) {
    db.exec('ALTER TABLE clips ADD COLUMN published_year INTEGER');
  }
  addMissingPlayoutSnapshotColumns(db);
}
