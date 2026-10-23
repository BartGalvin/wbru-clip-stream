import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAvailableClipSources,
  createEmptyTagsFilter,
  taggerState,
  getVisibleClips,
  getLibraryFolders,
} from './taggerState.svelte';
import {
  clearClipSelection,
  clearSelectedClips,
  endSelectionReview,
  focusClip,
  selectAllVisibleClips,
  toggleClipSelection,
} from './actions/selection';
import {
  clearTagFilter,
  cycleTagFilter,
  selectLibrary,
  selectFolder,
  setOnlyUntagged,
  setFilenameSearch,
  toggleTagMatchMode,
} from './actions/filters';
import {
  applyTagToSelection,
  setSourceForSelection,
  setClipSource,
  toggleClipTag,
} from './actions/edits';
import { undoLast } from './actions/history';
import { persistClipSources, persistTagChanges } from './actions/persistence';
import type { TaggableClip } from '../../shared/contract';

vi.mock('./actions/persistence', () => ({
  persistClipTags: vi.fn(async () => true),
  persistTagChanges: vi.fn(async () => true),
  persistClipSources: vi.fn(async (targets: TaggableClip[], source: string | null) => {
    for (const target of targets) target.source = source;
    return true;
  }),
}));

const clip = (
  id: string,
  path: string,
  tags: string[] = [],
  library = 'visualizer',
): TaggableClip => ({
  id,
  title: id,
  url: `/clips/${path}`,
  path,
  library,
  tags,
  source: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  taggerState.tagVocabulary = ['360', 'bw', 'indie'];
  taggerState.clips = [];
  taggerState.activeLibraryId = 'visualizer';
  taggerState.activeFolderPath = null;
  taggerState.filenameSearch = '';
  taggerState.clipFilter = createEmptyTagsFilter();
  taggerState.previousMatchAllSetting = true;
  taggerState.focusedClipId = null;
  endSelectionReview();
  clearClipSelection();
  taggerState.undoStack = [];
  taggerState.pendingSaveCount = 0;
  taggerState.statusMessage = '';
});

const ids = () => getVisibleClips().map((clip) => clip.id);
const tagsArm = () => {
  if (taggerState.clipFilter.kind !== 'tags') throw new Error('expected the tags filter mode');
  return taggerState.clipFilter;
};

