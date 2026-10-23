<script lang="ts">
  import { getAvailableClipSources, taggerState } from '../taggerState.svelte';
  import { applyTagToSelection, setSourceForSelection } from '../taggerActions';

  let action = $state<'add' | 'remove' | 'source' | 'clear-source'>('add');
  let tagDraft = $state('');
  let sourceDraft = $state('');
  const canApply = $derived(
    taggerState.pendingSaveCount === 0 &&
      (action === 'clear-source' ||
        (action === 'source'
          ? Boolean(sourceDraft.trim())
          : taggerState.tagVocabulary.includes(tagDraft))),
  );

  // Every batch edit uses the same save and undo actions as individual clip edits.
  function apply(event: SubmitEvent): void {
    event.preventDefault();
    if (!canApply) return;
    if (action === 'source' || action === 'clear-source') {
      void setSourceForSelection(action === 'source' ? sourceDraft : null);
    } else {
      void applyTagToSelection(tagDraft, action === 'add');
    }
  }
</script>

{#if taggerState.selectedClipIds.size}
  <form class="bulkbar" aria-label="Edit selected clips" onsubmit={apply}>
    <strong class="selection-count"
      >{taggerState.selectedClipIds.size.toLocaleString()} selected</strong
    >
    <select aria-label="Bulk action" bind:value={action}>
      <option value="add">Add tag</option>
      <option value="remove">Remove tag</option>
      <option value="source">Set source</option>
      <option value="clear-source">Clear source</option>
    </select>
    {#if action === 'add' || action === 'remove'}
      <select class="bulk-value" aria-label="Tag to apply" bind:value={tagDraft}>
        <option value="" disabled>Select a tag</option>
        {#each taggerState.tagVocabulary as tag}<option value={tag}>{tag}</option>{/each}
      </select>
    {:else if action === 'source'}
      <input
        class="bulk-value"
        aria-label="Source for selected clips"
        list="bulk-source-options"
        placeholder="Source"
        bind:value={sourceDraft}
      />
      <datalist id="bulk-source-options">
        {#each getAvailableClipSources() as source}<option value={source}></option>{/each}
      </datalist>
    {/if}
    <button type="submit" class="primary-button" disabled={!canApply}>Apply</button>
  </form>
{/if}
