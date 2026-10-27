import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.TAGGER_DATA_DIR ?? 'server';
const clipsDir = process.env.CLIPS_DIR ?? 'public/clips';
const thumbnailDir = join(dataDir, 'thumbnails');
const clips = JSON.parse(readFileSync(join(dataDir, 'clips-cache.json'), 'utf8'));
const ffmpeg = process.env.FFMPEG_BIN ?? 'ffmpeg';

// Keep catalog images and any image still used by retained playout history.
if (process.argv.includes('--prune')) {
  const keepIds = new Set(clips.map((clip) => clip.id));
  const databasePath = process.env.DATABASE_PATH ?? join(dataDir, 'program.db');
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const retained = database
      .prepare(
        'SELECT id FROM clips WHERE available = 1 UNION SELECT clip_id AS id FROM playout_events',
      )
      .all();
    for (const { id } of retained) keepIds.add(id);
  } finally {
    database.close();
  }

  let removed = 0;
  if (existsSync(thumbnailDir)) {
    for (const entry of readdirSync(thumbnailDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.jpg')) continue;
      if (keepIds.has(entry.name.slice(0, -4))) continue;
      rmSync(join(thumbnailDir, entry.name));
      removed++;
    }
  }
  console.log(`Pruned ${removed} unused thumbnail(s).`);
  process.exit(0);
}

// Check the encoder before starting the batch.
execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
mkdirSync(thumbnailDir, { recursive: true });
let created = 0;
let cached = 0;
let failed = 0;

// Content IDs keep images reusable across folder moves and repeated runs.
for (const clip of clips) {
  const thumbnailPath = join(thumbnailDir, `${clip.id}.jpg`);
  if (existsSync(thumbnailPath)) {
    cached++;
    continue;
  }

  const temporaryPath = join(thumbnailDir, `.${clip.id}-${process.pid}.jpg`);
  // Use the first frame for short clips and seek one second into longer videos.
  const timeSec = clip.durationSec > 1 ? 1 : 0;
  try {
    execFileSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-threads',
        '1',
        '-ss',
        String(timeSec),
        '-i',
        join(clipsDir, clip.path),
        '-frames:v',
        '1',
        '-vf',
        'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
        '-threads',
        '1',
        '-q:v',
        '4',
        '-update',
        '1',
        '-y',
        temporaryPath,
      ],
      { timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    // Rename the finished JPEG into the cache.
    renameSync(temporaryPath, thumbnailPath);
    created++;
    if (created % 100 === 0) console.log(`Created ${created} thumbnails...`);
  } catch (error) {
    failed++;
    console.error(`Could not create thumbnail for ${clip.path}: ${error.message}`);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

console.log(`Thumbnails: ${created} created, ${cached} cached, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
