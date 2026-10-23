import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaggableClip } from '../../shared/contract';
import { taggerState } from './taggerState.svelte';

const api = vi.hoisted(() => ({
  saveClipTags: vi.fn(),
  saveClipSources: vi.fn(),
}));

vi.mock('./api', () => api);

import { persistClipSources, persistClipTags, persistTagChanges } from './actions/persistence';
import { setSourceForSelection, toggleClipTag } from './actions/edits';
import { undoLast } from './actions/history';
import { createEmptyTagsFilter } from './taggerState.svelte';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

const createClip = (id = 'clip-a', tags: string[] = []): TaggableClip => ({
  id,
  title: id,
  url: `/${id}.mp4`,
  path: `${id}.mp4`,
  library: 'visualizer',
  tags,
  source: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  taggerState.tagVocabulary = [];
  taggerState.clips = [];
  taggerState.pendingSaveCount = 0;
  taggerState.localEditRevision = 0;
  taggerState.catalogRevision = 'rev-1';
  taggerState.undoStack = [];
  taggerState.statusMessage = '';
  taggerState.selectedClipIds.clear();
  taggerState.isReviewingSelection = false;
  taggerState.activeLibraryId = 'visualizer';
  taggerState.activeFolderPath = null;
  taggerState.filenameSearch = '';
  taggerState.clipFilter = createEmptyTagsFilter();
});

