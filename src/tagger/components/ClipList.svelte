<script lang="ts">
  import { taggerState, getVisibleClips } from '../taggerState.svelte';
  import {
    refreshCatalog,
    selectAllVisibleClips,
    clearSelectedClips,
    undoLast,
  } from '../taggerActions';
  import BulkBar from './BulkBar.svelte';
  import ClipRow from './ClipRow.svelte';
  import FilterBar from './FilterBar.svelte';

  const ROW_BATCH_SIZE = 150;
  const undoAction = $derived(taggerState.undoStack.at(-1));
  const matchingClips = $derived(getVisibleClips());
  let renderedClipLimit = $state(ROW_BATCH_SIZE);
  let previousViewKey = '';
  let listElement: HTMLElement;
  // Capture only state that defines a new scrollable result set.
  const currentViewKey = $derived.by(() => {
    const filterState = taggerState.clipFilter;
    const filter =
      filterState.kind === 'untagged'
        ? { kind: 'untagged' }
        : {
            kind: 'tags',
            matchAll: filterState.matchAll,
            includeTags: [...filterState.includeTags].sort(),
            excludeTags: [...filterState.excludeTags].sort(),
          };
    return JSON.stringify({
      libraryId: taggerState.activeLibraryId,
      folderPath: taggerState.activeFolderPath,
      filenameSearch: taggerState.filenameSearch,
      filter,
    });
  });
  const renderedClips = $derived(matchingClips.slice(0, renderedClipLimit));

  // A new view starts with its first batch at the top of the list.
  $effect(() => {
    if (currentViewKey === previousViewKey) return;
    previousViewKey = currentViewKey;
    renderedClipLimit = ROW_BATCH_SIZE;
    if (listElement) listElement.scrollTop = 0;
  });

  // Render more rows near the bottom without mounting the full catalog at once.
  function extendRenderedRowsNearBottom(element: HTMLElement): void {
    if (element.scrollTop + element.clientHeight < element.scrollHeight - 800) return;
    renderedClipLimit = Math.min(renderedClipLimit + ROW_BATCH_SIZE, matchingClips.length);
  }
</script>

<section
  class="list"
  aria-label="Clips"
  bind:this={listElement}
  onscroll={(event) => extendRenderedRowsNearBottom(event.currentTarget)}
>
  <div class="listhead">
    <FilterBar />
    <div class="toolbar">
      <span class="clip-count"
        >{matchingClips.length.toLocaleString()} clip{matchingClips.length === 1 ? '' : 's'}</span
      >
      {#if renderedClips.length < matchingClips.length}
        <span class="render-count">showing {renderedClips.length}</span>
      {/if}
      <button class="quiet-button" onclick={selectAllVisibleClips}>Select all</button>
      <button
        class="quiet-button"
        disabled={!taggerState.selectedClipIds.size}
        onclick={clearSelectedClips}>Clear selection</button
      >
      <div class="toolbar-actions">
        <button
          id="undo"
          disabled={!undoAction || taggerState.pendingSaveCount > 0}
          title={undoAction
            ? `Undo ${undoAction.label} (${taggerState.undoStack.length} available)`
            : 'Nothing to undo'}
          onclick={undoLast}
        >
          ↶ Undo
          {#if taggerState.undoStack.length > 1}
            <span class="undo-count">{taggerState.undoStack.length}</span>
          {/if}
        </button>
        <button
          title="Rescan the clips folder for added/removed files"
          disabled={taggerState.isRefreshing}
          onclick={refreshCatalog}
        >
          ↻ Refresh
        </button>
      </div>
    </div>
    <BulkBar />
    <div class="column-headings" aria-hidden="true">
      <span>Filename / tags</span><span>Source</span>
    </div>
  </div>

  <div class="rows">
    {#if matchingClips.length}
      {#each renderedClips as clip (clip.id)}
        <ClipRow {clip} />
      {/each}
      {#if renderedClips.length < matchingClips.length}
        <button
          type="button"
          class="load-more"
          onclick={() =>
            (renderedClipLimit = Math.min(
              renderedClipLimit + ROW_BATCH_SIZE,
              matchingClips.length,
            ))}
        >
          Show {Math.min(ROW_BATCH_SIZE, matchingClips.length - renderedClips.length)} more
        </button>
      {/if}
    {:else}
      <div class="empty">No clips match.</div>
    {/if}
  </div>
</section>
