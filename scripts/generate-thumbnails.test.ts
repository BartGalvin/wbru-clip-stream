import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let dataDir: string;
let clipsDir: string;
let encoder: string;
const script = join(process.cwd(), 'scripts/generate-thumbnails.mjs');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clip-thumbnails-'));
  dataDir = join(root, 'data');
  clipsDir = join(root, 'clips');
  encoder = join(root, 'ffmpeg');
  mkdirSync(dataDir);
  mkdirSync(clipsDir);
  writeFileSync(join(root, 'calls'), '');
  // Record encoding requests and simulate a failed partial image.
  writeFileSync(
    encoder,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "if (args.includes('-version')) process.exit(0);",
      "appendFileSync(process.env.THUMBNAIL_CALLS, JSON.stringify(args) + '\\n');",
      "writeFileSync(args.at(-1), 'image');",
      "if (args[args.indexOf('-i') + 1].endsWith('broken.mp4')) process.exit(1);",
    ].join('\n'),
  );
  chmodSync(encoder, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runGenerator(
  clips: { id: string; path: string; durationSec: number }[],
  args: string[] = [],
) {
  writeFileSync(join(dataDir, 'clips-cache.json'), JSON.stringify(clips));
  return spawnSync(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      CLIPS_DIR: clipsDir,
      TAGGER_DATA_DIR: dataDir,
      DATABASE_PATH: join(dataDir, 'program.db'),
      FFMPEG_BIN: encoder,
      THUMBNAIL_CALLS: join(root, 'calls'),
    },
    encoding: 'utf8',
  });
}

const calls = (): string[][] =>
  readFileSync(join(root, 'calls'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

it('reuses cached images by content ID across repeated plays and folder moves', () => {
  const first = { id: 'clp_one', path: 'session with spaces.mp4', durationSec: 10 };
  const short = { id: 'clp_short', path: 'transition.mp4', durationSec: 0.2 };
  const result = runGenerator([first, short, first]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('2 created, 1 cached, 0 failed');
  expect(readdirSync(join(dataDir, 'thumbnails')).sort()).toEqual(['clp_one.jpg', 'clp_short.jpg']);
  const requests = calls();
  expect(requests).toHaveLength(2);
  expect(requests[0][requests[0].indexOf('-i') + 1]).toBe(join(clipsDir, first.path));
  expect(requests[1][requests[1].indexOf('-ss') + 1]).toBe('0');

  const unusedImage = join(dataDir, 'thumbnails', 'clp_unused.jpg');
  writeFileSync(unusedImage, 'unused image');
  const repeated = runGenerator([{ ...first, path: 'new folder/session.mp4' }, short]);
  expect(repeated.status, repeated.stderr).toBe(0);
  expect(repeated.stdout).toContain('0 created, 2 cached, 0 failed');
  expect(calls()).toHaveLength(2);
  expect(readFileSync(unusedImage, 'utf8')).toBe('unused image');
});

it('continues after a failed image and retries it on the next run', () => {
  const broken = { id: 'clp_broken', path: 'broken.mp4', durationSec: 5 };
  const good = { id: 'clp_good', path: 'good.mp4', durationSec: 5 };
  const result = runGenerator([broken, good]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Could not create thumbnail for broken.mp4');
  expect(readdirSync(join(dataDir, 'thumbnails'))).toEqual(['clp_good.jpg']);

  const resumed = runGenerator([{ ...broken, path: 'fixed.mp4' }, good]);
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.stdout).toContain('1 created, 1 cached, 0 failed');
  expect(readdirSync(join(dataDir, 'thumbnails')).sort()).toEqual([
    'clp_broken.jpg',
    'clp_good.jpg',
  ]);
});

it('prunes only JPEGs unused by the scan cache, available catalog, and retained history', () => {
  const databasePath = join(dataDir, 'program.db');
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE clips (id TEXT PRIMARY KEY, available INTEGER NOT NULL);
    CREATE TABLE playout_events (clip_id TEXT NOT NULL);
    INSERT INTO clips VALUES ('clp_available', 1), ('clp_logged', 0), ('clp_deleted', 0);
    INSERT INTO playout_events VALUES ('clp_logged');
  `);
  database.close();
  const before = readFileSync(databasePath);
  const directory = join(dataDir, 'thumbnails');
  mkdirSync(directory);
  const files = [
    'clp_new.jpg',
    'clp_available.jpg',
    'clp_logged.jpg',
    'clp_deleted.jpg',
    'clp_orphan.jpg',
    '.clp_pending-123.jpg',
    'notes.txt',
  ];
  for (const name of files) writeFileSync(join(directory, name), 'image');
  rmSync(encoder);

  const result = runGenerator([{ id: 'clp_new', path: 'new.mp4', durationSec: 5 }], ['--prune']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Pruned 2 unused thumbnail(s).');
  expect(readdirSync(directory).sort()).toEqual(
    files.filter((name) => name !== 'clp_deleted.jpg' && name !== 'clp_orphan.jpg').sort(),
  );
  expect(readFileSync(databasePath)).toEqual(before);
  expect(calls()).toEqual([]);
});

it('leaves images in place when the pruning database is missing', () => {
  const directory = join(dataDir, 'thumbnails');
  mkdirSync(directory);
  const image = join(directory, 'clp_unused.jpg');
  writeFileSync(image, 'image');

  const result = runGenerator([], ['--prune']);
  expect(result.status).not.toBe(0);
  expect(readFileSync(image, 'utf8')).toBe('image');
  expect(existsSync(join(dataDir, 'program.db'))).toBe(false);
});
