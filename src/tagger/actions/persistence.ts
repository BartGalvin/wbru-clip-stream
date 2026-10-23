import type { TaggableClip } from '../../../shared/contract';
import * as api from '../api';
import { taggerState } from '../taggerState.svelte';

let tagSaveQueue = Promise.resolve();

export function persistClipTags(clip: TaggableClip): Promise<boolean> {
  return persistTagChanges([clip], 'Saved', 'Saving…');
}

// Persist optimistic tag changes as one atomic request.
export async function persistTagChanges(
  clips: TaggableClip[],
  successMessage: string,
  savingMessage = `Saving ${clips.length}…`,
): Promise<boolean> {
  taggerState.localEditRevision++;
  taggerState.pendingSaveCount++;
  taggerState.statusMessage = savingMessage;
  try {
    // Snapshot optimistic edits before queueing them in operator order.
    const updates = clips.map(({ id, tags }) => ({ id, tags: [...tags] }));
    const request = tagSaveQueue.then(() => api.saveClipTags(updates));
    tagSaveQueue = request.catch(() => undefined);
    await request;
    // An earlier failure still needs catalog reconciliation, even if this save succeeds.
    if (taggerState.pendingSaveCount === 1 && taggerState.catalogRevision)
      taggerState.statusMessage = `${successMessage} ✓`;
    return true;
  } catch (error) {
    taggerState.catalogRevision = '';
    taggerState.statusMessage = `Save failed — ${error instanceof Error ? error.message : String(error)}`;
    return false;
  } finally {
    taggerState.pendingSaveCount--;
  }
}

// Apply a shared source only to the clips accepted by the server.
export async function persistClipSources(
  clips: TaggableClip[],
  source: string | null,
): Promise<boolean> {
  const normalizedSource = source?.trim() || null;
  taggerState.localEditRevision++;
  taggerState.pendingSaveCount++;
  taggerState.statusMessage = `Saving ${clips.length}…`;
  try {
    const response = await api.saveClipSources(
      clips.map((clip) => clip.id),
      normalizedSource,
    );
    const persistedClipIds = new Set(response.ids);
    for (const clip of clips) if (persistedClipIds.has(clip.id)) clip.source = response.source;
    taggerState.statusMessage = `${response.source ? 'Set source' : 'Cleared source'} for ${clips.length} ✓`;
    return true;
  } catch (error) {
    taggerState.statusMessage = `Save failed — ${error instanceof Error ? error.message : String(error)}`;
    return false;
  } finally {
    taggerState.pendingSaveCount--;
  }
}