describe('tagger persistence', () => {
  it.each([true, false])(
    'reports a partial source undo failure and keeps it retryable when failure finishes first: %s',
    async (failureFirst) => {
      taggerState.clips = ['a', 'b'].map((id) => ({
        id,
        title: id,
        url: `/${id}.mp4`,
        path: `${id}.mp4`,
        library: 'visualizer',
        tags: [],
        source: `Source ${id}`,
      }));
      taggerState.selectedClipIds.add('a').add('b');
      api.saveClipSources.mockResolvedValue({ ids: ['a', 'b'], source: 'Shared source' });
      await setSourceForSelection('Shared source');
      const history = taggerState.undoStack[0];

      const success = deferred<{ ids: string[]; source: string }>();
      const failure = deferred<void>();
      api.saveClipSources.mockImplementation((ids: string[]) =>
        ids[0] === 'a'
          ? failure.promise.then(() => {
              throw new Error('offline');
            })
          : success.promise,
      );
      const undoing = undoLast();
      expect(taggerState.pendingSaveCount).toBe(2);
      if (failureFirst) failure.resolve();
      else success.resolve({ ids: ['b'], source: 'Source b' });
      await vi.waitFor(() => expect(taggerState.pendingSaveCount).toBe(1));
      if (failureFirst) success.resolve({ ids: ['b'], source: 'Source b' });
      else failure.resolve();
      await undoing;

      expect(taggerState.statusMessage).toContain('Undo incomplete');
      expect(taggerState.statusMessage).not.toContain('✓');
      expect(taggerState.clips.map(({ source }) => source)).toEqual(['Shared source', 'Source b']);
      expect(taggerState.undoStack).toHaveLength(1);
      expect(taggerState.undoStack[0]).toBe(history);

      api.saveClipSources.mockImplementation(async (ids: string[], source: string) => ({
        ids,
        source,
      }));
      await undoLast();

      expect(taggerState.clips.map(({ source }) => source)).toEqual(['Source a', 'Source b']);
      expect(taggerState.undoStack).toHaveLength(0);
      expect(taggerState.statusMessage).toContain('Undid');
      expect(taggerState.pendingSaveCount).toBe(0);
    },
  );

  it.each(['single', 'selection'])(
    'serializes a following %s tag save in operator order',
    async (kind) => {
      const first = deferred<void>();
      const second = deferred<void>();
      api.saveClipTags.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const clip = createClip('clip-a', ['a']);

      const firstSave = persistClipTags(clip);
      expect(taggerState.statusMessage).toBe('Saving…');
      clip.tags.push('b');
      const secondSave =
        kind === 'single' ? persistClipTags(clip) : persistTagChanges([clip], 'Tagged 1');
      const savingMessage = kind === 'single' ? 'Saving…' : 'Saving 1…';
      expect(taggerState.pendingSaveCount).toBe(2);
      expect(taggerState.localEditRevision).toBe(2);
      expect(taggerState.statusMessage).toBe(savingMessage);
      await Promise.resolve();
      expect(api.saveClipTags).toHaveBeenCalledTimes(1);

      first.resolve();
      expect(await firstSave).toBe(true);
      expect(clip.tags).toEqual(['a', 'b']);
      expect(taggerState.pendingSaveCount).toBe(1);
      expect(taggerState.statusMessage).toBe(savingMessage);
      second.resolve();
      expect(await secondSave).toBe(true);
      expect(api.saveClipTags).toHaveBeenCalledTimes(2);
      expect(api.saveClipTags).toHaveBeenNthCalledWith(1, [{ id: 'clip-a', tags: ['a'] }]);
      expect(api.saveClipTags).toHaveBeenNthCalledWith(2, [{ id: 'clip-a', tags: ['a', 'b'] }]);
      expect(clip.tags).toEqual(['a', 'b']);
      expect(taggerState.pendingSaveCount).toBe(0);
      expect(taggerState.catalogRevision).toBe('rev-1');
      expect(taggerState.statusMessage).toBe(kind === 'single' ? 'Saved ✓' : 'Tagged 1 ✓');
    },
  );

  it.each([
    ['single', 'single'],
    ['single', 'selection'],
    ['selection', 'single'],
    ['selection', 'selection'],
  ])(
    'keeps a failed %s tag save visible after a successful %s save',
    async (failedKind, successfulKind) => {
      const first = deferred<void>();
      api.saveClipTags
        .mockImplementationOnce(() =>
          first.promise.then(() => {
            throw new Error('offline');
          }),
        )
        .mockResolvedValueOnce(undefined);
      const clip = createClip('clip-a', ['a']);

      const failedSave =
        failedKind === 'single' ? persistClipTags(clip) : persistTagChanges([clip], 'Tagged 1');
      clip.tags.push('b');
      const successfulSave =
        successfulKind === 'single' ? persistClipTags(clip) : persistTagChanges([clip], 'Tagged 1');
      first.resolve();

      expect(await failedSave).toBe(false);
      expect(await successfulSave).toBe(true);
      expect(api.saveClipTags).toHaveBeenNthCalledWith(1, [{ id: 'clip-a', tags: ['a'] }]);
      expect(api.saveClipTags).toHaveBeenNthCalledWith(2, [{ id: 'clip-a', tags: ['a', 'b'] }]);
      expect(clip.tags).toEqual(['a', 'b']);
      expect(taggerState.catalogRevision).toBe('');
      expect(taggerState.pendingSaveCount).toBe(0);
      expect(taggerState.localEditRevision).toBe(2);
      expect(taggerState.statusMessage).toBe('Save failed — offline');
    },
  );

  it('keeps rejected tag undo optimistic and retryable', async () => {
    taggerState.tagVocabulary = ['a', 'b'];
    taggerState.clips = [createClip('clip-a', ['a'])];
    const clip = taggerState.clips[0];
    api.saveClipTags.mockResolvedValue(undefined);
    await toggleClipTag(clip, 'b');
    const history = taggerState.undoStack[0];
    expect(taggerState.undoStack).toHaveLength(1);

    api.saveClipTags.mockRejectedValueOnce(new Error('offline'));
    const undoing = undoLast();
    expect(clip.tags).toEqual(['a']);
    expect(taggerState.pendingSaveCount).toBe(1);
    await undoing;

    expect(taggerState.undoStack).toHaveLength(1);
    expect(taggerState.undoStack[0]).toBe(history);
    expect(taggerState.catalogRevision).toBe('');
    expect(taggerState.pendingSaveCount).toBe(0);
    expect(taggerState.statusMessage).toBe('Save failed — offline');

    await undoLast();

    expect(api.saveClipTags).toHaveBeenLastCalledWith([{ id: clip.id, tags: ['a'] }]);
    expect(clip.tags).toEqual(['a']);
    expect(taggerState.undoStack).toHaveLength(0);
    expect(taggerState.pendingSaveCount).toBe(0);
    expect(taggerState.localEditRevision).toBe(3);
  });

  it('saves a selection in one tag request', async () => {
    const firstClip = createClip('clip-a', ['indie']);
    const secondClip = createClip('clip-b', ['360']);
    api.saveClipTags.mockResolvedValue(undefined);

    const saving = persistTagChanges([firstClip, secondClip], 'Tagged 2');
    expect(taggerState.statusMessage).toBe('Saving 2…');
    expect(taggerState.localEditRevision).toBe(1);
    expect(taggerState.pendingSaveCount).toBe(1);
    await expect(saving).resolves.toBe(true);
    expect(taggerState.pendingSaveCount).toBe(0);
    expect(taggerState.statusMessage).toBe('Tagged 2 ✓');
    expect(api.saveClipTags).toHaveBeenCalledOnce();
    expect(api.saveClipTags).toHaveBeenCalledWith([
      { id: 'clip-a', tags: ['indie'] },
      { id: 'clip-b', tags: ['360'] },
    ]);
  });

  it.each([null, '   '])('saves a clip source and clears it with %s', async (emptySource) => {
    const clip = createClip();
    api.saveClipSources
      .mockResolvedValueOnce({ ids: [clip.id], source: 'Night of the Living Dead' })
      .mockResolvedValueOnce({ ids: [clip.id], source: null });

    const saving = persistClipSources([clip], ' Night of the Living Dead ');
    expect(clip.source).toBeNull();
    expect(taggerState.pendingSaveCount).toBe(1);
    expect(taggerState.localEditRevision).toBe(1);
    expect(taggerState.statusMessage).toBe('Saving 1…');
    expect(await saving).toBe(true);
    expect(api.saveClipSources).toHaveBeenLastCalledWith([clip.id], 'Night of the Living Dead');
    expect(clip.source).toBe('Night of the Living Dead');
    expect(taggerState.statusMessage).toBe('Set source for 1 ✓');

    expect(await persistClipSources([clip], emptySource)).toBe(true);
    expect(api.saveClipSources).toHaveBeenLastCalledWith([clip.id], null);
    expect(clip.source).toBeNull();
    expect(taggerState.pendingSaveCount).toBe(0);
    expect(taggerState.localEditRevision).toBe(2);
    expect(taggerState.catalogRevision).toBe('rev-1');
    expect(taggerState.statusMessage).toBe('Cleared source for 1 ✓');
  });

  it('keeps a single source unchanged on failure without invalidating the catalog', async () => {
    const clip = { ...createClip(), source: 'Old source' };
    api.saveClipSources.mockRejectedValue('offline');

    expect(await persistClipSources([clip], 'New source')).toBe(false);
    expect(clip.source).toBe('Old source');
    expect(taggerState.pendingSaveCount).toBe(0);
    expect(taggerState.localEditRevision).toBe(1);
    expect(taggerState.catalogRevision).toBe('rev-1');
    expect(taggerState.statusMessage).toBe('Save failed — offline');
  });

  it.each(['Accepted source', null])(
    'applies only server-accepted source IDs and values: %s',
    async (source) => {
      const clips = [createClip(), { ...createClip('clip-b'), source: 'Old source' }];
      api.saveClipSources.mockResolvedValue({ ids: ['clip-a', 'unknown'], source });

      expect(await persistClipSources(clips, 'Requested source')).toBe(true);
      expect(clips.map((clip) => clip.source)).toEqual([source, 'Old source']);
      expect(taggerState.statusMessage).toBe(`${source ? 'Set source' : 'Cleared source'} for 2 ✓`);
      expect(taggerState.pendingSaveCount).toBe(0);
      expect(taggerState.localEditRevision).toBe(1);
      expect(taggerState.catalogRevision).toBe('rev-1');
    },
  );

  it.each([true, false])('commits bulk sources only on success: %s', async (succeeds) => {
    const clips: TaggableClip[] = [createClip(), { ...createClip('clip-b'), source: 'Old source' }];
    taggerState.clips = clips;
    if (succeeds) {
      api.saveClipSources.mockResolvedValue({
        ids: ['clip-a', 'clip-b'],
        source: 'Night of the Living Dead',
      });
    } else {
      api.saveClipSources.mockRejectedValue(new Error('offline'));
    }

    const saving = persistClipSources(clips, ' Night of the Living Dead ');
    expect(clips.map((clip) => clip.source)).toEqual([null, 'Old source']);
    expect(taggerState.pendingSaveCount).toBe(1);
    expect(taggerState.localEditRevision).toBe(1);
    expect(taggerState.statusMessage).toBe('Saving 2…');
    expect(await saving).toBe(succeeds);
    expect(taggerState.pendingSaveCount).toBe(0);
    expect(taggerState.catalogRevision).toBe('rev-1');
    expect(taggerState.statusMessage).toBe(
      succeeds ? 'Set source for 2 ✓' : 'Save failed — offline',
    );
    expect(api.saveClipSources).toHaveBeenCalledWith(
      ['clip-a', 'clip-b'],
      'Night of the Living Dead',
    );
    expect(clips.map((clip) => clip.source)).toEqual(
      succeeds ? ['Night of the Living Dead', 'Night of the Living Dead'] : [null, 'Old source'],
    );
  });
});
