import Database from 'better-sqlite3';
import { createSchema } from '../server/src/db/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let backupDir: string;
let snapshotDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'backup-data-'));
  backupDir = mkdtempSync(join(tmpdir(), 'backup-output-'));
  const database = new Database(join(dataDir, 'program.db'));
  createSchema(database);
  database.exec(`
    INSERT INTO clip_metadata VALUES ('clp_a', '["indie"]', 'WBRU');
    INSERT INTO tag_vocab VALUES ('indie', 0);
    INSERT INTO playout_events (
      id, started_at, output_id, channel_id, clip_id, cursor
    ) VALUES (
      1, '2026-08-06 12:00:00', 'wbru-tv-main', 'wbru-tv', 'clp_a', 'slot-1'
    );
  `);
  database.close();

  execFileSync(process.execPath, ['scripts/backup-data.mjs'], {
    env: {
      ...process.env,
      TAGGER_DATA_DIR: dataDir,
      BACKUP_DIR: backupDir,
    },
  });
  snapshotDir = join(backupDir, readdirSync(backupDir)[0]);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
});

describe('backup-data', () => {
  it('creates a readable SQLite snapshot', () => {
    expect(readdirSync(snapshotDir)).toEqual(['program.db']);
    const snapshotDatabase = new Database(join(snapshotDir, 'program.db'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        snapshotDatabase
          .prepare('SELECT source FROM clip_metadata WHERE clip_id = ?')
          .pluck()
          .get('clp_a'),
      ).toBe('WBRU');
      expect(snapshotDatabase.prepare('SELECT channel_id FROM playout_events').pluck().get()).toBe(
        'wbru-tv',
      );
    } finally {
      snapshotDatabase.close();
    }
  });

  it('fails when the source database is missing', () => {
    const missingDataDir = mkdtempSync(join(tmpdir(), 'backup-missing-data-'));
    const emptyBackupDir = mkdtempSync(join(tmpdir(), 'backup-missing-output-'));
    try {
      const result = spawnSync(process.execPath, ['scripts/backup-data.mjs'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TAGGER_DATA_DIR: missingDataDir,
          BACKUP_DIR: emptyBackupDir,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cannot back up - database not found');
      expect(readdirSync(emptyBackupDir)).toEqual([]);
    } finally {
      rmSync(missingDataDir, { recursive: true, force: true });
      rmSync(emptyBackupDir, { recursive: true, force: true });
    }
  });

  it('prunes only timestamp-named snapshot directories', () => {
    const retentionDir = mkdtempSync(join(tmpdir(), 'backup-retention-'));
    const oldestSnapshot = '2020-01-01T00-00-00-000Z';
    const retainedSnapshot = '2021-01-01T00-00-00-000Z';
    const unrelatedDirectory = '000-manual-copy';
    try {
      mkdirSync(join(retentionDir, oldestSnapshot));
      mkdirSync(join(retentionDir, retainedSnapshot));
      mkdirSync(join(retentionDir, unrelatedDirectory));

      execFileSync(process.execPath, ['scripts/backup-data.mjs'], {
        env: {
          ...process.env,
          TAGGER_DATA_DIR: dataDir,
          BACKUP_DIR: retentionDir,
          KEEP: '2',
        },
      });

      const entries = readdirSync(retentionDir);
      const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
      expect(entries).toContain(unrelatedDirectory);
      expect(entries).not.toContain(oldestSnapshot);
      expect(entries).toContain(retainedSnapshot);
      expect(entries.filter((name) => timestampPattern.test(name))).toHaveLength(2);
    } finally {
      rmSync(retentionDir, { recursive: true, force: true });
    }
  });
});
