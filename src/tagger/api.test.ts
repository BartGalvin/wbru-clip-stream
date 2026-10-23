import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../shared/routes';
import { fetchTagVocabulary, saveClipSources, saveClipTags } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tagger API', () => {
  it('reads a GET response with Response.json()', async () => {
    const responseJson = vi.fn().mockResolvedValue(['indie']);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: responseJson,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTagVocabulary()).resolves.toEqual(['indie']);

    expect(fetchMock).toHaveBeenCalledWith(routes.tagsVocab);
    expect(responseJson).toHaveBeenCalledOnce();
  });

  it('posts a clip tag batch as JSON', async () => {
    const clips = [{ id: 'folder/clip-a', tags: ['indie'] }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveClipTags(clips)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(routes.tagsClips, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips }),
    });
  });

  it.each([
    { ids: ['folder/clip-a'], source: 'Feature Film' },
    { ids: ['folder/clip-a', 'clip-b'], source: null },
  ])('posts source updates as one batch: %j', async (update) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(update)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveClipSources(update.ids, update.source)).resolves.toEqual(update);

    expect(fetchMock).toHaveBeenCalledWith(routes.tagsClipSource, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
  });

  it.each([400, 404, 500])('preserves source error details for HTTP %s', async (status) => {
    const error = JSON.stringify({ error: 'source save failed' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(error, { status })));

    await expect(saveClipSources(['clip-a'], 'Feature Film')).rejects.toThrow(error);
  });
});
