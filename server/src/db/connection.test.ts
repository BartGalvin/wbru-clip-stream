import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema } from './schema';

let dataDir = '';
let connection: typeof import('./connection') | undefined;

afterEach(() => {
  connection?.closeDatabase();
  connection = undefined;
  vi.unstubAllEnvs();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = '';
  vi.resetModules();
});

describe('database startup boundary', () => {
  it('adds upload years to an existing catalog without changing its clips', () => {
    const database = new Database(':memory:');
    try {
      createSchema(database);
      database.exec(
        "INSERT INTO clips (id, title, url, path, library, duration_sec) VALUES ('clip-1', 'Studio Session', '/clips/session.mp4', 'session.mp4', 'wbru-youtube', 60)",
      );
      database.exec('ALTER TABLE clips DROP COLUMN published_year');

      createSchema(database);
      createSchema(database);

      expect(database.prepare('SELECT title, published_year FROM clips').get()).toEqual({
        title: 'Studio Session',
        published_year: null,
      });
    } finally {
      database.close();
    }
  });

  it('keeps imports inert and initializes only through initializeDatabase', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'database-import-'));
    const databasePath = join(dataDir, 'program.db');
    vi.stubEnv('TAGGER_DATA_DIR', dataDir);
    vi.stubEnv('DATABASE_PATH', databasePath);
    vi.resetModules();

    const [database, connectionModule] = await Promise.all([
      import('../db'),
      import('./connection'),
    ]);
    connection = connectionModule;

    expect(existsSync(databasePath)).toBe(false);
    expect(() => connectionModule.getDatabase()).toThrow(
      'Database is not initialized. Call initializeDatabase() before using database modules.',
    );
    expect(existsSync(databasePath)).toBe(false);

    database.initializeDatabase();

    expect(existsSync(databasePath)).toBe(true);
    const schema = connectionModule
      .getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clips'")
      .get();
    expect(schema).toEqual({ name: 'clips' });
  });

  it('adds playout snapshot columns to a database without them', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'database-migration-'));
    const databasePath = join(dataDir, 'program.db');
    const existingDatabase = new Database(databasePath);
    existingDatabase.exec(`
      CREATE TABLE playout_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        output_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        clip_id TEXT NOT NULL,
        cursor TEXT NOT NULL
      )
    `);
    existingDatabase.close();
    vi.stubEnv('TAGGER_DATA_DIR', dataDir);
    vi.stubEnv('DATABASE_PATH', databasePath);
    vi.resetModules();

    const [database, connectionModule] = await Promise.all([
      import('../db'),
      import('./connection'),
    ]);
    connection = connectionModule;
    database.initializeDatabase();

    const columns = connectionModule
      .getDatabase()
      .prepare('PRAGMA table_info(playout_events)')
      .all() as {
      name: string;
    }[];
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'clip_title',
        'clip_path',
        'clip_library',
        'clip_duration_sec',
        'clip_source',
      ]),
    );
  });
});
