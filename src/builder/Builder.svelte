<script lang="ts">
  import { onMount } from 'svelte';
  import {
    builder,
    availableCount,
    cycleTagChoice,
    hasAudio,
    isUnfiltered,
    load,
    matchCount,
    selectedFilter,
    selectChannel,
    streamUrl,
  } from './builderState.svelte';

  let copyStatus: 'ready' | 'copied' | 'error' = $state('ready');
  let copyStatusTimeout: ReturnType<typeof setTimeout> | undefined;

  function clearCopyStatusTimeout(): void {
    if (copyStatusTimeout !== undefined) clearTimeout(copyStatusTimeout);
    copyStatusTimeout = undefined;
  }

  async function copyUrl(): Promise<void> {
    clearCopyStatusTimeout();
    copyStatus = 'ready';
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(streamUrl());
      copyStatus = 'copied';
      copyStatusTimeout = setTimeout(() => {
        copyStatus = 'ready';
        copyStatusTimeout = undefined;
      }, 1200);
    } catch {
      copyStatus = 'error';
    }
  }

  // Matching all tags has no effect until at least two tags are included.
  const matchAllUnavailable = $derived(selectedFilter().includeTags.size < 2);

  onMount(() => {
    void load();
    return clearCopyStatusTimeout;
  });
</script>

<header>
  <h1>Stream builder</h1>
  <p class="sub">Pick tags to choose what plays, then point OBS at the generated URL.</p>
</header>

{#if builder.loading}
  <p class="status">Loading tags...</p>
{:else if builder.loadError}
  <p class="status error">
    Couldn't reach the tag API ({builder.loadError}). Is the program server running?
  </p>
{:else}
  <section class="controls">
    <label class="field">
      <span>Channel</span>
      <select value={builder.channelId} onchange={(e) => selectChannel(e.currentTarget.value)}>
        <option value="">(default: {builder.defaultChannel?.name})</option>
        {#each builder.channels as channel}
          <option value={channel.id}>{channel.name}</option>
        {/each}
      </select>
    </label>
    <label class="field check" class:muted={matchAllUnavailable}>
      <input type="checkbox" bind:checked={builder.matchAll} />
      <span>Match <strong>all</strong> included tags (default: any)</span>
    </label>
    {#if hasAudio()}
      <label class="field check">
        <input type="checkbox" bind:checked={builder.audio} />
        <span>Include the channel's radio audio</span>
      </label>
    {/if}
  </section>

  <section class="pills" aria-label="Tags">
    {#if builder.vocab.length === 0}
      <p class="status">No tags in the vocabulary yet. Add some in the tagger.</p>
    {/if}
    {#each builder.vocab as tag}
      <button
        type="button"
        class="pill"
        class:on-include={builder.tagChoices.get(tag) === 'include'}
        class:on-exclude={builder.tagChoices.get(tag) === 'exclude'}
        onclick={() => cycleTagChoice(tag)}
      >
        {tag}
      </button>
    {/each}
  </section>

  <footer class="out">
    {#if matchCount() === 0}
      <div class="count warn">
        0 of {availableCount()} clips match. This stream would be empty.
      </div>
    {:else}
      <div class="count">
        ▶ {isUnfiltered()
          ? `all ${availableCount()} clips (no filter)`
          : `${matchCount()} of ${availableCount()} clips`} match
      </div>
    {/if}
    <div class="urlrow">
      <input class="url" type="text" readonly value={streamUrl()} />
      <a
        class="btn"
        class:disabled={matchCount() === 0}
        aria-disabled={matchCount() === 0}
        href={matchCount() === 0 ? undefined : streamUrl()}
        target="_blank"
        rel="noopener"
      >
        Open ▶
      </a>
      <button
        class="btn"
        class:copy-error={copyStatus === 'error'}
        type="button"
        aria-live="polite"
        onclick={copyUrl}
      >
        {copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Copy failed' : 'Copy'}
      </button>
    </div>
    <p class="hint">
      Click a tag once to <em class="i">include</em>, again to <em class="x">exclude</em>, again to
      clear.
    </p>
  </footer>
{/if}
