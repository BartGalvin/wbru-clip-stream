<script lang="ts">
  import { getClipLibraries, taggerState } from './taggerState.svelte';
  import { selectLibrary, setFilenameSearch } from './taggerActions';
  import Sidebar from './components/Sidebar.svelte';
  import ClipList from './components/ClipList.svelte';
  import PreviewPane from './components/PreviewPane.svelte';
  import ResizeHandle from './components/ResizeHandle.svelte';

  let isSidebarOpen = $state(false);
  let layoutWidth = $state(0);
  let sidebarWidth = $state(220);
  let previewWidth = $state(340);
  // Reserve 400px for the clip list on desktop.
  const desktopColumnMax = $derived(Math.floor(((layoutWidth || 1280) - 400) / 2));
  const sidebarMax = $derived(Math.max(160, desktopColumnMax));
  const previewMax = $derived(
    Math.max(240, layoutWidth > 960 ? desktopColumnMax : Math.floor((layoutWidth || 1280) * 0.4)),
  );
  const visibleSidebarWidth = $derived(Math.min(sidebarWidth, sidebarMax));
  const visiblePreviewWidth = $derived(Math.min(previewWidth, previewMax));
</script>

<header class="app-header">
  <button
    class="browse-toggle"
    aria-expanded={isSidebarOpen}
    aria-controls="catalog-sidebar"
    onclick={() => (isSidebarOpen = !isSidebarOpen)}>Browse</button
  >
  <h1>Clip Tagger</h1>
  <div class="segmented-control library-switch" role="group" aria-label="Clip library">
    {#each getClipLibraries() as library}
      <button
        type="button"
        class:active={taggerState.activeLibraryId === library.id}
        title={`${library.count} clip${library.count === 1 ? '' : 's'}`}
        aria-pressed={taggerState.activeLibraryId === library.id}
        onclick={() => selectLibrary(library.id)}
      >
        {library.name}
      </button>
    {/each}
  </div>
  <label class="sr-only" for="filename-search">Filter by filename</label>
  <input
    id="filename-search"
    type="search"
    placeholder="Filter by filename..."
    value={taggerState.filenameSearch}
    oninput={(event) => setFilenameSearch(event.currentTarget.value.trim())}
  />
  <span class="status-message" role="status">{taggerState.statusMessage}</span>
</header>

{#if taggerState.loadError}
  <div class="error">{taggerState.loadError}</div>
{/if}

<div
  class="layout"
  class:sidebar-open={isSidebarOpen}
  bind:clientWidth={layoutWidth}
  style:--sidebar-width={`${visibleSidebarWidth}px`}
  style:--preview-width={`${visiblePreviewWidth}px`}
>
  <Sidebar onNavigate={() => (isSidebarOpen = false)} />
  <ResizeHandle
    label="Resize folders"
    panelId="catalog-sidebar"
    width={visibleSidebarWidth}
    minWidth={160}
    maxWidth={sidebarMax}
    defaultWidth={220}
    onresize={(width) => (sidebarWidth = width)}
  />
  <ClipList />
  <ResizeHandle
    label="Resize preview"
    panelId="clip-preview"
    width={visiblePreviewWidth}
    minWidth={240}
    maxWidth={previewMax}
    defaultWidth={340}
    reverse
    onresize={(width) => (previewWidth = width)}
  />
  <PreviewPane />
</div>
