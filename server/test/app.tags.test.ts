import { describe, expect, it } from 'vitest';
import { useHttpApp } from './httpFixture';

const http = useHttpApp();

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
