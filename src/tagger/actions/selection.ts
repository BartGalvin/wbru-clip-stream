import { taggerState, getVisibleClips } from '../taggerState.svelte';

// Clear both selected ids and the anchor used for shift-range selection.
export function clearClipSelection(): void {
  taggerState.selectedClipIds.clear();
  taggerState.selectionAnchorClipId = null;
}

// Metadata edits can hide selected rows without changing filters; reviewed batches stay visible.
export function pruneHiddenClipSelection(): void {
  if (!taggerState.selectedClipIds.size && !taggerState.selectionAnchorClipId) return;
  const visibleIds = new Set(getVisibleClips().map((clip) => clip.id));
  for (const id of taggerState.selectedClipIds)
    if (!visibleIds.has(id)) taggerState.selectedClipIds.delete(id);
  if (taggerState.selectionAnchorClipId && !visibleIds.has(taggerState.selectionAnchorClipId))
    taggerState.selectionAnchorClipId = null;
}

export function endSelectionReview(): void {
  taggerState.isReviewingSelection = false;
}

// Starting a new selection dismisses the completed batch retained for review.
function replaceReviewedSelection(): void {
  if (!taggerState.isReviewingSelection) return;
  endSelectionReview();
  clearClipSelection();
}

// Select the complete filtered result, including rows not yet rendered.
export function selectAllVisibleClips(): void {
  clearSelectedClips();
  for (const clip of getVisibleClips()) taggerState.selectedClipIds.add(clip.id);
}

export function clearSelectedClips(): void {
  endSelectionReview();
  clearClipSelection();
}

// Focusing outside a reviewed batch begins a fresh selection context.
export function focusClip(clipId: string): void {
  if (taggerState.isReviewingSelection && !taggerState.selectedClipIds.has(clipId)) {
    replaceReviewedSelection();
  }
  taggerState.focusedClipId = clipId;
}

// Support ordinary checkbox edits and contiguous shift-range selection.
export function toggleClipSelection(clipId: string, checked: boolean, shiftKey: boolean): void {
  if (taggerState.isReviewingSelection) {
    replaceReviewedSelection();
    if (checked) {
      taggerState.selectedClipIds.add(clipId);
      taggerState.selectionAnchorClipId = clipId;
    }
    return;
  }
  const visibleClips = getVisibleClips();
  const clipIndex = visibleClips.findIndex(({ id }) => id === clipId);
  const anchorIndex = taggerState.selectionAnchorClipId
    ? visibleClips.findIndex(({ id }) => id === taggerState.selectionAnchorClipId)
    : -1;
  if (shiftKey && anchorIndex >= 0) {
    const rangeStart = Math.min(anchorIndex, clipIndex);
    const rangeEnd = Math.max(anchorIndex, clipIndex);
    for (let index = rangeStart; index <= rangeEnd; index++) {
      if (checked) taggerState.selectedClipIds.add(visibleClips[index].id);
      else taggerState.selectedClipIds.delete(visibleClips[index].id);
    }
  } else if (checked) {
    taggerState.selectedClipIds.add(clipId);
  } else {
    taggerState.selectedClipIds.delete(clipId);
  }
  taggerState.selectionAnchorClipId = clipId;
}
