import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSchema } from '../server/src/db/schema';
import { devCommands, latestSnapshot, pullSnapshot, writeSnapshotManifest } from './dev.mjs';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('pulls independent snapshots and keeps the previous one after a failed transfer', async () => {
  const root = temporaryDirectory();
  const bin = join(root, 'bin');
  const snapshots = join(root, 'snapshots');
  const sourcePath = join(root, 'program.db');
  const envFile = join(root, 'service.env');
  mkdirSync(bin);
  // Execute the SSH payload locally against a fixture database.
  writeFileSync(
    join(bin, 'ssh'),
    '#!/usr/bin/env bash\nwhile (( $# > 1 )); do shift; done\nexec bash -c "$1"\n',
    { mode: 0o755 },
  );
  writeFileSync(envFile, `DATABASE_PATH='${sourcePath}'\n`);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  const source = new Database(sourcePath);
  createSchema(source);
  source.exec("INSERT INTO clip_metadata VALUES ('one', '[\"indie\"]', 'Production')");
  source.close();
  const original = readFileSync(sourcePath);
  const config = {
    DEV_SSH_HOST: 'fixture',
    DEV_REMOTE_APP_DIR: process.cwd(),
    DEV_REMOTE_ENV_FILE: envFile,
  };

  const first = await pullSnapshot(config, snapshots);
  const local = new Database(join(first, 'program.db'));
  local.exec("UPDATE clip_metadata SET source = 'Local experiment'");
  local.close();
  const localEdits = readFileSync(join(first, 'program.db'));
  const second = await pullSnapshot(config, snapshots);
  expect(second).not.toBe(first);
  expect(latestSnapshot(snapshots)).toBe(second);
  expect(readFileSync(join(first, 'program.db'))).toEqual(localEdits);
  expect(readFileSync(sourcePath)).toEqual(original);
  const fresh = new Database(join(second, 'program.db'), { readonly: true });
  expect(fresh.prepare('SELECT source FROM clip_metadata').pluck().get()).toBe('Production');
  fresh.close();

  await expect(
    pullSnapshot({ ...config, DEV_REMOTE_ENV_FILE: join(root, 'missing.env') }, snapshots),
  ).rejects.toThrow('Snapshot transfer failed');
  expect(latestSnapshot(snapshots)).toBe(second);
  expect(readdirSync(snapshots)).toHaveLength(2);
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'wbru-development-'));
  roots.push(directory);
  return directory;
}

it('reconstructs the available catalog without changing tags or sources', () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'program.db');
  const database = new Database(path);
  createSchema(database);
  database.exec(`
    INSERT INTO clips VALUES ('one', 'Session', '/clips/session.mp4', 'session.mp4',
                              'wbru-youtube', 180, 2024, 1);
    INSERT INTO clips VALUES ('gone', 'Gone', '/clips/gone.mp4', 'gone.mp4',
                              'visualizer', 7, NULL, 0);
    INSERT INTO clip_metadata VALUES ('one', '["inactive"]', 'Studio');
  `);
  database.close();
  const original = readFileSync(path);

  expect(writeSnapshotManifest(directory)).toBe(1);
  expect(JSON.parse(readFileSync(join(directory, 'clips-cache.json'), 'utf8'))).toEqual([
    {
      id: 'one',
      title: 'Session',
      url: '/clips/session.mp4',
      path: 'session.mp4',
      library: 'wbru-youtube',
      durationSec: 180,
      publishedYear: 2024,
    },
  ]);
  expect(readFileSync(path)).toEqual(original);
});

it('selects the newest completed snapshot, leaving older experiments alone', () => {
  const root = temporaryDirectory();
  expect(() => latestSnapshot(root)).toThrow('npm run dev:pull');
  for (const name of [
    '2026-10-01T10-00-00-000Z',
    '2026-10-02T10-00-00-000Z',
    '.incoming-2026-10-03T10-00-00-000Z',
  ])
    mkdirSync(join(root, name));
  expect(latestSnapshot(root)).toBe(join(root, '2026-10-02T10-00-00-000Z'));
});

it('points application writes at the local snapshot and tunnels only to the media listener', () => {
  const commands = devCommands(
    {
      DEV_SSH_HOST: 'media.example.com',
      DEV_MEDIA_REMOTE: '192.0.2.10:8766',
    },
    '/local/snapshot',
  );
  expect(commands.find(({ name }) => name === 'media')?.command).toContain(
    "'127.0.0.1:8767:192.0.2.10:8766'",
  );
  for (const command of commands.filter(({ name }) => name !== 'media')) {
    expect(command.env).toMatchObject({
      TAGGER_DATA_DIR: '/local/snapshot',
      DATABASE_PATH: '/local/snapshot/program.db',
      CLIPS_SCAN_ENABLED: '0',
      NODE_ENV: 'development',
      DEV_MEDIA_ORIGIN: 'http://127.0.0.1:8767',
      DEV_WEB_PORT: '5174',
    });
  }
});
