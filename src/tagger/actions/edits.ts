import type { TaggableClip } from '../../../shared/contract';
import { getClipsById, taggerState } from '../taggerState.svelte';
import { recordUndo } from './history';
import { pruneHiddenClipSelection } from './selection';
import { persistClipTags, persistTagChanges, persistClipSources } from './persistence';

const BULK_CONFIRMATION_THRESHOLD = 50;

// Apply one optimistic tag edit and record it only after persistence succeeds.
export async function toggleClipTag(clip: TaggableClip, tag: string): Promise<void> {
  const previousTags = [...clip.tags];
  const tagIndex = clip.tags.indexOf(tag);
  const shouldAdd = tagIndex < 0;
  if (shouldAdd) clip.tags.push(tag);
  else clip.tags.splice(tagIndex, 1);
  pruneHiddenClipSelection();
  if (await persistClipTags(clip)) {
    recordUndo({
      kind: 'tags',
      label: `${shouldAdd ? 'adding' : 'removing'} "${tag}"`,
      clips: [{ id: clip.id, tags: previousTags }],
    });
  }
}

// Apply one tag operation to the selected clips as a single undoable action.
export async function applyTagToSelection(tag: string, shouldAdd: boolean): Promise<void> {
  pruneHiddenClipSelection();
  const selectedClips = [...taggerState.selectedClipIds]
    .map((id) => getClipsById().get(id))
    .filter((clip): clip is TaggableClip => !!clip);
  const changedClips = selectedClips.filter((clip) =>
    shouldAdd ? !clip.tags.includes(tag) : clip.tags.includes(tag),
  );
  if (!changedClips.length) return;
  if (
    changedClips.length > BULK_CONFIRMATION_THRESHOLD &&
    !confirm(
      `${shouldAdd ? 'Add' : 'Remove'} "${tag}" ${shouldAdd ? 'to' : 'from'} ${changedClips.length} clips?`,
    )
  )
    return;

  const previousTagsByClip = changedClips.map((clip) => ({ id: clip.id, tags: [...clip.tags] }));
  for (const clip of changedClips) {
    if (shouldAdd) clip.tags.push(tag);
    else clip.tags.splice(clip.tags.indexOf(tag), 1);
  }
  taggerState.isReviewingSelection = true;
  if (
    await persistTagChanges(
      changedClips,
      `${shouldAdd ? 'Tagged' : 'Untagged'} ${changedClips.length}`,
    )
  ) {
    recordUndo({
      kind: 'tags',
      label: `${shouldAdd ? 'adding' : 'removing'} "${tag}" ${shouldAdd ? 'to' : 'from'} ${changedClips.length} clips`,
      clips: previousTagsByClip,
    });
  } else {
    taggerState.isReviewingSelection = false;
    pruneHiddenClipSelection();
  }
}

// Save one normalized source label and retain its prior value for undo.
export async function setClipSource(clip: TaggableClip, source: string | null): Promise<boolean> {
  const cleanedSource = source?.trim() || null;
  if (cleanedSource === clip.source) return true;
  const previousSource = clip.source;
  const saved = await persistClipSources([clip], cleanedSource);
  if (saved) {
    recordUndo({
      kind: 'sources',
      label: cleanedSource ? `setting source to "${cleanedSource}"` : 'clearing source',
      clips: [{ id: clip.id, source: previousSource }],
    });
  }
  return saved;
}

// Save one source label across the selected clips as a single undoable action.
export async function setSourceForSelection(source: string | null): Promise<void> {
  pruneHiddenClipSelection();
  const cleanedSource = source?.trim() || null;
  const changedClips = [...taggerState.selectedClipIds]
    .map((id) => getClipsById().get(id))
    .filter((clip): clip is TaggableClip => !!clip && clip.source !== cleanedSource);
  if (!changedClips.length) return;
  if (
    changedClips.length > BULK_CONFIRMATION_THRESHOLD &&
    !confirm(
      `${cleanedSource ? `Set source to "${cleanedSource}" for` : 'Clear source from'} ${changedClips.length} clips?`,
    )
  )
    return;

  const previousSources = changedClips.map((clip) => ({ id: clip.id, source: clip.source }));
  if (await persistClipSources(changedClips, cleanedSource)) {
    recordUndo({
      kind: 'sources',
      label: `${cleanedSource ? `setting source to "${cleanedSource}" for` : 'clearing source from'} ${changedClips.length} clips`,
      clips: previousSources,
    });
  }
}
