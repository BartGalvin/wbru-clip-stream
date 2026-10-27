import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../src/db/connection';
import { useHttpApp } from './httpFixture';

const http = useHttpApp();

describe('GET /api/tags/thumbnails', () => {
  it('serves cached images with browser caching and conditional requests', async () => {
    const directory = join(getDataDir(), 'thumbnails');
    mkdirSync(directory, { recursive: true });
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    writeFileSync(join(directory, 'clp_bw.jpg'), image);

    const response = await http.request('/api/tags/thumbnails/clp_bw.jpg');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);

    const cached = await http.request('/api/tags/thumbnails/clp_bw.jpg', {
      cache: 'no-cache',
      headers: { 'If-None-Match': response.headers.get('etag')! },
    });
    expect(cached.status).toBe(304);
  });

  it('returns 404 for an image not yet generated', async () => {
    expect((await http.request('/api/tags/thumbnails/clp_missing.jpg')).status).toBe(404);
  });
});

describe('POST /api/tags/vocab validation', () => {
  it('rejects tags containing commas', async () => {
    const response = await http.request('/api/tags/vocab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'lo,fi' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('tagger catalog revision', () => {
  it('serves a small revision token and advances it after a tag write', async () => {
    const beforeResponse = await http.request('/api/tags/revision');
    expect(beforeResponse.status).toBe(200);
    const before = (await beforeResponse.json()) as { revision: string };
    expect(before.revision).toBeTruthy();

    const clipsResponse = await http.request('/api/tags/clips');
    expect(clipsResponse.status).toBe(200);
    expect(clipsResponse.headers.get('x-catalog-revision')).toBe(before.revision);

    const save = await http.request('/api/tags/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clips: [{ id: 'clp_bw', tags: ['black and white', 'revision test'] }],
      }),
    });
    expect(save.status).toBe(204);

    const after = (await http
      .request('/api/tags/revision')
      .then((response) => response.json())) as {
      revision: string;
    };
    expect(after.revision).not.toBe(before.revision);

    await http.request('/api/tags/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: [{ id: 'clp_bw', tags: ['black and white'] }] }),
    });
  });
});

describe('POST /api/tags/clip-source', () => {
  const saveSources = (body: unknown) =>
    http.request('/api/tags/clip-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it.each([
    { ids: ['clp_bw'], clear: null },
    { ids: ['clp_bw', 'clp_in', 'clp_bw'], clear: '   ' },
  ])('sets and clears sources for %j', async ({ ids, clear }) => {
    const before = http.database.listTaggableClips();
    const uniqueIds = [...new Set(ids)];
    const assigned = await saveSources({ ids, source: ' Night of the Living Dead ' });
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toEqual({
      ids: uniqueIds,
      source: 'Night of the Living Dead',
    });
    expect(http.database.listTaggableClips()).toEqual(
      before.map((clip) =>
        ids.includes(clip.id) ? { ...clip, source: 'Night of the Living Dead' } : clip,
      ),
    );

    const cleared = await saveSources({ ids, source: clear });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ids: uniqueIds, source: null });
    expect(http.database.listTaggableClips()).toEqual(before);
  });

  it.each([
    { source: 'Feature Film' },
    { ids: 'clp_bw', source: null },
    { ids: ['clp_bw', ''], source: null },
    { ids: ['clp_bw', 42], source: null },
    { ids: ['clp_bw'] },
    { ids: ['clp_bw'], source: 42 },
  ])('rejects invalid source updates without changing the catalog: %j', async (body) => {
    const before = http.database.listTaggableClips();
    const response = await saveSources(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'body must be { ids: string[], source: string | null }',
    });
    expect(http.database.listTaggableClips()).toEqual(before);
  });

  it.each([{ ids: ['clp_missing'] }, { ids: ['clp_bw', 'clp_missing'] }])(
    'rejects unknown clips atomically: %j',
    async ({ ids }) => {
      const before = http.database.listTaggableClips();
      const response = await saveSources({ ids, source: 'Feature Film' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'unknown clip id: clp_missing' });
      expect(http.database.listTaggableClips()).toEqual(before);
    },
  );

  it('does not expose a separate single-clip source route', async () => {
    const response = await http.request('/api/tags/clip-source/clp_bw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'Feature Film' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/tags/clips/:id/tags', () => {
  const patchTag = (id: string, body: unknown) =>
    http.request(`/api/tags/clips/${id}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('adds and removes inactive while preserving other tags, sources, and history', async () => {
    const original = http.database.listTaggableClips().find((clip) => clip.id === 'clp_kbin')!;
    http.database.setClipSources([original.id], 'Live session');
    http.database.recordPlayout('inactive-edit', 'indie', original.id, 'inactive-edit-1');
    http.database.recordPlayout('inactive-edit', 'indie', original.id, 'inactive-edit-2');

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await patchTag(original.id, { tag: 'inactive', enabled: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: original.id,
        tags: [...original.tags, 'inactive'],
      });
    }
    expect(http.database.listTaggableClips().find((clip) => clip.id === original.id)).toMatchObject(
      {
        tags: [...original.tags, 'inactive'],
        source: 'Live session',
      },
    );
    const history = (await http
      .request('/api/tags/playout?output=inactive-edit')
      .then((response) => response.json())) as { inactive: boolean }[];
    expect(history).toHaveLength(2);
    expect(history.every((event) => event.inactive === true)).toBe(true);

    const restored = await patchTag(original.id, { tag: 'inactive', enabled: false });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ id: original.id, tags: original.tags });
    expect(
      http.database
        .getRecentPlayouts({ outputId: 'inactive-edit' })
        .every((event) => event.inactive === false),
    ).toBe(true);
    http.database.setClipSources([original.id], original.source);
  });

  it.each([
    { tag: '', enabled: true },
    { tag: 'inactive' },
    { tag: 'inactive', enabled: 'true' },
    { tag: 'bad,tag', enabled: true },
  ])('rejects invalid single-tag edits without changing metadata: %j', async (body) => {
    const before = http.database.listTaggableClips();
    expect((await patchTag('clp_in', body)).status).toBe(400);
    expect(http.database.listTaggableClips()).toEqual(before);
  });

  it('rejects an unknown clip without changing the catalog', async () => {
    const before = http.database.listTaggableClips();
    expect((await patchTag('clp_missing', { tag: 'inactive', enabled: true })).status).toBe(404);
    expect(http.database.listTaggableClips()).toEqual(before);
  });
});

describe('POST /api/tags/clips validation', () => {
  const saveTags = (clips: { id: string; tags: string[] }[]) =>
    http.request('/api/tags/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips }),
    });

  it('rejects tag names containing commas', async () => {
    const response = await saveTags([{ id: 'clp_bw', tags: ['lo,fi'] }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'tag names cannot contain commas' });
  });

  it('rejects an unknown clip without changing earlier entries', async () => {
    const response = await saveTags([
      { id: 'clp_bw', tags: ['changed'] },
      { id: 'clp_missing', tags: ['indie'] },
    ]);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unknown clip id: clp_missing' });
    expect(http.database.listTaggableClips().find((clip) => clip.id === 'clp_bw')?.tags).toEqual([
      'black and white',
    ]);
  });
});
