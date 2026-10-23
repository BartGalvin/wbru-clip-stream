import { SvelteSet } from 'svelte/reactivity';
import { CLIP_LIBRARIES, libraryName, VISUALIZER_LIBRARY } from '../../shared/libraries';
import { matchesTagFilter } from '../../shared/tagFilter';
import type { TaggableClip } from '../../shared/contract';
import { getClipFilename, getClipFolder, isUntagged } from './tags';

// Prior tag state retained for one clip in an undo entry.
interface TagsUndoSnapshot {
  id: string;
  tags: string[];
}

// Prior source state retained for one clip in an undo entry.
interface SourceUndoSnapshot {
  id: string;
  source: string | null;
}

// One completed metadata action that can be restored as a unit.
export type UndoEntry =
  | { kind: 'tags'; label: string; clips: TagsUndoSnapshot[] }
  | { kind: 'sources'; label: string; clips: SourceUndoSnapshot[] };

// Reactive tag filter used by the operator-facing catalog view.
export interface TagsFilter {
  kind: 'tags';
  includeTags: SvelteSet<string>;
  excludeTags: SvelteSet<string>;
  matchAll: boolean;
}
// Catalog view may use ordinary tag matching or the dedicated untagged mode.
type ClipViewFilter = { kind: 'untagged' } | TagsFilter;

// A library-relative folder; its count includes clips in every child folder.
export interface LibraryFolder {
  path: string;
  label: string;
  count: number;
  children: LibraryFolder[];
}

// Create a reactive filter whose sets can be mutated directly by Svelte actions.
export const createEmptyTagsFilter = (matchAll = true): TagsFilter => ({
  kind: 'tags',
  includeTags: new SvelteSet<string>(),
  excludeTags: new SvelteSet<string>(),
  matchAll,
});

// SvelteSet keeps add/delete/clear reactive inside $state.
export const taggerState = $state({
  tagVocabulary: [] as string[],
  clips: [] as TaggableClip[],
  activeLibraryId: VISUALIZER_LIBRARY.id as string,
  activeFolderPath: null as string | null,
  filenameSearch: '',
  clipFilter: createEmptyTagsFilter() as ClipViewFilter,
  previousMatchAllSetting: true,
  selectedClipIds: new SvelteSet<string>(),
  focusedClipId: null as string | null,
  selectionAnchorClipId: null as string | null,
  // Keep a completed batch visible until the operator starts a new selection.
  isReviewingSelection: false,
  undoStack: [] as UndoEntry[],
  statusMessage: '',
  isRefreshing: false,
  loadError: '',
  pendingSaveCount: 0,
  localEditRevision: 0,
  catalogRevision: '',
});

// Index the current catalog once so actions can resolve selected ids cheaply.
const clipIndex = $derived.by(() => {
  const clips = new Map<string, TaggableClip>();
  for (const clip of taggerState.clips) clips.set(clip.id, clip);
  return clips;
});
export function getClipsById(): Map<string, TaggableClip> {
  return clipIndex;
}

// Apply the active library, folder, tag, and filename filters to one clip.
function matchesActiveView(clip: TaggableClip): boolean {
  if (clip.library !== taggerState.activeLibraryId) return false;
  const activeFolder = taggerState.activeFolderPath;
  const folder = getClipFolder(clip);
  if (activeFolder && folder !== activeFolder && !folder.startsWith(`${activeFolder}/`))
    return false;
  const viewFilter = taggerState.clipFilter;
  if (viewFilter.kind === 'untagged' ? !isUntagged(clip) : !matchesTagFilter(clip.tags, viewFilter))
    return false;
  const normalizedSearch = taggerState.filenameSearch.toLowerCase();
  if (normalizedSearch && !getClipFilename(clip).toLowerCase().includes(normalizedSearch))
    return false;
  return true;
}

// Keep a completed batch visible for review even if its edits no longer match the filter.
const visibleClipList = $derived.by(() =>
  taggerState.clips.filter(
    (clip) =>
      clip.library === taggerState.activeLibraryId &&
      (matchesActiveView(clip) ||
        (taggerState.isReviewingSelection && taggerState.selectedClipIds.has(clip.id))),
  ),
);
export function getVisibleClips(): TaggableClip[] {
  return visibleClipList;
}

const focusedClip = $derived(
  taggerState.focusedClipId ? (clipIndex.get(taggerState.focusedClipId) ?? null) : null,
);
export function getFocusedClip(): TaggableClip | null {
  return focusedClip;
}

// Progress counts are scoped to the active library rather than the entire catalog.
const libraryClips = $derived(
  taggerState.clips.filter((clip) => clip.library === taggerState.activeLibraryId),
);
export function getLibraryClipCount(): number {
  return libraryClips.length;
}

const taggedClipCount = $derived(libraryClips.filter((clip) => !isUntagged(clip)).length);
export function getTaggedClipCount(): number {
  return taggedClipCount;
}

// Source suggestions come from distinct labels already present in the catalog.
const availableSourceList = $derived(
  [...new Set(taggerState.clips.flatMap((clip) => (clip.source ? [clip.source] : [])))].sort(),
);
export function getAvailableClipSources(): string[] {
  return availableSourceList;
}

// Build parent folders even when their clips all live in subfolders.
const folderTree = $derived.by(() => {
  const counts = new Map<string, number>();
  for (const clip of libraryClips) {
    const folder = getClipFolder(clip);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const roots: LibraryFolder[] = [];
  const folders = new Map<string, LibraryFolder>();
  for (const [path, count] of counts) {
    let branch = roots;
    let parentPath = '';
    for (const label of path.split('/')) {
      parentPath = parentPath ? `${parentPath}/${label}` : label;
      let folder = folders.get(parentPath);
      if (!folder) {
        folder = { path: parentPath, label, count: 0, children: [] };
        folders.set(parentPath, folder);
        branch.push(folder);
      }
      folder.count += count;
      branch = folder.children;
    }
  }

  function sortFolders(branch: LibraryFolder[]): void {
    branch.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    for (const folder of branch) sortFolders(folder.children);
  }
  sortFolders(roots);
  return roots;
});
export function getLibraryFolders(): LibraryFolder[] {
  return folderTree;
}

// Include configured libraries even when empty, then append libraries discovered in the catalog.
const libraryList = $derived.by(() => {
  const ids = new Set([
    ...CLIP_LIBRARIES.map((library) => library.id),
    ...taggerState.clips.map((clip) => clip.library),
  ]);
  return [...ids].map((id) => ({
    id,
    name: libraryName(id),
    count: taggerState.clips.filter((clip) => clip.library === id).length,
  }));
});
export function getClipLibraries(): { id: string; name: string; count: number }[] {
  return libraryList;
}

export function countClipsUsingTag(tag: string): number {
  return taggerState.clips.filter((clip) => clip.tags.includes(tag)).length;
}
