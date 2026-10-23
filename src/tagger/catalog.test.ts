import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaggableClip } from '../../shared/contract';
import { createEmptyTagsFilter, taggerState } from './taggerState.svelte';

const api = vi.hoisted(() => ({
  fetchClipCatalog: vi.fn(),
  fetchCatalogRevision: vi.fn(),
  fetchTagVocabulary: vi.fn(),
  refreshClipCatalog: vi.fn(),
  saveClipTags: vi.fn(),
  saveClipSources: vi.fn(),
  addTagToVocabulary: vi.fn(),
  deleteTagFromVocabulary: vi.fn(),
}));

vi.mock('./api', () => api);

import { refreshCatalog, synchronizeCatalog } from './actions/catalog';
import { setClipSource, toggleClipTag } from './actions/edits';
import { undoLast } from './actions/history';
import { persistClipTags, persistTagChanges, persistClipSources } from './actions/persistence';
import { addVocabularyTag, deleteVocabularyTag } from './actions/vocab';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('confirm', () => true);
  taggerState.tagVocabulary = ['360', 'bw'];
  taggerState.clips = [];
  taggerState.pendingSaveCount = 0;
  taggerState.localEditRevision = 0;
  taggerState.isRefreshing = false;
  taggerState.catalogRevision = 'rev-1';
  taggerState.loadError = '';
  taggerState.statusMessage = '';
  taggerState.clipFilter = createEmptyTagsFilter();
  taggerState.selectedClipIds.clear();
  taggerState.selectionAnchorClipId = null;
  taggerState.focusedClipId = null;
  taggerState.isReviewingSelection = false;
  taggerState.activeLibraryId = 'visualizer';
  taggerState.activeFolderPath = null;
  taggerState.filenameSearch = '';
  taggerState.undoStack = [];
});

afterEach(() => vi.unstubAllGlobals());

const clip = (): TaggableClip => ({
  id: 'clip-a',
  title: 'a',
  url: '/a.mp4',
  path: 'a.mp4',
  library: 'visualizer',
  tags: ['360'],
  source: null,
});

