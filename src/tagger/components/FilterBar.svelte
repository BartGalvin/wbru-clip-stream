<script lang="ts">
  import { taggerState } from '../taggerState.svelte';
  import {
    clearTagFilter,
    cycleTagFilter,
    setOnlyUntagged,
    toggleTagMatchMode,
  } from '../taggerActions';

  const filter = $derived(taggerState.clipFilter);
  const activeTags = $derived(
    filter.kind === 'tags' ? [...filter.includeTags, ...filter.excludeTags] : [],
  );
</script>

<div class="filterbar" aria-label="Clip filters">
  <label class="toggle">
    <input
      type="checkbox"
      checked={filter.kind === 'untagged'}
      onchange={(event) => setOnlyUntagged(event.currentTarget.checked)}
    />
    Untagged only
  </label>
  <div class="active-filters">
    {#each activeTags as tag}
      {@const excluded = filter.kind === 'tags' && filter.excludeTags.has(tag)}
      <button
        class="filter-tag"
        class:excluded
        title={excluded ? `Clear filter for "${tag}"` : `Exclude "${tag}" instead`}
        onclick={() => cycleTagFilter(tag)}
      >
        <span aria-hidden="true">{excluded ? '−' : '+'}</span>
        {tag}
      </button>
    {/each}
  </div>
  {#if filter.kind === 'tags' && filter.includeTags.size >= 2}
    <label class="match-mode">
      Match
      <select value={filter.matchAll ? 'all' : 'any'} onchange={toggleTagMatchMode}>
        <option value="all">All tags</option>
        <option value="any">Any tag</option>
      </select>
    </label>
  {/if}
  {#if activeTags.length || filter.kind === 'untagged'}
    <button class="quiet-button" onclick={clearTagFilter}>Clear filters</button>
  {/if}
</div>
