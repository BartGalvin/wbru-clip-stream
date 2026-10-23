import type { TaggableClip } from '../../../shared/contract';
import { getClipsById, taggerState, type UndoEntry } from '../taggerState.svelte';
import { persistTagChanges, persistClipSources } from './persistence';
import { pruneHiddenClipSelection } from './selection';

const UNDO_LIMIT = 50;

// Retain a bounded history of completed metadata edits.
export function recordUndo(entry: UndoEntry): void {
  // Only keep snapshots whose tags still exist in the vocabulary.
  if (
    entry.kind === 'tags' &&
    entry.clips.some(({ tags }) => tags.some((tag) => !taggerState.tagVocabulary.includes(tag)))
  ) {
    taggerState.undoStack = [];
    return;
  }
  taggerState.undoStack.push(entry);
  if (taggerState.undoStack.length > UNDO_LIMIT) taggerState.undoStack.shift();
}

// Restore one completed edit through the same persistence paths as ordinary changes.
export async function undoLast(): Promise<void> {
  const entry = taggerState.undoStack.at(-1);
  if (!entry || taggerState.pendingSaveCount > 0) return;

  let saved: boolean;
  if (entry.kind === 'tags') {
    const clips = entry.clips
      .map(({ id, tags }) => {
        const clip = getClipsById().get(id);
        if (clip) clip.tags = [...tags];
        return clip;
      })
      .filter((clip): clip is TaggableClip => !!clip);
    saved = await persistTagChanges(clips, `Undid ${entry.label}`);
  } else {
    const groups = new Map<string | null, TaggableClip[]>();
    for (const { id, source } of entry.clips) {
      const clip = getClipsById().get(id);
      if (!clip) continue;
      const group = groups.get(source) ?? [];
      group.push(clip);
      groups.set(source, group);
    }
    // Batch source restores by prior value to minimize network requests.
    const results = await Promise.all(
      [...groups].map(([source, clips]) => persistClipSources(clips, source)),
    );
    saved = results.every(Boolean);
    // Individual saves can finish in any order; report the outcome of the whole undo.
    taggerState.statusMessage = saved
      ? `Undid ${entry.label} ✓`
      : 'Undo incomplete - some sources could not be restored. Try Undo again.';
  }

  if (!saved) return;
  if (taggerState.undoStack.at(-1) === entry) taggerState.undoStack.pop();
  taggerState.isReviewingSelection = false;
  pruneHiddenClipSelection();
}