describe('foreground catalog refresh', () => {
  beforeEach(() => {
    taggerState.clips = [clip()];
    api.refreshClipCatalog.mockResolvedValue({ added: 1, removed: 0, total: 2 });
    api.fetchTagVocabulary.mockResolvedValue(['360', 'bw']);
  });

  it.each(['504 Gateway Timeout', 'Failed to fetch'])(
    'keeps the catalog and resumes polling after %s',
    async (message) => {
      const existingClip = taggerState.clips[0];
      api.refreshClipCatalog.mockRejectedValueOnce(new Error(message));

      await refreshCatalog();

      expect(taggerState.clips).toEqual([existingClip]);
      expect(taggerState.isRefreshing).toBe(false);
      expect(taggerState.statusMessage).toBe('Refresh request failed; scan may still be running');
      expect(api.fetchClipCatalog).not.toHaveBeenCalled();

      const completedCatalog = [clip(), { ...clip(), id: 'new-clip' }];
      api.fetchCatalogRevision.mockResolvedValue('rev-2');
      api.fetchClipCatalog.mockResolvedValue({ clips: completedCatalog, revision: 'rev-2' });

      await synchronizeCatalog();

      expect(taggerState.clips).toEqual(completedCatalog);
      expect(taggerState.catalogRevision).toBe('rev-2');
      expect(api.refreshClipCatalog).toHaveBeenCalledOnce();
    },
  );

  it.each(['tags', 'source', 'vocabulary'] as const)(
    'leaves a snapshot overtaken by a completed %s save for the next poll',
    async (edit) => {
      const staleCatalog = deferred<{ clips: TaggableClip[]; revision: string }>();
      api.fetchClipCatalog.mockReturnValueOnce(staleCatalog.promise);
      const refreshing = refreshCatalog();
      await Promise.resolve();
      expect(api.fetchClipCatalog).toHaveBeenCalledOnce();

      const localClip = taggerState.clips[0];
      if (edit === 'tags') {
        api.saveClipTags.mockResolvedValue(undefined);
        await toggleClipTag(localClip, 'bw');
      } else if (edit === 'source') {
        api.saveClipSources.mockResolvedValue({ ids: [localClip.id], source: 'Saved source' });
        await setClipSource(localClip, 'Saved source');
      } else {
        api.deleteTagFromVocabulary.mockResolvedValue({ vocab: ['bw'], affected: 1 });
        await deleteVocabularyTag('360', 1);
      }
      const savedClip = { ...localClip, tags: [...localClip.tags] };
      const savedVocabulary = [...taggerState.tagVocabulary];
      api.fetchTagVocabulary.mockResolvedValue(savedVocabulary);
      staleCatalog.resolve({ clips: [clip()], revision: 'stale' });
      await refreshing;

      expect(taggerState.clips[0]).toBe(localClip);
      expect(taggerState.clips[0]).toEqual(savedClip);
      expect(taggerState.tagVocabulary).toEqual(savedVocabulary);
      expect(taggerState.catalogRevision).toBe('');
      expect(taggerState.isRefreshing).toBe(false);
      expect(api.fetchClipCatalog).toHaveBeenCalledOnce();

      api.fetchCatalogRevision.mockResolvedValue('fresh');
      api.fetchClipCatalog.mockResolvedValue({
        clips: [savedClip, { ...clip(), id: 'new-clip' }],
        revision: 'fresh',
      });
      await synchronizeCatalog();

      expect(taggerState.clips[0]).toEqual(savedClip);
      expect(taggerState.clips).toHaveLength(2);
      expect(taggerState.tagVocabulary).toEqual(savedVocabulary);
      expect(taggerState.catalogRevision).toBe('fresh');
      expect(taggerState.isRefreshing).toBe(false);
      expect(api.refreshClipCatalog).toHaveBeenCalledOnce();
      expect(taggerState.undoStack).toHaveLength(edit === 'vocabulary' ? 0 : 1);
    },
  );

  it.each(['before refresh', 'during the catalog read'])(
    'defers reconciliation while a source save started %s is pending',
    async (started) => {
      const catalog = deferred<{ clips: TaggableClip[]; revision: string }>();
      const save = deferred<{ ids: string[]; source: string }>();
      const localClip = taggerState.clips[0];
      api.saveClipSources.mockReturnValue(save.promise);
      api.fetchClipCatalog.mockReturnValue(catalog.promise);
      let saving =
        started === 'before refresh' ? setClipSource(localClip, 'Saved source') : undefined;
      const refreshing = refreshCatalog();
      await Promise.resolve();
      if (started !== 'before refresh') saving = setClipSource(localClip, 'Saved source');
      catalog.resolve({ clips: [clip()], revision: 'rev-1' });
      await refreshing;

      expect(taggerState.clips[0]).toBe(localClip);
      expect(taggerState.catalogRevision).toBe('');
      expect(taggerState.isRefreshing).toBe(false);
      expect(taggerState.pendingSaveCount).toBe(1);
      await synchronizeCatalog();
      expect(api.fetchCatalogRevision).not.toHaveBeenCalled();

      save.resolve({ ids: [localClip.id], source: 'Saved source' });
      await saving;
      api.fetchCatalogRevision.mockResolvedValue('rev-1');
      api.fetchClipCatalog.mockResolvedValue({
        clips: [{ ...localClip, tags: [...localClip.tags] }],
        revision: 'rev-1',
      });
      await synchronizeCatalog();

      expect(taggerState.clips[0].source).toBe('Saved source');
      expect(taggerState.catalogRevision).toBe('rev-1');
      expect(taggerState.undoStack).toHaveLength(1);
    },
  );
});

