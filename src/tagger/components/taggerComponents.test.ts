// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaggableClip } from '../../../shared/contract';
import { createEmptyTagsFilter, taggerState } from '../taggerState.svelte';
import ClipRow from './ClipRow.svelte';
import PreviewPane from './PreviewPane.svelte';
import Tagger from '../Tagger.svelte';

const api = vi.hoisted(() => ({
  saveClipSources: vi.fn(),
  saveClipTags: vi.fn(),
  addTagToVocabulary: vi.fn(),
  deleteTagFromVocabulary: vi.fn(),
}));

vi.mock('../api', () => api);

function clip(id: string, source: string | null = null): TaggableClip {
  return {
    id,
    title: id,
    url: `/clips/${id}.mp4`,
    path: `${id}.mp4`,
    library: 'visualizer',
    tags: [],
    source,
  };
}

beforeEach(() => {
  api.saveClipTags.mockReset().mockResolvedValue(undefined);
  api.saveClipSources.mockReset().mockImplementation(async (ids, source) => ({ ids, source }));
  api.addTagToVocabulary.mockReset();
  api.deleteTagFromVocabulary.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  taggerState.tagVocabulary = [];
  taggerState.clips = [];
  taggerState.activeLibraryId = 'visualizer';
  taggerState.activeFolderPath = null;
  taggerState.filenameSearch = '';
  taggerState.clipFilter = createEmptyTagsFilter();
  taggerState.selectedClipIds.clear();
  taggerState.selectionAnchorClipId = null;
  taggerState.focusedClipId = null;
  taggerState.isReviewingSelection = false;
  taggerState.pendingSaveCount = 0;
  taggerState.undoStack = [];
  taggerState.statusMessage = '';
  taggerState.loadError = '';
  taggerState.isRefreshing = false;
});

function changeSelect(selector: string, value: string): void {
  const select = document.querySelector<HTMLSelectElement>(selector);
  if (!select) throw new Error(`Missing select: ${selector}`);
  select.value = value;
  // Supply the selected-option lookup used by browser change events.
  const lookup = vi.spyOn(select, 'querySelector').mockReturnValueOnce(select.selectedOptions[0]);
  try {
    select.dispatchEvent(new Event('change', { bubbles: true }));
  } finally {
    lookup.mockRestore();
  }
}

