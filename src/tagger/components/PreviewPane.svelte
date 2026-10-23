<script lang="ts">
  import {
    getAvailableClipSources,
    getFocusedClip,
    getVisibleClips,
    taggerState,
  } from '../taggerState.svelte';
  import { focusClip, setClipSource, toggleClipTag } from '../taggerActions';
  import { getClipFilename } from '../tags';

  const clip = $derived(getFocusedClip());
  const visibleClips = $derived(getVisibleClips());
  const clipIndex = $derived(visibleClips.findIndex((item) => item.id === clip?.id));
  const previousClip = $derived(clipIndex > 0 ? visibleClips[clipIndex - 1] : null);
  const nextClip = $derived(clipIndex >= 0 ? visibleClips[clipIndex + 1] : null);
  const editableTags = $derived([
    ...new Set([...taggerState.tagVocabulary, ...(clip?.tags ?? [])]),
  ]);
  let draftClipId = $state<string | null>(null);
  let sourceBaseline = $state('');
  let sourceDraft = $state('');

  // Follow focus and server changes without overwriting an in-progress source edit.
  $effect(() => {
    const nextClipId = clip?.id ?? null;
    const nextSource = clip?.source ?? '';
    if (nextClipId !== draftClipId) {
      draftClipId = nextClipId;
      sourceBaseline = nextSource;
      sourceDraft = nextSource;
    } else if (nextSource !== sourceBaseline) {
      if (sourceDraft === sourceBaseline) sourceDraft = nextSource;
      sourceBaseline = nextSource;
    }
  });

  // Adopt the saved source only when the operator has not typed a newer draft.
  async function saveSource(source: string | null): Promise<void> {
    const target = clip;
    if (!target) return;
    const submittedDraft = sourceDraft;
    const saved = await setClipSource(target, source);
    if (saved && clip?.id === target.id && sourceDraft === submittedDraft) {
      sourceBaseline = target.source ?? '';
      sourceDraft = sourceBaseline;
    }
  }

  function onSourceSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void saveSource(sourceDraft);
  }
</script>

<aside id="clip-preview" class="preview" class:has-clip={clip !== null} aria-label="Clip details">
  <div class="section-heading preview-heading">
    <h2>Clip details</h2>
    <div class="preview-navigation">
      <button
        class="icon-button"
        disabled={!previousClip}
        aria-label="Previous clip"
        title="Previous clip"
        onclick={() => previousClip && focusClip(previousClip.id)}>←</button
      >
      <button
        class="icon-button"
        disabled={!nextClip}
        aria-label="Next clip"
        title="Next clip"
        onclick={() => nextClip && focusClip(nextClip.id)}>→</button
      >
      <button
        class="icon-button close-preview"
        aria-label="Close clip details"
        title="Close clip details"
        onclick={() => (taggerState.focusedClipId = null)}>×</button
      >
    </div>
  </div>
  {#if clip}
    <video src={clip.url} loop muted playsinline controls autoplay></video>
    <h3 class="clip-title">{getClipFilename(clip)}</h3>
    <div class="clip-path">{clip.path}</div>
    <fieldset class="clip-tags" disabled={taggerState.pendingSaveCount > 0}>
      <legend>Tags</legend>
      {#each editableTags as tag}
        <label class="tag-option">
          <input
            type="checkbox"
            checked={clip.tags.includes(tag)}
            onchange={() => clip && void toggleClipTag(clip, tag)}
          />
          <span>{tag}</span>
        </label>
      {/each}
    </fieldset>
    <form class="source-editor" onsubmit={onSourceSubmit}>
      <label for="clip-source">Source</label>
      <input
        id="clip-source"
        list="clip-source-options"
        placeholder="No source"
        bind:value={sourceDraft}
      />
      <datalist id="clip-source-options">
        {#each getAvailableClipSources() as source}
          <option value={source}></option>
        {/each}
      </datalist>
      <div class="source-actions">
        <button
          type="submit"
          class="primary-button"
          disabled={taggerState.pendingSaveCount > 0 || sourceDraft === sourceBaseline}
          >Save source</button
        >
        <button
          type="button"
          disabled={taggerState.pendingSaveCount > 0 || (!clip.source && !sourceDraft)}
          onclick={() => void saveSource(null)}>Clear</button
        >
      </div>
    </form>
  {:else}
    <div class="preview-empty">No clip selected</div>
  {/if}
</aside>