describe('catalog changes and undo history', () => {
  beforeEach(async () => {
    taggerState.clips = [clip()];
    api.saveClipTags.mockResolvedValue(undefined);
    await toggleClipTag(taggerState.clips[0], 'bw');
    api.fetchCatalogRevision.mockResolvedValue('rev-2');
    api.fetchTagVocabulary.mockResolvedValue(['360', 'bw']);
    api.refreshClipCatalog.mockResolvedValue({ added: 0, removed: 0, total: 1 });
  });

  it.each([
    { name: 'background sync', reconcile: synchronizeCatalog },
    { name: 'foreground refresh', reconcile: refreshCatalog },
  ])('keeps undo through an own-save revision change in $name', async ({ reconcile }) => {
    api.fetchClipCatalog.mockResolvedValue({
      clips: [{ ...clip(), tags: ['bw', '360'] }],
      revision: 'rev-2',
    });
    api.fetchTagVocabulary.mockResolvedValue(['bw', '360']);

    await reconcile();
    expect(taggerState.undoStack).toHaveLength(1);
    await undoLast();
    expect(api.saveClipTags).toHaveBeenLastCalledWith([{ id: 'clip-a', tags: ['360'] }]);
  });

  describe.each([
    { name: 'background sync', reconcile: synchronizeCatalog },
    { name: 'foreground refresh', reconcile: refreshCatalog },
  ])('$name', ({ reconcile }) => {
    it.each(['tags', 'source', 'vocabulary', 'removed clip'])(
      'invalidates undo after external %s changes',
      async (change) => {
        const serverClip = { ...clip(), tags: ['360', 'bw'] };
        if (change === 'tags') serverClip.tags.push('indie');
        if (change === 'source') serverClip.source = 'External source';
        if (change === 'vocabulary')
          api.fetchTagVocabulary.mockResolvedValue(['360', 'bw', 'indie']);
        api.fetchClipCatalog.mockResolvedValue({
          clips: change === 'removed clip' ? [] : [serverClip],
          revision: 'rev-2',
        });

        await reconcile();
        expect(taggerState.undoStack).toHaveLength(0);
        await undoLast();
        expect(api.saveClipTags).toHaveBeenCalledOnce();
      },
    );
  });

  it('invalidates snapshots containing a locally deleted tag even when no clip uses it now', async () => {
    await toggleClipTag(taggerState.clips[0], '360');
    api.deleteTagFromVocabulary.mockResolvedValue({ vocab: ['bw'], affected: 0 });

    await deleteVocabularyTag('360', 0);
    await undoLast();

    expect(taggerState.undoStack).toHaveLength(0);
    expect(api.saveClipTags).toHaveBeenCalledTimes(2);
    expect(taggerState.clips[0].tags).toEqual(['bw']);
  });

  it('keeps history when vocabulary deletion fails', async () => {
    api.deleteTagFromVocabulary.mockRejectedValue(new Error('offline'));
    await deleteVocabularyTag('360', 1);
    expect(taggerState.undoStack).toHaveLength(1);
  });

  it('does not recreate stale undo when a tag-save response arrives after vocabulary deletion', async () => {
    const deletion = deferred<{ vocab: string[]; affected: number }>();
    const save = deferred<void>();
    api.deleteTagFromVocabulary.mockReturnValue(deletion.promise);
    api.saveClipTags.mockReturnValueOnce(save.promise);
    const deleting = deleteVocabularyTag('360', 1);
    const editing = toggleClipTag(taggerState.clips[0], 'bw');
    deletion.resolve({ vocab: ['bw'], affected: 1 });
    await deleting;
    save.resolve();
    await editing;

    expect(taggerState.undoStack).toHaveLength(0);
    await undoLast();
    expect(taggerState.clips[0].tags).toEqual([]);
    expect(api.saveClipTags).toHaveBeenCalledTimes(2);
  });

  it('prunes selected clips hidden by reconciled metadata', async () => {
    taggerState.clipFilter = createEmptyTagsFilter();
    taggerState.clipFilter.includeTags.add('bw');
    taggerState.selectedClipIds.add('clip-a');
    taggerState.selectionAnchorClipId = 'clip-a';
    api.fetchClipCatalog.mockResolvedValue({ clips: [clip()], revision: 'rev-2' });

    await synchronizeCatalog();

    expect(taggerState.selectedClipIds.size).toBe(0);
    expect(taggerState.selectionAnchorClipId).toBeNull();
  });
});