function submitBatch(): void {
  document
    .querySelector<HTMLFormElement>('.bulkbar')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('tagger components', () => {
  it('resizes either column with the keyboard and restores its default width', async () => {
    const component = mount(Tagger, { target: document.body });
    await tick();
    const folders = document.querySelector<HTMLElement>('[aria-label="Resize folders"]')!;
    const preview = document.querySelector<HTMLElement>('[aria-label="Resize preview"]')!;

    folders.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await tick();
    expect(folders.getAttribute('aria-valuenow')).toBe('236');
    expect(preview.getAttribute('aria-valuenow')).toBe('356');
    expect(
      document.querySelector<HTMLElement>('.layout')!.style.getPropertyValue('--sidebar-width'),
    ).toBe('236px');
    expect(
      document.querySelector<HTMLElement>('.layout')!.style.getPropertyValue('--preview-width'),
    ).toBe('356px');

    folders.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await tick();
    expect(folders.getAttribute('aria-valuenow')).toBe('220');
    expect(preview.getAttribute('aria-valuenow')).toBe('340');
    await unmount(component);
  });

  it.each([
    ['Resize folders', 1, 220],
    ['Resize preview', -1, 340],
  ] as const)(
    'drags %s within bounds and stops on pointer release',
    async (label, direction, initial) => {
      const component = mount(Tagger, { target: document.body });
      await tick();
      const divider = document.querySelector<HTMLDivElement>(`[aria-label="${label}"]`)!;
      divider.setPointerCapture = vi.fn();
      divider.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, clientX: 300, button: 0, bubbles: true }),
      );
      divider.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          clientX: 300 + direction * 50,
          bubbles: true,
        }),
      );
      await tick();
      expect(divider.getAttribute('aria-valuenow')).toBe(String(initial + 50));
      expect(divider.setPointerCapture).toHaveBeenCalledWith(1);

      divider.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          clientX: 300 + direction * 2000,
          bubbles: true,
        }),
      );
      await tick();
      expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemax'));
      divider.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      divider.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 300, bubbles: true }),
      );
      await tick();
      expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemax'));

      divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await tick();
      expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemin'));
      await unmount(component);
    },
  );

  it('shows assigned tags and a source without rendering the vocabulary in every row', async () => {
    taggerState.tagVocabulary = ['movie', 'indie', 'inactive'];
    const stateClip = { ...clip('a', 'Studio session'), tags: ['movie'] };
    const component = mount(ClipRow, { target: document.body, props: { clip: stateClip } });
    await tick();

    expect([...document.querySelectorAll('.tag-label')].map((tag) => tag.textContent)).toEqual([
      'movie',
    ]);
    expect(document.querySelector('.row-source')?.textContent).toBe('Studio session');
    expect(document.querySelectorAll('.row button')).toHaveLength(1);
    await unmount(component);
  });

  it('clears a reviewed selection when opening details from any part of a row', async () => {
    taggerState.clips = [{ ...clip('a', 'Studio session'), tags: ['movie'] }, clip('b')];
    const component = mount(Tagger, { target: document.body });
    await tick();

    for (const selector of ['.row-preview', '.name', '.tag-label', '.row-source']) {
      taggerState.selectedClipIds.add('a').add('b');
      taggerState.isReviewingSelection = true;
      taggerState.focusedClipId = 'b';
      await tick();
      document.querySelector<HTMLElement>(`.row[data-id="a"] ${selector}`)!.click();
      await tick();
      expect(taggerState.focusedClipId).toBe('a');
      expect(taggerState.selectionAnchorClipId).toBe('a');
      expect(document.querySelector('.preview video')?.getAttribute('src')).toBe('/clips/a.mp4');
      expect(taggerState.selectedClipIds.size).toBe(0);
      expect(taggerState.isReviewingSelection).toBe(false);
    }

    taggerState.selectedClipIds.add('b');
    taggerState.focusedClipId = 'b';
    await tick();
    document.querySelector<HTMLInputElement>('.row[data-id="a"] > input')!.click();
    await tick();
    expect(taggerState.focusedClipId).toBe('b');
    expect([...taggerState.selectedClipIds]).toEqual(['b', 'a']);
    await unmount(component);
  });

  it.each(['a', 'c'])('clears a selected range when normally clicking row %s', async (id) => {
    taggerState.clips = [clip('a'), clip('b'), clip('c')];
    const component = mount(Tagger, { target: document.body });
    await tick();

    document.querySelector<HTMLInputElement>('.row[data-id="a"] > input')!.click();
    document
      .querySelector<HTMLButtonElement>('.row[data-id="b"] .row-preview')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    await tick();
    expect([...taggerState.selectedClipIds]).toEqual(['a', 'b']);

    document.querySelector<HTMLButtonElement>(`.row[data-id="${id}"] .row-preview`)!.click();
    await tick();
    expect(taggerState.selectedClipIds.size).toBe(0);
    expect(document.querySelector('.bulkbar')).toBeNull();
    expect(taggerState.focusedClipId).toBe(id);
    expect(taggerState.selectionAnchorClipId).toBe(id);

    document
      .querySelector<HTMLButtonElement>('.row[data-id="b"] .row-preview')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    await tick();
    expect([...taggerState.selectedClipIds].sort()).toEqual(id === 'a' ? ['a', 'b'] : ['b', 'c']);
    await unmount(component);
  });

  it.each(['.row-preview', '.name', '.tag-label', '.row-source', 'input'])(
    'selects the range from a normal row click to a Shift-click on %s',
    async (target) => {
      taggerState.clips = ['a', 'b', 'c', 'd'].map((id) => ({
        ...clip(id, 'Studio session'),
        tags: ['movie'],
      }));
      const component = mount(Tagger, { target: document.body });
      await tick();

      document.querySelector<HTMLElement>('.row[data-id="b"] .name')!.click();
      await tick();
      document
        .querySelector<HTMLElement>(`.row[data-id="d"] ${target}`)!
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
        );
      await tick();

      expect([...taggerState.selectedClipIds]).toEqual(['b', 'c', 'd']);
      expect(taggerState.focusedClipId).toBe('b');
      expect(
        [...document.querySelectorAll<HTMLInputElement>('.row > input')].map(
          (checkbox) => checkbox.checked,
        ),
      ).toEqual([false, true, true, true]);
      await unmount(component);
    },
  );

  it('extends a checkbox selection upward by Shift-clicking a row', async () => {
    taggerState.clips = ['a', 'b', 'c', 'd'].map((id) => clip(id));
    const component = mount(Tagger, { target: document.body });
    await tick();

    document.querySelector<HTMLInputElement>('.row[data-id="d"] > input')!.click();
    await tick();
    document
      .querySelector<HTMLButtonElement>('.row[data-id="b"] .row-preview')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    await tick();

    expect([...taggerState.selectedClipIds].sort()).toEqual(['b', 'c', 'd']);
    expect(taggerState.focusedClipId).toBeNull();
    await unmount(component);
  });

  it('selects just the clicked row when Shift-click has no starting point', async () => {
    taggerState.clips = [clip('a'), clip('b')];
    const component = mount(Tagger, { target: document.body });
    await tick();

    document
      .querySelector<HTMLButtonElement>('.row[data-id="b"] .row-preview')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    await tick();

    expect([...taggerState.selectedClipIds]).toEqual(['b']);
    await unmount(component);
  });

  it('folds folders from their labels and preserves expansion across catalog refreshes', async () => {
    taggerState.clips = [
      { ...clip('a'), path: 'films/sessions/a.mp4' },
      { ...clip('b'), path: 'films/trailers/b.mp4' },
      clip('c'),
    ];
    const component = mount(Tagger, { target: document.body });
    await tick();

    const folders = [...document.querySelectorAll<HTMLElement>('.folders .folder')];
    expect(folders.map((folder) => folder.querySelector('.folder-label')?.textContent)).toEqual([
      'All folders',
      '(root)',
      'films',
      'sessions',
      'trailers',
    ]);
    const branch = document.querySelector<HTMLDetailsElement>('.folders .folder-tree details')!;
    expect(branch.open).toBe(false);

    const label = document.querySelector<HTMLElement>('.folder[title="films"] .folder-label')!;
    label.click();
    await tick();
    expect(branch.open).toBe(true);
    expect(taggerState.activeFolderPath).toBe('films');
    expect(
      [...document.querySelectorAll('.row')].map((row) => row.getAttribute('data-id')),
    ).toEqual(['a', 'b']);

    label.click();
    await tick();
    expect(branch.open).toBe(false);
    label.click();
    await tick();
    expect(branch.open).toBe(true);

    taggerState.clips = [
      ...taggerState.clips,
      { ...clip('d'), path: 'films/sessions/outtakes/d.mp4' },
    ];
    await tick();
    expect(document.querySelector('.folders .folder-tree details')).toBe(branch);
    expect(branch.open).toBe(true);
    expect(document.querySelector('.folder[title="films"] .count')?.textContent).toBe('3');
    const child = document.querySelector<HTMLElement>('.folder[title="films/sessions"]')!;
    child.click();
    await tick();
    expect((child.parentElement as HTMLDetailsElement).open).toBe(true);
    expect(branch.open).toBe(true);
    expect(
      [...document.querySelectorAll('.row')].map((row) => row.getAttribute('data-id')),
    ).toEqual(['a', 'd']);
    child.querySelector<HTMLElement>('.folder-label')!.click();
    await tick();
    expect((child.parentElement as HTMLDetailsElement).open).toBe(false);
    expect(branch.open).toBe(true);
    await unmount(component);
  });

  it('collapses all folders without resetting expanded branches', async () => {
    taggerState.clips = [{ ...clip('a'), path: 'films/sessions/a.mp4' }, clip('b')];
    const component = mount(Tagger, { target: document.body });
    await tick();

    const root = document.querySelector<HTMLDetailsElement>('.folders > details')!;
    const branch = root.querySelector<HTMLDetailsElement>('.folder-tree details')!;
    expect(root.open).toBe(true);
    branch.querySelector('summary')!.click();
    await tick();
    document.querySelector<HTMLElement>('.folder[title="films/sessions"]')!.click();
    await tick();
    expect(taggerState.activeFolderPath).toBe('films/sessions');

    root.querySelector<HTMLElement>('summary .folder-label')!.click();
    await tick();
    expect(root.open).toBe(false);
    expect(branch.open).toBe(true);
    expect(taggerState.activeFolderPath).toBeNull();
    expect(document.querySelectorAll('.row')).toHaveLength(2);

    taggerState.clips = [...taggerState.clips, clip('c')];
    await tick();
    expect(root.open).toBe(false);
    expect(root.querySelector('summary .count')?.textContent).toBe('3');
    root.querySelector<HTMLElement>('summary .count')!.click();
    await tick();
    expect(root.open).toBe(true);
    expect(branch.open).toBe(true);
    await unmount(component);
  });

  it('updates details through filenames and previous/next navigation', async () => {
    taggerState.clips = [clip('a'), clip('b'), clip('c')];
    const component = mount(Tagger, { target: document.body });
    await tick();
    const filenames = [...document.querySelectorAll<HTMLButtonElement>('.row .name')];
    filenames[0].click();
    await tick();
    expect(document.querySelector('.preview video')?.getAttribute('src')).toBe('/clips/a.mp4');
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Previous clip"]')?.disabled,
    ).toBe(true);

    document.querySelector<HTMLButtonElement>('[aria-label="Next clip"]')?.click();
    await tick();
    expect(taggerState.focusedClipId).toBe('b');
    filenames[2].click();
    await tick();
    expect(document.querySelector('.preview video')?.getAttribute('src')).toBe('/clips/c.mp4');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Next clip"]')?.disabled).toBe(
      true,
    );
    document.querySelector<HTMLButtonElement>('[aria-label="Previous clip"]')?.click();
    await tick();
    expect(taggerState.focusedClipId).toBe('b');
    await unmount(component);
  });

  it.each([1, 2])(
    'saves tags and sources for %s selected clips, then undoes both',
    async (count) => {
      taggerState.tagVocabulary = ['indie', 'movie'];
      const ids = ['a', 'b'].slice(0, count);
      taggerState.clips = ids.map((id) => clip(id));
      const component = mount(Tagger, { target: document.body });
      await tick();
      for (const checkbox of document.querySelectorAll<HTMLInputElement>('.row > input'))
        checkbox.click();
      await tick();
      changeSelect('[aria-label="Tag to apply"]', 'movie');
      await tick();
      submitBatch();
      await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(1));
      expect(api.saveClipTags).toHaveBeenCalledWith(ids.map((id) => ({ id, tags: ['movie'] })));

      changeSelect('[aria-label="Bulk action"]', 'source');
      await tick();
      const source = document.querySelector<HTMLInputElement>(
        '[aria-label="Source for selected clips"]',
      )!;
      source.value = 'Film archive';
      source.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      submitBatch();
      await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(2));
      expect(api.saveClipSources).toHaveBeenCalledWith(ids, 'Film archive');
      expect(taggerState.clips.map((item) => item.source)).toEqual(ids.map(() => 'Film archive'));

      document.querySelector<HTMLButtonElement>('#undo')?.click();
      await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(1));
      expect(api.saveClipSources).toHaveBeenLastCalledWith(ids, null);
      expect(taggerState.clips.map((item) => item.source)).toEqual(ids.map(() => null));
      document.querySelector<HTMLButtonElement>('#undo')?.click();
      await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(0));
      expect(taggerState.clips.map((item) => item.tags)).toEqual(ids.map(() => []));
      await unmount(component);
    },
  );

  it('edits an individual tag through the details checklist', async () => {
    taggerState.tagVocabulary = ['indie'];
    taggerState.clips = [clip('a')];
    taggerState.focusedClipId = 'a';
    const component = mount(PreviewPane, { target: document.body });
    await tick();
    document.querySelector<HTMLInputElement>('.tag-option input')?.click();
    await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(1));
    expect(api.saveClipTags).toHaveBeenCalledWith([{ id: 'a', tags: ['indie'] }]);
    await tick();
    expect(document.querySelector<HTMLInputElement>('.tag-option input')?.checked).toBe(true);
    await unmount(component);
  });

  it('keeps include/exclude filtering and tag management separate', async () => {
    taggerState.tagVocabulary = ['movie'];
    taggerState.clips = [{ ...clip('a'), tags: ['movie'] }, clip('b')];
    const component = mount(Tagger, { target: document.body });
    await tick();
    const tagFilter = document.querySelector<HTMLButtonElement>('.tag-filter')!;
    tagFilter.click();
    await tick();
    expect(document.querySelectorAll('.row')).toHaveLength(1);
    expect(document.querySelector('.row')?.getAttribute('data-id')).toBe('a');
    tagFilter.click();
    await tick();
    expect(document.querySelector('.row')?.getAttribute('data-id')).toBe('b');
    tagFilter.click();
    await tick();
    expect(document.querySelectorAll('.row')).toHaveLength(2);
    expect(document.querySelector('.delete-tag')).toBeNull();
    document.querySelector<HTMLButtonElement>('.vocabulary .quiet-button')?.click();
    await tick();
    expect(document.querySelector('.delete-tag')).not.toBeNull();

    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    api.deleteTagFromVocabulary.mockResolvedValue({ vocab: [], affected: 1 });
    document.querySelector<HTMLButtonElement>('.delete-tag')?.click();
    await vi.waitFor(() => expect(taggerState.tagVocabulary).toEqual([]));
    await tick();
    expect(document.querySelector('.vocabulary-item')).toBeNull();
    expect(document.querySelector('.tag-label')).toBeNull();
    await unmount(component);
  });

  it('passes checkbox state and the Shift key into range selection', async () => {
    taggerState.clips = [clip('a'), clip('b'), clip('c'), clip('d')];
    const components = taggerState.clips.map((stateClip) => {
      const target = document.body.appendChild(document.createElement('div'));
      return mount(ClipRow, {
        target,
        props: { clip: { ...stateClip, tags: [...stateClip.tags] } },
      });
    });
    await tick();
    const checkboxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

    checkboxes[0].click();
    checkboxes[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await tick();

    expect([...taggerState.selectedClipIds].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(taggerState.focusedClipId).toBeNull();
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([true, true, true, true]);

    checkboxes[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await tick();

    expect([...taggerState.selectedClipIds].sort()).toEqual(['a', 'b', 'c']);
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([true, true, true, false]);

    checkboxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await tick();

    expect([...taggerState.selectedClipIds]).toEqual([]);
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([false, false, false, false]);
    await Promise.all(components.map((component) => unmount(component)));
  });

  it('keeps a failed source draft, then retries, clears, and undoes through the batch API', async () => {
    const stateClip = clip('a', 'Original source');
    taggerState.clips = [stateClip];
    taggerState.focusedClipId = stateClip.id;
    api.saveClipSources.mockRejectedValueOnce(new Error('offline'));
    const target = document.body.appendChild(document.createElement('div'));
    const component = mount(Tagger, { target });
    await tick();
    const input = document.querySelector<HTMLInputElement>('#clip-source');
    const form = document.querySelector<HTMLFormElement>('.source-editor');
    if (!input || !form) throw new Error('source editor did not render');

    input.value = 'New source';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(taggerState.pendingSaveCount).toBe(0));
    await tick();

    expect(input.value).toBe('New source');
    expect(api.saveClipSources).toHaveBeenCalledWith(['a'], 'New source');
    expect(taggerState.clips[0].source).toBe('Original source');
    expect(taggerState.undoStack).toHaveLength(0);
    expect(taggerState.statusMessage).toContain('Save failed');

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(1));
    await tick();
    expect(taggerState.clips[0].source).toBe('New source');

    document.querySelector<HTMLButtonElement>('.source-actions button[type="button"]')!.click();
    await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(2));
    await tick();
    expect(api.saveClipSources).toHaveBeenLastCalledWith(['a'], null);
    expect(taggerState.clips[0].source).toBeNull();
    expect(input.value).toBe('');

    document.querySelector<HTMLButtonElement>('#undo')!.click();
    await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(1));
    await tick();
    expect(input.value).toBe('New source');
    document.querySelector<HTMLButtonElement>('#undo')!.click();
    await vi.waitFor(() => expect(taggerState.undoStack).toHaveLength(0));
    await tick();
    expect(api.saveClipSources).toHaveBeenLastCalledWith(['a'], 'Original source');
    expect(input.value).toBe('Original source');
    expect(taggerState.clips[0].source).toBe('Original source');
    await unmount(component);
  });
});
