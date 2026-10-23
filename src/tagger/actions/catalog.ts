import type { TaggableClip } from '../../../shared/contract';
import * as api from '../api';
import { getClipsById, taggerState } from '../taggerState.svelte';
import { pruneHiddenClipSelection } from './selection';
import { removeDeletedTagsFromFilter } from './vocab';

let catalogSyncInFlight: Promise<void> | null = null;

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag) => right.includes(tag));
}

// Own saves change the server revision too; only changed metadata makes snapshots stale.
function replaceCatalogFromServer(serverClips: TaggableClip[], tagVocabulary: string[]): void {
  if (taggerState.undoStack.length) {
    const serverClipsById = new Map(serverClips.map((clip) => [clip.id, clip]));
    if (
      !sameTags(taggerState.tagVocabulary, tagVocabulary) ||
      taggerState.clips.some((clip) => {
        const serverClip = serverClipsById.get(clip.id);
        return (
          !serverClip || clip.source !== serverClip.source || !sameTags(clip.tags, serverClip.tags)
        );
      })
    )
      taggerState.undoStack = [];
  }
  taggerState.clips = serverClips;
  taggerState.tagVocabulary = tagVocabulary;
  removeDeletedTagsFromFilter();
  pruneHiddenClipSelection();
  if (taggerState.focusedClipId && !getClipsById().has(taggerState.focusedClipId))
    taggerState.focusedClipId = null;
}

// Reconcile background changes only when no local save or foreground scan is active.
export async function synchronizeCatalog(): Promise<void> {
  if (catalogSyncInFlight) return catalogSyncInFlight;
  if (taggerState.pendingSaveCount > 0 || taggerState.isRefreshing) return;
  // Keep local edits made after a background read begins.
  const localEditRevision = taggerState.localEditRevision;
  catalogSyncInFlight = (async () => {
    try {
      const serverRevision = await api.fetchCatalogRevision();
      if (
        taggerState.pendingSaveCount > 0 ||
        taggerState.isRefreshing ||
        taggerState.localEditRevision !== localEditRevision
      )
        return;
      if (serverRevision === taggerState.catalogRevision) return;
      const [catalogResponse, tagVocabulary] = await Promise.all([
        api.fetchClipCatalog(),
        api.fetchTagVocabulary(),
      ]);
      if (
        taggerState.pendingSaveCount > 0 ||
        taggerState.isRefreshing ||
        taggerState.localEditRevision !== localEditRevision
      )
        return;
      replaceCatalogFromServer(catalogResponse.clips, tagVocabulary);
      taggerState.catalogRevision = catalogResponse.revision;
      if (taggerState.loadError) {
        taggerState.loadError = '';
        taggerState.statusMessage = '';
      }
    } catch {
      return;
    }
  })().finally(() => {
    catalogSyncInFlight = null;
  });
  return catalogSyncInFlight;
}

// Run an operator-requested scan, then replace the catalog and vocabulary together.
export async function refreshCatalog(): Promise<void> {
  if (taggerState.isRefreshing) return;
  taggerState.isRefreshing = true;
  taggerState.statusMessage = 'Scanning…';
  try {
    const refreshResult = await api.refreshClipCatalog();
    taggerState.statusMessage = `Scan: +${refreshResult.added} added, −${refreshResult.removed} removed (${refreshResult.total} total)`;
    // The next poll will retry if this read is skipped or overtaken by a local edit.
    taggerState.catalogRevision = '';
    if (taggerState.pendingSaveCount > 0) return;
    const localEditRevision = taggerState.localEditRevision;
    const [catalogResponse, tagVocabulary] = await Promise.all([
      api.fetchClipCatalog(),
      api.fetchTagVocabulary(),
    ]);
    if (taggerState.pendingSaveCount > 0 || taggerState.localEditRevision !== localEditRevision)
      return;
    replaceCatalogFromServer(catalogResponse.clips, tagVocabulary);
    taggerState.catalogRevision = catalogResponse.revision;
    taggerState.loadError = '';
  } catch {
    taggerState.catalogRevision = '';
    taggerState.statusMessage = 'Refresh request failed; scan may still be running';
  } finally {
    taggerState.isRefreshing = false;
  }
}

// Populate the initial tagger view from one catalog and vocabulary snapshot.
export async function loadTaggerData(): Promise<void> {
  taggerState.statusMessage = 'Loading…';
  try {
    const [tagVocabulary, catalogResponse] = await Promise.all([
      api.fetchTagVocabulary(),
      api.fetchClipCatalog(),
    ]);
    replaceCatalogFromServer(catalogResponse.clips, tagVocabulary);
    taggerState.catalogRevision = catalogResponse.revision;
    taggerState.loadError = '';
    taggerState.statusMessage = '';
  } catch (error) {
    taggerState.statusMessage = 'Load failed';
    taggerState.loadError = `Could not load tags/clips from /api/tags. ${error instanceof Error ? error.message : String(error)}`;
  }
}
