import * as api from '../api';
import { taggerState } from '../taggerState.svelte';
import { pruneHiddenClipSelection } from './selection';

// Remove vocabulary entries from filters after deletion or server reconciliation.
export function removeDeletedTagsFromFilter(): void {
  const filterState = taggerState.clipFilter;
  if (filterState.kind !== 'tags') return;
  for (const tag of [...filterState.includeTags]) {
    if (!taggerState.tagVocabulary.includes(tag)) filterState.includeTags.delete(tag);
  }
  for (const tag of [...filterState.excludeTags]) {
    if (!taggerState.tagVocabulary.includes(tag)) filterState.excludeTags.delete(tag);
  }
}

// Append one normalized tag through the server-owned vocabulary.
export async function addVocabularyTag(value: string): Promise<boolean> {
  const tag = value.trim();
  if (!tag || taggerState.tagVocabulary.includes(tag) || taggerState.pendingSaveCount > 0)
    return false;
  taggerState.localEditRevision++;
  taggerState.pendingSaveCount++;
  taggerState.statusMessage = 'Saving…';
  try {
    taggerState.tagVocabulary = (await api.addTagToVocabulary(tag)).vocab;
    removeDeletedTagsFromFilter();
    taggerState.statusMessage = `Added "${tag}" ✓`;
    return true;
  } catch (error) {
    taggerState.catalogRevision = '';
    taggerState.statusMessage = `Couldn't add "${tag}": ${error instanceof Error ? error.message : String(error)}`;
    return false;
  } finally {
    taggerState.pendingSaveCount--;
  }
}

// Confirm destructive use, then mirror the server's vocabulary and clip updates locally.
export async function deleteVocabularyTag(tag: string, usageCount: number): Promise<void> {
  if (taggerState.pendingSaveCount > 0) return;
  const confirmationMessage =
    usageCount > 0
      ? `Delete "${tag}" from the vocabulary and remove it from ${usageCount} clip(s)? This can't be undone.`
      : `Delete "${tag}" from the vocabulary?`;
  if (!confirm(confirmationMessage)) return;
  taggerState.localEditRevision++;
  taggerState.pendingSaveCount++;
  taggerState.statusMessage = 'Saving…';
  try {
    const { vocab: tagVocabulary, affected: affectedClipCount } =
      await api.deleteTagFromVocabulary(tag);
    // Older snapshots can still contain the deleted tag even when no current clip uses it.
    taggerState.undoStack = [];
    taggerState.tagVocabulary = tagVocabulary;
    for (const clip of taggerState.clips) {
      const tagIndex = clip.tags.indexOf(tag);
      if (tagIndex >= 0) clip.tags.splice(tagIndex, 1);
    }
    removeDeletedTagsFromFilter();
    pruneHiddenClipSelection();
    taggerState.statusMessage = `Deleted "${tag}" (${affectedClipCount} clip${affectedClipCount === 1 ? '' : 's'})`;
  } catch (error) {
    taggerState.catalogRevision = '';
    taggerState.statusMessage = `Couldn't delete "${tag}": ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    taggerState.pendingSaveCount--;
  }
}
