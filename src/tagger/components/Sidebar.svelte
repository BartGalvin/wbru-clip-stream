<script lang="ts">
  import {
    getLibraryFolders,
    getLibraryClipCount,
    getTaggedClipCount,
    countClipsUsingTag,
    taggerState,
    type LibraryFolder,
  } from '../taggerState.svelte';
  import {
    addVocabularyTag,
    deleteVocabularyTag,
    selectFolder,
    cycleTagFilter,
  } from '../taggerActions';

  const { onNavigate = () => {} }: { onNavigate?: () => void } = $props();
  let newTagName = $state('');
  let isManagingTags = $state(false);

  async function submitNewTag(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (await addVocabularyTag(newTagName)) newTagName = '';
  }
</script>

{#snippet folderBranch(folders: LibraryFolder[])}
  <ul class="folder-tree">
    {#each folders as folder (folder.path)}
      <li>
        {#if folder.children.length}
          <details>
            <summary
              class="folder"
              class:active={taggerState.activeFolderPath === folder.path}
              aria-current={taggerState.activeFolderPath === folder.path ? 'location' : undefined}
              title={folder.path}
              onclick={() => selectFolder(folder.path)}
            >
              <span class="folder-content">
                <span class="folder-label">{folder.label}</span>
                <span class="count">{folder.count.toLocaleString()}</span>
              </span>
            </summary>
            {@render folderBranch(folder.children)}
          </details>
        {:else}
          <button
            class="folder"
            class:active={taggerState.activeFolderPath === folder.path}
            aria-pressed={taggerState.activeFolderPath === folder.path}
            title={folder.path}
            onclick={() => {
              selectFolder(folder.path);
              onNavigate();
            }}
          >
            <span class="folder-label">{folder.label}</span>
            <span class="count">{folder.count.toLocaleString()}</span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<aside class="sidebar" id="catalog-sidebar" aria-label="Browse clips">
  <section class="library-summary">
    <div class="section-heading"><h2>Library</h2></div>
    <span class="count"
      >{getTaggedClipCount().toLocaleString()} / {getLibraryClipCount().toLocaleString()} tagged</span
    >
    <progress
      value={getTaggedClipCount()}
      max={Math.max(1, getLibraryClipCount())}
      aria-label="Tagged clips"
    ></progress>
  </section>

  <nav class="folders" aria-label="Folders">
    <div class="section-heading"><h2>Folders</h2></div>
    <details open>
      <summary
        class="folder"
        class:active={taggerState.activeFolderPath === null}
        aria-current={taggerState.activeFolderPath === null ? 'location' : undefined}
        onclick={() => selectFolder(null)}
      >
        <span class="folder-content">
          <span class="folder-label">All folders</span>
          <span class="count">{getLibraryClipCount().toLocaleString()}</span>
        </span>
      </summary>
      {#key taggerState.activeLibraryId}
        {@render folderBranch(getLibraryFolders())}
      {/key}
    </details>
  </nav>

  <section class="vocabulary">
    <div class="section-heading">
      <h2>Tags</h2>
      <button
        class="quiet-button"
        aria-pressed={isManagingTags}
        onclick={() => (isManagingTags = !isManagingTags)}
      >
        {isManagingTags ? 'Done' : 'Manage'}
      </button>
    </div>
    {#if isManagingTags}
      <form class="new-tag" onsubmit={submitNewTag}>
        <label class="sr-only" for="new-tag">New tag</label>
        <input id="new-tag" bind:value={newTagName} placeholder="New tag..." />
        <button type="submit" disabled={taggerState.pendingSaveCount > 0 || !newTagName.trim()}
          >Add</button
        >
      </form>
    {/if}
    {#each taggerState.tagVocabulary as tag}
      {@const filter = taggerState.clipFilter}
      {@const included = filter.kind === 'tags' && filter.includeTags.has(tag)}
      {@const excluded = filter.kind === 'tags' && filter.excludeTags.has(tag)}
      {@const usageCount = countClipsUsingTag(tag)}
      <div class="vocabulary-item" data-tag={tag}>
        <button
          class="tag-filter"
          class:included
          class:excluded
          aria-pressed={included || excluded}
          title={included
            ? `Exclude "${tag}"`
            : excluded
              ? `Clear filter for "${tag}"`
              : `Include "${tag}"`}
          onclick={() => cycleTagFilter(tag)}
        >
          <span class="filter-indicator" aria-hidden="true"
            >{included ? '+' : excluded ? '−' : ''}</span
          >
          <span class="tag-name">{tag}</span>
          <span class="count">{usageCount.toLocaleString()}</span>
        </button>
        {#if isManagingTags}
          <button
            class="icon-button delete-tag"
            disabled={taggerState.pendingSaveCount > 0}
            aria-label={`Delete "${tag}"`}
            title={`Delete "${tag}" from ${usageCount} clips`}
            onclick={() => void deleteVocabularyTag(tag, usageCount)}>×</button
          >
        {/if}
      </div>
    {/each}
  </section>
</aside>