describe('getVisibleClips() view derivation', () => {
  beforeEach(() => {
    taggerState.clips = [
      clip('a', 'a.mp4'),
      clip('b', '360/b.mp4', ['360']),
      clip('c', '360/cool.mp4', ['360', 'bw']),
      clip('d', 'bw/d.mp4', ['bw']),
    ];
  });

  it('scopes by folder, search, and untagged-only', () => {
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    taggerState.activeFolderPath = '360';
    expect(ids()).toEqual(['b', 'c']);
    taggerState.filenameSearch = 'cool';
    expect(ids()).toEqual(['c']);
    taggerState.activeFolderPath = null;
    taggerState.filenameSearch = '';
    taggerState.clipFilter = { kind: 'untagged' };
    expect(ids()).toEqual(['a']);
  });

  it('applies include/exclude with match-all vs any', () => {
    cycleTagFilter('360');
    cycleTagFilter('bw');
    expect(ids()).toEqual(['c']);
    toggleTagMatchMode();
    expect(ids()).toEqual(['b', 'c', 'd']);
    cycleTagFilter('bw');
    expect(ids()).toEqual(['b']);
  });

  it('includes subfolders without matching similarly named folders or another library', () => {
    taggerState.clips = [
      clip('a', 'films/a.mp4'),
      clip('b', 'films/sessions/b.mp4'),
      clip('c', 'films-old/c.mp4'),
      clip('d', 'd.mp4'),
      clip('e', 'wbru-youtube/films/e.mp4', [], 'wbru-youtube'),
    ];

    selectFolder('films');
    expect(ids()).toEqual(['a', 'b']);
    selectFolder('films/sessions');
    expect(ids()).toEqual(['b']);
    selectFolder('(root)');
    expect(ids()).toEqual(['d']);
    selectFolder(null);
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('getLibraryFolders()', () => {
  it('builds missing parents and sorts siblings with totals for each branch', () => {
    taggerState.clips = [
      clip('a', 'a.mp4'),
      clip('b', 'films/session 10/b.mp4'),
      clip('c', 'films/session 2/c.mp4'),
      clip('d', 'films/session 2/outtakes/d.mp4'),
      clip('e', 'films/e.mp4'),
      clip('f', 'wbru-youtube/f.mp4', [], 'wbru-youtube'),
    ];

    expect(getLibraryFolders()).toEqual([
      { path: '(root)', label: '(root)', count: 1, children: [] },
      {
        path: 'films',
        label: 'films',
        count: 4,
        children: [
          {
            path: 'films/session 2',
            label: 'session 2',
            count: 2,
            children: [
              {
                path: 'films/session 2/outtakes',
                label: 'outtakes',
                count: 1,
                children: [],
              },
            ],
          },
          { path: 'films/session 10', label: 'session 10', count: 1, children: [] },
        ],
      },
    ]);

    selectLibrary('wbru-youtube');
    expect(getLibraryFolders()).toEqual([
      { path: '(root)', label: '(root)', count: 1, children: [] },
    ]);
    taggerState.clips = [];
    expect(getLibraryFolders()).toEqual([]);
  });
});

describe('getAvailableClipSources()', () => {
  it('returns unique assigned sources in display order', () => {
    taggerState.clips = [
      { ...clip('a', 'a.mp4'), source: 'Night of the Living Dead' },
      { ...clip('b', 'b.mp4'), source: 'A Trip to the Moon' },
      { ...clip('c', 'c.mp4'), source: 'Night of the Living Dead' },
    ];
    expect(getAvailableClipSources()).toEqual(['A Trip to the Moon', 'Night of the Living Dead']);
  });
});

describe('library scope', () => {
  it('keeps similarly tagged libraries separate and resets location context', () => {
    taggerState.clips = [
      clip('main', 'indie/main.mp4', ['indie']),
      clip('youtube', 'wbru-youtube/session.mp4', ['indie'], 'wbru-youtube'),
    ];
    taggerState.activeFolderPath = 'indie';
    taggerState.focusedClipId = 'main';
    taggerState.selectedClipIds.add('main');

    selectLibrary('wbru-youtube');

    expect(ids()).toEqual(['youtube']);
    expect(taggerState.activeFolderPath).toBeNull();
    expect(taggerState.focusedClipId).toBeNull();
    expect(taggerState.selectedClipIds.size).toBe(0);
  });
});

describe('two-phase batch review', () => {
  beforeEach(() => {
    taggerState.clips = [clip('a', 'a.mp4'), clip('b', 'b.mp4'), clip('c', 'c.mp4')];
    taggerState.clipFilter = { kind: 'untagged' };
  });

  it('a bulk apply lingers the batch instead of vanishing from "untagged only"', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);
    expect(taggerState.isReviewingSelection).toBe(true);
    // Tagged clips remain visible while the batch is under review.
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('further bulk edits keep operating on the lingering batch', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);
    await applyTagToSelection('bw', true);
    expect(taggerState.clips[0].tags).toEqual(['360', 'bw']);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('source edits still reach the completed batch under review', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);

    await setSourceForSelection('Shared source');

    expect(taggerState.clips.map(({ source }) => source)).toEqual([
      'Shared source',
      'Shared source',
      null,
    ]);
    expect(taggerState.isReviewingSelection).toBe(true);
  });

  it('keeps a reviewed selection and its undo history when a source edit fails', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);
    const history = taggerState.undoStack[0];
    vi.mocked(persistClipSources).mockResolvedValueOnce(false);

    await setSourceForSelection('Shared source');

    expect(taggerState.clips.map(({ source }) => source)).toEqual([null, null, null]);
    expect(taggerState.undoStack).toEqual([history]);
    expect(taggerState.isReviewingSelection).toBe(true);
    expect([...taggerState.selectedClipIds]).toEqual(['a', 'b']);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('Select all replaces the reviewed batch with the current filtered result', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);

    selectAllVisibleClips();

    expect(taggerState.isReviewingSelection).toBe(false);
    expect([...taggerState.selectedClipIds]).toEqual(['c']);
  });

  it('changing the selection ends review and applies the active filter', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);
    toggleClipSelection(taggerState.clips[2].id, true, false);
    expect(taggerState.isReviewingSelection).toBe(false);
    expect([...taggerState.selectedClipIds]).toEqual(['c']);
    expect(ids()).toEqual(['c']);
  });

  it('a context switch ends review and clears the selection', async () => {
    taggerState.selectedClipIds.add('a');
    await applyTagToSelection('360', true);
    setFilenameSearch('b');
    expect(taggerState.isReviewingSelection).toBe(false);
    expect(taggerState.selectedClipIds.size).toBe(0);
    expect(ids()).toEqual(['b']);
  });

  it('previewing inside the reviewed selection keeps it; previewing outside ends review', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);
    focusClip(taggerState.clips[0].id);
    expect(taggerState.isReviewingSelection).toBe(true);
    focusClip(taggerState.clips[2].id);
    expect(taggerState.isReviewingSelection).toBe(false);
    expect(taggerState.selectedClipIds.size).toBe(0);
  });

  it('a single inline toggle leaves the view immediately (no lingering)', async () => {
    await toggleClipTag(taggerState.clips[0], '360');
    expect(taggerState.isReviewingSelection).toBe(false);
    expect(ids()).toEqual(['b', 'c']);
  });

  it('undo restores the batch tags and ends the review, keeping the selection', async () => {
    taggerState.selectedClipIds.add('a').add('b');
    await applyTagToSelection('360', true);
    await undoLast();
    expect(taggerState.clips[0].tags).toEqual([]);
    expect(taggerState.isReviewingSelection).toBe(false);
    expect(ids()).toEqual(['a', 'b', 'c']);
    // Undo ends review but keeps the selection available for another bulk edit.
    toggleClipSelection(taggerState.clips[2].id, true, false);
    expect([...taggerState.selectedClipIds].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('selection visibility', () => {
  beforeEach(() => {
    taggerState.clips = [clip('a', 'a.mp4'), clip('b', 'b.mp4'), clip('c', 'c.mp4')];
    taggerState.clipFilter = { kind: 'untagged' };
  });

  it('Select all replaces hidden selections and resets the shift anchor', () => {
    taggerState.clips[0].tags.push('360');
    taggerState.selectedClipIds.add('a');
    taggerState.selectionAnchorClipId = 'a';

    selectAllVisibleClips();

    expect([...taggerState.selectedClipIds]).toEqual(['b', 'c']);
    expect(taggerState.selectionAnchorClipId).toBeNull();
  });

  it('Select all still selects the full filtered catalog beyond the rendered page', () => {
    taggerState.clips = Array.from({ length: 301 }, (_, index) =>
      clip(`clip-${index}`, `${index}.mp4`),
    );
    taggerState.clips[0].tags.push('360');
    taggerState.selectedClipIds.add('clip-0');

    selectAllVisibleClips();

    expect(taggerState.selectedClipIds.size).toBe(300);
    expect(taggerState.selectedClipIds.has('clip-0')).toBe(false);
    expect(taggerState.selectedClipIds.has('clip-300')).toBe(true);
  });

  it('deselects a clip hidden by an inline tag edit', async () => {
    toggleClipSelection('a', true, false);
    await toggleClipTag(taggerState.clips[0], '360');

    expect(ids()).toEqual(['b', 'c']);
    expect(taggerState.selectedClipIds.size).toBe(0);
    expect(taggerState.selectionAnchorClipId).toBeNull();
  });

  it.each(['tags', 'source'] as const)(
    'excludes hidden IDs from bulk %s edits and later review',
    async (edit) => {
      taggerState.clips[0].tags.push('360');
      taggerState.clips.push(clip('other-library', 'other.mp4', [], 'wbru-youtube'));
      taggerState.selectedClipIds.add('a').add('b').add('other-library').add('removed');
      taggerState.selectionAnchorClipId = 'a';

      if (edit === 'tags') {
        await applyTagToSelection('bw', true);
        await applyTagToSelection('indie', true);
        expect(taggerState.clips[0].tags).toEqual(['360']);
        expect(taggerState.clips[1].tags).toEqual(['bw', 'indie']);
        expect(
          vi.mocked(persistTagChanges).mock.calls.map(([clips]) => clips.map(({ id }) => id)),
        ).toEqual([['b'], ['b']]);
      } else {
        await setSourceForSelection('Shared source');
        expect(taggerState.clips[0].source).toBeNull();
        expect(taggerState.clips[1].source).toBe('Shared source');
        expect(vi.mocked(persistClipSources).mock.calls[0][0].map(({ id }) => id)).toEqual(['b']);
      }
      expect(taggerState.clips[3].tags).toEqual([]);
      expect(taggerState.clips[3].source).toBeNull();
      expect([...taggerState.selectedClipIds]).toEqual(['b']);
      expect(taggerState.selectionAnchorClipId).toBeNull();
    },
  );
});

describe('undo history', () => {
  beforeEach(() => {
    taggerState.clips = [clip('a', 'a.mp4'), clip('b', 'b.mp4')];
  });

  it('undoes multiple tag edits in reverse order', async () => {
    await toggleClipTag(taggerState.clips[0], '360');
    await toggleClipTag(taggerState.clips[0], 'bw');

    expect(taggerState.clips[0].tags).toEqual(['360', 'bw']);
    expect(taggerState.undoStack).toHaveLength(2);

    await undoLast();
    expect(taggerState.clips[0].tags).toEqual(['360']);
    expect(taggerState.undoStack).toHaveLength(1);

    await undoLast();
    expect(taggerState.clips[0].tags).toEqual([]);
    expect(taggerState.undoStack).toHaveLength(0);
  });

  it('restores different source values after a bulk edit', async () => {
    taggerState.clips[0].source = 'Source A';
    taggerState.clips[1].source = 'Source B';
    taggerState.selectedClipIds.add('a').add('b');

    await setSourceForSelection('Shared source');
    expect(taggerState.clips.map((clip) => clip.source)).toEqual([
      'Shared source',
      'Shared source',
    ]);

    await undoLast();
    expect(taggerState.clips.map((clip) => clip.source)).toEqual(['Source A', 'Source B']);
    expect(taggerState.undoStack).toHaveLength(0);
  });

  it.each(['preview', 'selection'])(
    'skips unchanged sources and undoes one-clip edits from %s',
    async (action) => {
      const clip = taggerState.clips[0];
      clip.source = 'Old source';
      taggerState.selectedClipIds.add(clip.id);
      const save = (source: string) =>
        action === 'preview' ? setClipSource(clip, source) : setSourceForSelection(source);

      await save(' Old source ');
      expect(persistClipSources).not.toHaveBeenCalled();
      expect(taggerState.undoStack).toHaveLength(0);

      await save(' New source ');
      expect(persistClipSources).toHaveBeenCalledWith([clip], 'New source');
      expect(clip.source).toBe('New source');
      expect(taggerState.undoStack).toHaveLength(1);

      await undoLast();

      expect(persistClipSources).toHaveBeenLastCalledWith([clip], 'Old source');
      expect(clip.source).toBe('Old source');
      expect(taggerState.undoStack).toHaveLength(0);
    },
  );
});

describe('filter interactions', () => {
  it('chips cycle include -> exclude -> off', () => {
    cycleTagFilter('360');
    expect([...tagsArm().includeTags]).toEqual(['360']);
    cycleTagFilter('360');
    expect([...tagsArm().includeTags]).toEqual([]);
    expect([...tagsArm().excludeTags]).toEqual(['360']);
    cycleTagFilter('360');
    expect(tagsArm().excludeTags.size).toBe(0);
  });

  it('"untagged only" and tag filters cannot coexist', () => {
    setOnlyUntagged(true);
    expect(taggerState.clipFilter.kind).toBe('untagged');
    cycleTagFilter('360');
    expect([...tagsArm().includeTags]).toEqual(['360']);
    setOnlyUntagged(true);
    expect(taggerState.clipFilter.kind).toBe('untagged');
    setOnlyUntagged(false);
    expect(tagsArm().includeTags.size).toBe(0);
  });

  it('remembers match mode across the untagged view', () => {
    toggleTagMatchMode();
    setOnlyUntagged(true);

    expect(taggerState.previousMatchAllSetting).toBe(false);

    setOnlyUntagged(false);
    expect(tagsArm().matchAll).toBe(false);
  });

  it('context switches clear the selection', () => {
    taggerState.clips = [clip('a', 'x/a.mp4'), clip('b', 'y/b.mp4')];
    taggerState.selectedClipIds.add('a');
    selectFolder('y');
    expect(taggerState.selectedClipIds.size).toBe(0);
    taggerState.selectedClipIds.add('b');
    clearTagFilter();
    expect(taggerState.selectedClipIds.size).toBe(0);
  });
});

describe('shift-range selection', () => {
  it('selects the visible range between anchor and click', () => {
    taggerState.clips = [
      clip('a', 'a.mp4'),
      clip('b', 'b.mp4'),
      clip('c', 'c.mp4'),
      clip('d', 'd.mp4'),
    ];
    toggleClipSelection(taggerState.clips[0].id, true, false);
    toggleClipSelection('d', true, true);
    expect([...taggerState.selectedClipIds].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts a new range after clearing the selection', () => {
    taggerState.clips = [
      clip('a', 'a.mp4'),
      clip('b', 'b.mp4'),
      clip('c', 'c.mp4'),
      clip('d', 'd.mp4'),
    ];
    toggleClipSelection(taggerState.clips[0].id, true, false);

    clearSelectedClips();
    toggleClipSelection(taggerState.clips[3].id, true, true);

    expect([...taggerState.selectedClipIds]).toEqual(['d']);
  });

  it('keeps the same anchor when the catalog order changes', () => {
    taggerState.clips = [clip('a', 'a.mp4'), clip('b', 'b.mp4'), clip('c', 'c.mp4')];
    toggleClipSelection(taggerState.clips[1].id, true, false);

    taggerState.clips = [
      clip('new', 'new.mp4'),
      clip('a', 'a.mp4'),
      clip('b', 'b.mp4'),
      clip('c', 'c.mp4'),
    ];
    toggleClipSelection(taggerState.clips[3].id, true, true);

    expect([...taggerState.selectedClipIds].sort()).toEqual(['b', 'c']);
  });
});
