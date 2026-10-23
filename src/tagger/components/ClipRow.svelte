<script lang="ts">
  import type { TaggableClip } from '../../../shared/contract';
  import { taggerState } from '../taggerState.svelte';
  import { getClipFolder, isUntagged, getClipFilename } from '../tags';
  import { clearSelectedClips, focusClip, toggleClipSelection } from '../taggerActions';

  const { clip }: { clip: TaggableClip } = $props();
  const folder = $derived(getClipFolder(clip));

  // A normal click clears the selection and anchors the next Shift-click range.
  function clickRow(event: MouseEvent): void {
    if (event.shiftKey) {
      toggleClipSelection(clip.id, true, true);
    } else {
      clearSelectedClips();
      focusClip(clip.id);
      taggerState.selectionAnchorClipId = clip.id;
    }
  }
</script>

<div
  class="row"
  class:untagged={isUntagged(clip)}
  class:focused={taggerState.focusedClipId === clip.id}
  class:selected={taggerState.selectedClipIds.has(clip.id)}
  data-id={clip.id}
>
  <input
    type="checkbox"
    aria-label={`Select ${getClipFilename(clip)}`}
    checked={taggerState.selectedClipIds.has(clip.id)}
    onclick={(event) => toggleClipSelection(clip.id, event.currentTarget.checked, event.shiftKey)}
  />
  <button
    class="row-preview"
    title={clip.path}
    aria-label={`Preview ${getClipFilename(clip)}`}
    aria-pressed={taggerState.focusedClipId === clip.id}
    onclick={clickRow}
  >
    <span class="clip-info">
      <span class="name">{getClipFilename(clip)}</span>
      <span class="row-metadata">
        {#if folder !== '(root)' && folder !== taggerState.activeFolderPath}
          <span class="folder-path">{folder}</span>
        {/if}
        {#each clip.tags as tag}
          <span class="tag-label">{tag}</span>
        {:else}
          <span class="untagged-label">Untagged</span>
        {/each}
      </span>
    </span>
    <span class="row-source" class:unset={!clip.source}>
      {clip.source || 'No source'}
    </span>
  </button>
</div>
