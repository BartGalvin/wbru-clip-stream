import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let manifestPath: string;
let manifest: typeof import('./manifest');
let connection: typeof import('./connection');
let database: typeof import('../db');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'manifest-'));
  manifestPath = join(dataDir, 'clips-cache.json');
  vi.stubEnv('TAGGER_DATA_DIR', dataDir);
  vi.stubEnv('DATABASE_PATH', join(dataDir, 'program.db'));
  [manifest, connection, database] = await Promise.all([
    import('./manifest'),
    import('./connection'),
    import('../db'),
  ]);
  database.initializeDatabase();
});

beforeEach(() => {
  rmSync(manifestPath, { force: true });
  connection.getDatabase().exec('DELETE FROM clip_metadata; DELETE FROM clips;');
});

afterAll(() => {
  database.closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const validClip = {
  id: 'clp_valid',
  title: 'Valid clip',
  url: '/clips/valid.mp4',
  path: 'valid.mp4',
  library: 'visualizer',
  durationSec: 12.5,
};

describe('readManifest', () => {
  it('returns null only when clips-cache.json is missing', () => {
    expect(manifest.readManifest()).toBeNull();

    writeFileSync(manifestPath, '{ broken');
    expect(() => manifest.readManifest()).toThrow(SyntaxError);
  });

  it('accepts the indexer manifest shape', () => {
    writeFileSync(manifestPath, JSON.stringify([validClip]));
    expect(manifest.readManifest()).toEqual([validClip]);
  });

  it('rejects a non-array manifest', () => {
    writeFileSync(manifestPath, JSON.stringify({ clips: [validClip] }));
    expect(() => manifest.readManifest()).toThrow(
      'clips-cache.json must contain an array of clips',
    );
  });
});

describe('refreshClips', () => {
  it('leaves an empty catalog empty when the manifest is absent', () => {
    expect(manifest.refreshClips()).toEqual({ added: 0, removed: 0, total: 0 });
    expect(database.listTaggableClips()).toEqual([]);
  });
});