describe('tagger catalog synchronization', () => {
  it('coalesces overlapping polls', async () => {
    const response = deferred<string>();
    api.fetchCatalogRevision.mockReturnValue(response.promise);
    const first = synchronizeCatalog();
    const second = synchronizeCatalog();
    expect(api.fetchCatalogRevision).toHaveBeenCalledTimes(1);
    response.resolve('rev-1');
    await Promise.all([first, second]);
    expect(api.fetchClipCatalog).not.toHaveBeenCalled();
  });

  it('fetches the full catalog only when the revision changes', async () => {
    api.fetchCatalogRevision.mockResolvedValue('rev-2');
    api.fetchClipCatalog.mockResolvedValue({ clips: [], revision: 'rev-2' });
    api.fetchTagVocabulary.mockResolvedValue(['360', 'bw']);

    await synchronizeCatalog();

    expect(api.fetchClipCatalog).toHaveBeenCalledTimes(1);
    expect(taggerState.catalogRevision).toBe('rev-2');
  });

  it('clears an initial load error after synchronization recovers', async () => {
    taggerState.loadError = 'Could not load tags/clips from /api/tags.';
    taggerState.statusMessage = 'Load failed';
    api.fetchCatalogRevision.mockResolvedValue('rev-2');
    api.fetchClipCatalog.mockResolvedValue({ clips: [], revision: 'rev-2' });
    api.fetchTagVocabulary.mockResolvedValue(['360', 'bw']);

    await synchronizeCatalog();

    expect(taggerState.loadError).toBe('');
    expect(taggerState.statusMessage).toBe('');
  });

  it('synchronizes vocabulary changes from another browser and prunes stale filters', async () => {
    const filter = createEmptyTagsFilter();
    filter.includeTags.add('360');
    filter.excludeTags.add('bw');
    taggerState.clipFilter = filter;
    api.fetchCatalogRevision.mockResolvedValue('rev-2');
    api.fetchClipCatalog.mockResolvedValue({ clips: [], revision: 'rev-2' });
    api.fetchTagVocabulary.mockResolvedValue(['bw', 'indie']);

    await synchronizeCatalog();

    expect(taggerState.tagVocabulary).toEqual(['bw', 'indie']);
    expect([...filter.includeTags]).toEqual([]);
    expect([...filter.excludeTags]).toEqual(['bw']);
  });

  it('reconciles rejected optimistic tags when the server revision is unchanged', async () => {
    const clip: TaggableClip = {
      id: 'clip-a',
      title: 'a',
      url: '/a.mp4',
      path: 'a.mp4',
      library: 'visualizer',
      tags: ['server-tag', 'local-tag'],
      source: null,
    };
    taggerState.clips = [clip];
    api.saveClipTags.mockRejectedValue(new Error('rejected'));
    api.fetchCatalogRevision.mockResolvedValue('rev-1');
    api.fetchClipCatalog.mockResolvedValue({
      clips: [{ ...clip, tags: ['server-tag'] }],
      revision: 'rev-1',
    });
    api.fetchTagVocabulary.mockResolvedValue(['360', 'bw']);

    expect(await persistClipTags(clip)).toBe(false);
    expect(clip.tags).toEqual(['server-tag', 'local-tag']);

    await synchronizeCatalog();

    expect(api.fetchClipCatalog).toHaveBeenCalledTimes(1);
    expect(api.fetchTagVocabulary).toHaveBeenCalledTimes(1);
    expect(taggerState.clips[0].tags).toEqual(['server-tag']);
    expect(taggerState.catalogRevision).toBe('rev-1');
  });

  describe.each(['revision', 'catalog'] as const)('during the %s request', (pendingRequest) => {
    it.each([
      {
        name: 'a single tag save',
        edit: (clip: TaggableClip) => {
          clip.tags.push('bw');
          return persistClipTags(clip);
        },
      },
      {
        name: 'a bulk tag save',
        edit: (clip: TaggableClip) => {
          clip.tags.push('bw');
          return persistTagChanges([clip], 'Tagged 1');
        },
      },
      {
        name: 'a preview source save',
        edit: (clip: TaggableClip) => setClipSource(clip, 'Saved source'),
      },
      {
        name: 'a bulk source save',
        edit: (clip: TaggableClip) => persistClipSources([clip], 'Saved source'),
      },
      { name: 'adding a vocabulary tag', edit: () => addVocabularyTag('indie') },
      { name: 'deleting a vocabulary tag', edit: () => deleteVocabularyTag('360', 1) },
    ])('discards a stale response after $name finishes', async ({ edit }) => {
      const staleClip: TaggableClip = {
        id: 'clip-a',
        title: 'a',
        url: '/a.mp4',
        path: 'a.mp4',
        library: 'visualizer',
        tags: ['360'],
        source: null,
      };
      taggerState.clips = [{ ...staleClip, tags: [...staleClip.tags] }];
      const clip = taggerState.clips[0];
      const revision = deferred<string>();
      const catalog = deferred<{ clips: TaggableClip[]; revision: string }>();
      api.fetchCatalogRevision.mockReturnValue(
        pendingRequest === 'revision' ? revision.promise : Promise.resolve('rev-2'),
      );
      api.fetchClipCatalog.mockReturnValue(catalog.promise);
      api.fetchTagVocabulary.mockResolvedValue(['360', 'bw']);
      api.saveClipTags.mockResolvedValue(undefined);
      api.saveClipSources.mockResolvedValue({ ids: [clip.id], source: 'Saved source' });
      api.addTagToVocabulary.mockResolvedValue({ vocab: ['360', 'bw', 'indie'] });
      api.deleteTagFromVocabulary.mockResolvedValue({ vocab: ['bw'], affected: 1 });

      const syncing = synchronizeCatalog();
      await Promise.resolve();
      expect(api.fetchClipCatalog).toHaveBeenCalledTimes(pendingRequest === 'catalog' ? 1 : 0);

      await edit(clip);
      expect(taggerState.pendingSaveCount).toBe(0);
      const savedVocabulary = [...taggerState.tagVocabulary];
      revision.resolve('rev-2');
      catalog.resolve({ clips: [staleClip], revision: 'rev-2' });
      await syncing;

      expect(taggerState.clips[0]).toBe(clip);
      expect(taggerState.tagVocabulary).toEqual(savedVocabulary);
      expect(taggerState.catalogRevision).toBe('rev-1');
      expect(api.fetchClipCatalog).toHaveBeenCalledTimes(pendingRequest === 'catalog' ? 1 : 0);

      api.fetchCatalogRevision.mockResolvedValue('rev-3');
      api.fetchClipCatalog.mockResolvedValue({ clips: [clip], revision: 'rev-3' });
      api.fetchTagVocabulary.mockResolvedValue(savedVocabulary);
      await synchronizeCatalog();
      expect(taggerState.catalogRevision).toBe('rev-3');
    });
  });
});
