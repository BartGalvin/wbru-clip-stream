import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogRevision } from '../src/tagRevision';

let dataDir: string;
let db: typeof import('../src/db');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tagger-db-'));
  vi.stubEnv('TAGGER_DATA_DIR', dataDir);
  vi.stubEnv('DATABASE_PATH', join(dataDir, 'program.db'));
  db = await import('../src/db');
  db.initializeDatabase();
});

afterAll(() => {
  db.closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const clip = (id: string, library = 'visualizer') => ({
  id,
  title: id,
  url: '/clips/' + id + '.mp4',
  path: id + '.mp4',
  library,
  durationSec: 60,
});

const tagsOf = (id: string): string[] | undefined =>
  db.listTaggableClips().find((clipRecord) => clipRecord.id === id)?.tags;
const sourceOf = (id: string): string | null | undefined =>
  db.listTaggableClips().find((clipRecord) => clipRecord.id === id)?.source;
const libraryOf = (id: string): string | undefined =>
  db.listTaggableClips().find((clipRecord) => clipRecord.id === id)?.library;

describe('playout timestamps', () => {
  it('returns stored SQLite UTC timestamps in ISO format', async () => {
    db.syncClips([{ ...clip('clp_timestamp'), durationSec: 0 }]);
    db.recordPlayout('timestamp-test', 'indie', 'clp_timestamp', 'slot-1');
    const { getDatabase } = await import('../src/db/connection');
    getDatabase()
      .prepare('UPDATE playout_events SET started_at = ? WHERE output_id = ?')
      .run('2026-08-29 15:00:00', 'timestamp-test');

    expect(db.getRecentPlayouts({ limit: 1, outputId: 'timestamp-test' })[0].startedAt).toBe(
      '2026-08-29T15:00:00.000Z',
    );
  });

  it('does not record a missing clip', () => {
    expect(db.recordPlayout('indie-server', 'indie', 'missing', 'slot')).toBe(false);
  });

  it('keeps the clip metadata recorded with each event', () => {
    const original = {
      ...clip('clp_history'),
      title: 'Original title',
      path: 'original/path.mp4',
      durationSec: 42,
    };
    db.syncClips([original]);
    db.setClipSources([original.id], 'Original source');
    db.recordPlayout('history-test', 'indie', original.id, 'history-slot');

    db.syncClips([
      {
        ...original,
        title: 'Renamed title',
        path: 'renamed/path.mp4',
        url: '/clips/renamed/path.mp4',
        library: 'wbru-youtube',
        durationSec: 90,
      },
    ]);
    db.setClipSources([original.id], 'Renamed source');

    expect(db.getRecentPlayouts({ outputId: 'history-test' })[0]).toMatchObject({
      title: 'Original title',
      path: 'original/path.mp4',
      library: 'visualizer',
      durationSec: 42,
      source: 'Original source',
      previewUrl: '/clips/renamed/path.mp4',
    });
    expect(db.getCurrentPlayout('history-test')).toMatchObject({
      title: 'Original title',
      durationSec: 42,
    });

    db.syncClips([]);
    expect(db.getRecentPlayouts({ outputId: 'history-test' })[0]).toMatchObject({
      title: 'Original title',
      previewUrl: null,
    });
  });

  it('expires a clip whose duration was unavailable', async () => {
    db.syncClips([{ ...clip('clp_unknown_duration'), durationSec: 0 }]);
    db.recordPlayout('unknown-duration-test', 'indie', 'clp_unknown_duration', 'slot-1');
    const { getDatabase } = await import('../src/db/connection');
    getDatabase()
      .prepare(
        "UPDATE playout_events SET started_at = datetime('now', '-45 seconds') WHERE output_id = ?",
      )
      .run('unknown-duration-test');

    expect(db.getCurrentPlayout('unknown-duration-test')).toBeNull();
  });

  it('prunes events older than the retention window', async () => {
    db.syncClips([clip('clp_retention')]);
    db.recordPlayout('retention-test', 'indie', 'clp_retention', 'old-slot');
    const { getDatabase } = await import('../src/db/connection');
    getDatabase()
      .prepare(
        "UPDATE playout_events SET started_at = datetime('now', '-8 days') WHERE output_id = ?",
      )
      .run('retention-test');

    db.recordPlayout('retention-test', 'indie', 'clp_retention', 'new-slot');

    expect(
      db.getRecentPlayouts({ outputId: 'retention-test' }).map(({ cursor }) => cursor),
    ).toEqual(['new-slot']);
  });
});

describe('syncClips', () => {
  it('updates the overlay upload year while preserving tags and source', () => {
    const session = { ...clip('clp_year', 'wbru-youtube'), publishedYear: 2014 };
    db.syncClips([session]);
    db.setClipTagsBatch([{ id: session.id, tags: ['session'] }]);
    db.setClipSources([session.id], 'WBRU');
    db.recordPlayout('year-test', 'wbru-tv', session.id, 'year-slot');
    expect(db.getCurrentPlayout('year-test')?.publishedYear).toBe(2014);

    db.syncClips([{ ...session, publishedYear: 2015 }]);
    expect(db.getCurrentPlayout('year-test')?.publishedYear).toBe(2015);
    expect(tagsOf(session.id)).toEqual(['session']);
    expect(sourceOf(session.id)).toBe('WBRU');

    db.syncClips([{ ...session, publishedYear: null }]);
    expect(db.getCurrentPlayout('year-test')?.publishedYear).toBeNull();
  });

  it('reconciles availability while preserving operator metadata', () => {
    db.syncClips([clip('clp_a')]);
    db.setClipTagsBatch([{ id: 'clp_a', tags: ['x'] }]);

    const syncResult = db.syncClips([clip('clp_b')]);
    expect(syncResult.removed).toBe(1);
    expect(db.listTaggableClips().some((clipRecord) => clipRecord.id === 'clp_a')).toBe(false);

    db.syncClips([clip('clp_a')]);
    expect(tagsOf('clp_a')).toEqual(['x']);
  });

  it('makes every clip unavailable after an empty scan', () => {
    db.syncClips([clip('clp_keep')]);
    expect(db.syncClips([])).toEqual({ added: 0, removed: 1, total: 0 });
    expect(db.listTaggableClips()).toEqual([]);
  });

  it('preserves explicit library ownership', () => {
    db.syncClips([clip('clp_main'), clip('clp_tv', 'wbru-youtube')]);
    expect(libraryOf('clp_main')).toBe('visualizer');
    expect(libraryOf('clp_tv')).toBe('wbru-youtube');
  });
});

describe('setClipTagsBatch', () => {
  beforeEach(() => {
    db.syncClips([clip('clp_s')]);
  });

  it('dedupes and persists the tag set', () => {
    expect(db.setClipTagsBatch([{ id: 'clp_s', tags: [' foo ', 'bar', 'foo'] }])).toEqual([
      { id: 'clp_s', tags: ['foo', 'bar'] },
    ]);
    expect(tagsOf('clp_s')).toEqual(['foo', 'bar']);
  });

  it('validates a batch before changing any clip', () => {
    db.setClipTagsBatch([{ id: 'clp_s', tags: ['before'] }]);
    expect(() =>
      db.setClipTagsBatch([
        { id: 'clp_s', tags: ['after'] },
        { id: 'clp_missing', tags: ['after'] },
      ]),
    ).toThrow('unknown clip');
    expect(tagsOf('clp_s')).toEqual(['before']);
  });

  it('rejects commas that cannot round-trip through filter URLs', () => {
    expect(() => db.setClipTagsBatch([{ id: 'clp_s', tags: ['lo,fi'] }])).toThrow('commas');
  });

  it('throws for an unknown clip id', () => {
    expect(() => db.setClipTagsBatch([{ id: 'clp_missing', tags: ['x'] }])).toThrow('unknown clip');
  });
});

describe('setClipSources', () => {
  beforeEach(() => {
    db.syncClips([clip('clp_source_a'), clip('clp_source_b'), clip('clp_source_c')]);
    db.setClipSources(['clp_source_a', 'clp_source_b', 'clp_source_c'], null);
  });

  it.each([null, '   '])(
    'persists a single source through catalog rebuilds and clears with %s',
    (source) => {
      expect(db.setClipSources(['clp_source_a'], ' Night of the Living Dead ')).toEqual({
        ids: ['clp_source_a'],
        source: 'Night of the Living Dead',
      });
      db.syncClips([clip('clp_source_a')]);
      expect(sourceOf('clp_source_a')).toBe('Night of the Living Dead');

      expect(db.setClipSources(['clp_source_a'], source)).toEqual({
        ids: ['clp_source_a'],
        source: null,
      });
      expect(sourceOf('clp_source_a')).toBeNull();
    },
  );

  it('sets one source for a deduplicated batch', () => {
    expect(
      db.setClipSources(['clp_source_a', 'clp_source_b', 'clp_source_a'], ' Feature Film '),
    ).toEqual({ ids: ['clp_source_a', 'clp_source_b'], source: 'Feature Film' });
    expect(sourceOf('clp_source_a')).toBe('Feature Film');
    expect(sourceOf('clp_source_b')).toBe('Feature Film');
    expect(sourceOf('clp_source_c')).toBeNull();
  });

  it('validates the full batch before changing any clips', () => {
    expect(() => db.setClipSources(['clp_source_a', 'clp_missing'], 'Feature Film')).toThrow(
      'unknown clip',
    );
    expect(sourceOf('clp_source_a')).toBeNull();
  });

  it('rejects an unavailable clip without changing the rest of the batch', () => {
    db.syncClips([clip('clp_source_a')]);
    const before = catalogRevision();
    expect(() => db.setClipSources(['clp_source_a', 'clp_source_b'], 'Feature Film')).toThrow(
      'unknown clip',
    );
    expect(sourceOf('clp_source_a')).toBeNull();
    expect(catalogRevision()).toBe(before);
  });

  it('keeps tags and sources independent for one-item metadata batches', () => {
    db.setClipTagsBatch([{ id: 'clp_source_a', tags: ['indie'] }]);
    db.setClipSources(['clp_source_a'], 'Feature Film');
    expect(tagsOf('clp_source_a')).toEqual(['indie']);

    db.setClipTagsBatch([{ id: 'clp_source_a', tags: ['bw'] }]);
    expect(sourceOf('clp_source_a')).toBe('Feature Film');
    db.setClipSources(['clp_source_a'], null);
    expect(tagsOf('clp_source_a')).toEqual(['bw']);
  });
});

describe('refreshClips manifest policy', () => {
  const manifestPath = () => join(dataDir, 'clips-cache.json');

  beforeEach(() => {
    rmSync(manifestPath(), { force: true });
    db.syncClips([clip('clp_real')]);
  });

  it('keeps an established catalog when the manifest is absent', () => {
    const refreshResult = db.refreshClips();
    expect(refreshResult.removed).toBe(0);
    expect(db.listTaggableClips().some((clipRecord) => clipRecord.id === 'clp_real')).toBe(true);
  });

  it('rejects a corrupt manifest without changing the catalog', () => {
    writeFileSync(manifestPath(), '{ not json');
    try {
      expect(() => db.refreshClips()).toThrow(SyntaxError);
      expect(db.listTaggableClips().some((clipRecord) => clipRecord.id === 'clp_real')).toBe(true);
    } finally {
      rmSync(manifestPath(), { force: true });
    }
  });

  it('reconciles normally when a valid manifest exists', () => {
    writeFileSync(manifestPath(), JSON.stringify([clip('clp_from_manifest')]));
    try {
      db.refreshClips();
      const ids = db.listTaggableClips().map((clipRecord) => clipRecord.id);
      expect(ids).toContain('clp_from_manifest');
      expect(ids).not.toContain('clp_real');
    } finally {
      rmSync(manifestPath(), { force: true });
    }
  });
});

describe('catalog revision invalidation', () => {
  const expectRevisionChange = (mutate: () => void) => {
    const before = catalogRevision();
    mutate();
    expect(catalogRevision()).not.toBe(before);
  };

  it('tracks vocabulary mutations made through the database API', () => {
    expectRevisionChange(() => void db.addVocabTag('revision-vocab'));
    expectRevisionChange(() => void db.removeVocabTag('revision-vocab'));
  });

  it('tracks clip metadata mutations made through the database API', () => {
    db.syncClips([clip('clp_revision_metadata')]);
    expectRevisionChange(
      () => void db.setClipTagsBatch([{ id: 'clp_revision_metadata', tags: ['revision-tag'] }]),
    );
    expectRevisionChange(
      () => void db.setClipSources(['clp_revision_metadata'], 'Revision Source'),
    );
  });

  it('tracks catalog field changes without additions or removals', () => {
    const original = clip('clp_revision_catalog');
    db.syncClips([original]);

    expectRevisionChange(() => void db.syncClips([{ ...original, title: 'Updated title' }]));
  });
});

describe('removeVocabTag', () => {
  it('removes the tag from the vocabulary and purges it from clips', () => {
    db.syncClips([clip('clp_p')]);
    db.setClipTagsBatch([{ id: 'clp_p', tags: ['purgeme', 'keep'] }]);
    db.addVocabTag('purgeme');
    expect(db.listTagVocabulary()).toContain('purgeme');

    const { affected } = db.removeVocabTag('purgeme');
    expect(affected).toBe(1);
    expect(db.listTagVocabulary()).not.toContain('purgeme');
    expect(tagsOf('clp_p')).toEqual(['keep']);
  });
});
