import { createEmptyTagsFilter, taggerState, type TagsFilter } from '../taggerState.svelte';
import { clearClipSelection, endSelectionReview } from './selection';

// A view change ends batch review and clears selection after updating the filter context.
function updateViewContext(apply: () => void): void {
  endSelectionReview();
  apply();
  clearClipSelection();
}

// Leaving untagged-only mode restores the prior tag matching preference.
function getTagFilter(): TagsFilter {
  if (taggerState.clipFilter.kind !== 'tags') {
    taggerState.clipFilter = createEmptyTagsFilter(taggerState.previousMatchAllSetting);
  }
  return taggerState.clipFilter as TagsFilter;
}

// Folder changes preserve the active library and reset the current selection.
export function selectFolder(key: string | null): void {
  updateViewContext(() => {
    taggerState.activeFolderPath = key;
  });
}

// Library changes also reset folder and preview context.
export function selectLibrary(id: string): void {
  if (id === taggerState.activeLibraryId) return;
  updateViewContext(() => {
    taggerState.activeLibraryId = id;
    taggerState.activeFolderPath = null;
    taggerState.focusedClipId = null;
  });
}

// Cycle a filter tag through included, excluded, and neutral states.
export function cycleTagFilter(tag: string): void {
  updateViewContext(() => {
    const viewFilter = getTagFilter();
    if (viewFilter.includeTags.has(tag)) {
      viewFilter.includeTags.delete(tag);
      viewFilter.excludeTags.add(tag);
    } else if (viewFilter.excludeTags.has(tag)) {
      viewFilter.excludeTags.delete(tag);
    } else {
      viewFilter.includeTags.add(tag);
    }
  });
}

// Filename searches follow the same selection-reset rule as other view changes.
export function setFilenameSearch(value: string): void {
  updateViewContext(() => {
    taggerState.filenameSearch = value;
  });
}

// Switch between untagged-only and the previous ordinary tag filter mode.
export function setOnlyUntagged(on: boolean): void {
  updateViewContext(() => {
    if (taggerState.clipFilter.kind === 'tags') {
      taggerState.previousMatchAllSetting = taggerState.clipFilter.matchAll;
    }
    taggerState.clipFilter = on
      ? { kind: 'untagged' }
      : createEmptyTagsFilter(taggerState.previousMatchAllSetting);
  });
}

// Change how multiple included tags combine without changing the selected tags.
export function toggleTagMatchMode(): void {
  updateViewContext(() => {
    const viewFilter = taggerState.clipFilter;
    if (viewFilter.kind === 'tags') viewFilter.matchAll = !viewFilter.matchAll;
  });
}

// Remove selected tags while preserving the current match mode.
export function clearTagFilter(): void {
  updateViewContext(() => {
    const viewFilter = taggerState.clipFilter;
    taggerState.clipFilter = createEmptyTagsFilter(
      viewFilter.kind === 'tags' ? viewFilter.matchAll : taggerState.previousMatchAllSetting,
    );
  });
}
