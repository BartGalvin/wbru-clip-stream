<script lang="ts">
  import { onMount } from 'svelte';
  import type { RecentPlayout } from '../../shared/contract';
  import { routes } from '../../shared/routes';
  import { PLAYOUT_LOOKBACK_MS } from './playoutLog';
  import { createPlayoutState } from './playoutState.svelte';
  import ResizeHandle from '../components/ResizeHandle.svelte';

  const dayFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  const rangeFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let browseDate = $state(localDateValue(new Date()));
  let browseTime = $state('');
  let logGrid = $state<HTMLDivElement>();
  let selectedEvent = $state<RecentPlayout | null>(null);
  let previewFailed = $state(false);
  let inactive = $state(false);
  let savingClipId = $state<string | null>(null);
  let inactiveError = $state('');
  let viewportWidth = $state(1280);
  let viewportHeight = $state(800);
  let previewWidth = $state(400);
  let previewHeight = $state<number | null>(null);
  const isStacked = $derived(viewportWidth <= 1050);
  // Leave room for the log's three columns when expanding the desktop preview.
  const maxPreviewWidth = $derived(Math.max(280, Math.min(800, viewportWidth - 760)));
  const visiblePreviewWidth = $derived(Math.min(previewWidth, maxPreviewWidth));
  const defaultPreviewHeight = $derived(Math.round(viewportHeight * 0.35));
  const maxPreviewHeight = $derived(Math.floor(viewportHeight * 0.7));
  const minPreviewHeight = $derived(Math.min(160, maxPreviewHeight));
  const visiblePreviewHeight = $derived(
    Math.max(minPreviewHeight, Math.min(previewHeight ?? defaultPreviewHeight, maxPreviewHeight)),
  );
  const playout = createPlayoutState({
    isLivePaused: () =>
      selectedEvent !== null ||
      [...(logGrid?.querySelectorAll<HTMLElement>('.event-list') ?? [])].some(
        (list) => list.scrollTop > 0,
      ),
    onRefresh: (loadedAt, until) => {
      selectedEvent = null;
      inactiveError = '';
      if (!until) {
        browseDate = localDateValue(loadedAt);
        browseTime = '';
      }
      for (const list of logGrid?.querySelectorAll<HTMLElement>('.event-list') ?? []) {
        list.scrollTop = 0;
      }
    },
  });
  const { state: log } = playout;
  const selectedPage = $derived(
    selectedEvent ? log.channelPages[selectedEvent.channelId] : undefined,
  );
  const selectedIndex = $derived(
    selectedPage?.items.findIndex((event) => event.id === selectedEvent?.id) ?? -1,
  );
  const canGoBack = $derived(
    selectedIndex >= 0 && !!(selectedPage?.items[selectedIndex + 1] || selectedPage?.nextBeforeId),
  );
  const oldestDate = $derived(
    localDateValue(new Date((log.loadedAt?.getTime() ?? Date.now()) - PLAYOUT_LOOKBACK_MS)),
  );
  const newestDate = $derived(localDateValue(log.loadedAt ?? new Date()));

  // Keep the selected row visible while stepping through history.
  $effect(() => {
    if (selectedEvent) {
      logGrid
        ?.querySelector(`[data-event-id="${selectedEvent.id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  });

  const localDayKey = (value: string): string => new Date(value).toDateString();

  const formatDuration = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Duration unavailable';
    const totalSeconds = Math.round(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    return `${minutes}:${remainder.toString().padStart(2, '0')}`;
  };

  const rangeLabel = (): string => {
    const now = log.loadedAt ?? new Date();
    const end = log.activeUntil
      ? new Date(Math.min(Date.parse(log.activeUntil), now.getTime()))
      : now;
    return `${rangeFormatter.format(new Date(now.getTime() - PLAYOUT_LOOKBACK_MS))} to ${rangeFormatter.format(end)}`;
  };

  // Date inputs use local calendar dates; API requests use UTC timestamps.
  function localDateValue(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // A date without a time includes the whole day.
  function jumpToTime(): void {
    if (!browseDate) return;
    const until = new Date(`${browseDate}T${browseTime || '23:59:59'}`);
    void playout.refresh(until.toISOString());
  }

  // Move by calendar day so the chosen clock time survives daylight-saving changes.
  function moveDay(offset: number): void {
    const day = new Date(`${browseDate}T12:00:00`);
    day.setDate(day.getDate() + offset);
    browseDate = localDateValue(day);
    jumpToTime();
  }

  function preview(event: RecentPlayout): void {
    selectedEvent = event;
    previewFailed = false;
    inactive = event.inactive;
    inactiveError = '';
  }

  // Save the tag while allowing the preview to move to another clip.
  async function saveInactive(enabled: boolean): Promise<void> {
    const current = selectedEvent;
    if (!current) return;
    savingClipId = current.clipId;
    inactiveError = '';
    try {
      const saved = await playout.setInactive(current.clipId, enabled);
      if (selectedEvent?.clipId === current.clipId) {
        selectedEvent.inactive = saved;
        inactive = saved;
      }
    } catch (error) {
      inactiveError = `${current.title || current.clipId}: ${error instanceof Error ? error.message : 'Tag update failed.'}`;
      if (selectedEvent?.clipId === current.clipId) inactive = current.inactive;
    } finally {
      savingClipId = null;
    }
  }

  function clearPreview(): void {
    logGrid
      ?.querySelector<HTMLButtonElement>('.event-preview.selected')
      ?.focus({ preventScroll: true });
    selectedEvent = null;
  }

  function resizePreview(size: number): void {
    if (isStacked) previewHeight = size;
    else previewWidth = size;
  }

  // Rows are newest first, so moving back in time steps down the channel's list.
  async function movePreview(direction: 'earlier' | 'later'): Promise<void> {
    const current = selectedEvent;
    if (!current || !selectedPage) return;
    const index = selectedIndex + (direction === 'earlier' ? 1 : -1);
    if (index === selectedPage.items.length && selectedPage.nextBeforeId !== undefined) {
      await playout.loadMore(current.channelId);
    }
    if (selectedEvent !== current) return;
    const next = log.channelPages[current.channelId].items[index];
    if (next) preview(next);
  }

  // Request the next page as a column approaches the bottom.
  function loadMoreNearBottom(channelId: string, element: HTMLElement): void {
    if (element.scrollTop + element.clientHeight < element.scrollHeight - 400) return;
    void playout.loadMore(channelId);
  }

  onMount(playout.start);
</script>

<svelte:head>
  <meta name="theme-color" content="#0f1217" />
</svelte:head>

<svelte:window
  bind:innerWidth={viewportWidth}
  bind:innerHeight={viewportHeight}
  onkeydown={(event) => {
    if (event.key === 'Escape' && selectedEvent && !event.defaultPrevented) clearPreview();
  }}
/>

<div
  class="page-shell"
  style:--preview-width={`${visiblePreviewWidth}px`}
  style:--preview-height={`${visiblePreviewHeight}px`}
>
  <header class="page-header">
    <div>
      <p class="eyebrow"><span aria-hidden="true"></span> WBRU playout</p>
      <h1>Playout log</h1>
      <p class="range">{rangeLabel()}</p>
    </div>
    <div class="header-actions">
      <input
        class="search"
        type="search"
        aria-label="Search playout history"
        placeholder="Search title, filename, or source..."
        value={log.search}
        oninput={(event) => playout.updateSearch(event.currentTarget.value)}
      />
      {#if log.loadedAt}
        <p class="updated" aria-live="polite">Updated {timeFormatter.format(log.loadedAt)}</p>
      {/if}
      <button
        class="icon-button"
        type="button"
        title="Refresh log"
        aria-label="Refresh log"
        disabled={log.isLoading || log.isRefreshing || playout.isLoadingMore}
        onclick={() => playout.refresh()}
      >
        &#x21bb;
      </button>
    </div>
  </header>

  <form
    class="time-navigation"
    onsubmit={(event) => {
      event.preventDefault();
      jumpToTime();
    }}
  >
    <button
      type="button"
      class="icon-button"
      title="Previous day"
      aria-label="Previous day"
      disabled={log.isLoading || log.isRefreshing || !browseDate || browseDate <= oldestDate}
      onclick={() => moveDay(-1)}>&larr;</button
    >
    <label
      >Date <input
        type="date"
        bind:value={browseDate}
        min={oldestDate}
        max={newestDate}
        required
      /></label
    >
    <button
      type="button"
      class="icon-button"
      title="Next day"
      aria-label="Next day"
      disabled={log.isLoading || log.isRefreshing || !browseDate || browseDate >= newestDate}
      onclick={() => moveDay(1)}>&rarr;</button
    >
    <label>Time <input type="time" bind:value={browseTime} /></label>
    <button type="submit" disabled={log.isLoading || log.isRefreshing}>Go</button>
    <button
      type="button"
      class:active={log.activeUntil === null}
      aria-pressed={log.activeUntil === null}
      disabled={log.isLoading || log.isRefreshing}
      onclick={() => playout.refresh(null)}>Live</button
    >
    <span class="time-zone">{timeZone}</span>
  </form>

  {#if log.loadError}
    <div class="notice error" role="alert">
      <strong>Could not load playout history.</strong>
      <span>{log.loadError}</span>
    </div>
  {/if}

  {#if inactiveError}
    <div class="notice error" role="alert">
      <strong>Could not update clip.</strong>
      <span>{inactiveError}</span>
    </div>
  {/if}

  {#if log.isLoading}
    <div class="loading-state" aria-live="polite">Loading playout history...</div>
  {:else}
    <div class="log-grid" bind:this={logGrid}>
      {#each log.channels as channel (channel.id)}
        {@const page = log.channelPages[channel.id]}
        {@const items = page.items}
        <section
          class="log-card"
          style={`--channel-accent: ${channel.accent}`}
          aria-labelledby={`${channel.id}-heading`}
        >
          <header class="card-header">
            <div>
              <span class="channel-dot" aria-hidden="true"></span>
              <h2 id={`${channel.id}-heading`}>{channel.name}</h2>
            </div>
            <span class="count"
              >{items.length}{page.nextBeforeId !== undefined ? '+' : ''}
              {items.length === 1 ? 'play' : 'plays'}</span
            >
          </header>

          {#if items.length}
            <ol
              class="event-list"
              onscroll={(event) => loadMoreNearBottom(channel.id, event.currentTarget)}
            >
              {#each items as event, index (event.id)}
                {#if index === 0 || localDayKey(event.startedAt) !== localDayKey(items[index - 1].startedAt)}
                  <li class="day-divider">{dayFormatter.format(new Date(event.startedAt))}</li>
                {/if}
                <li class="event-row">
                  <button
                    class="event-preview"
                    type="button"
                    data-event-id={event.id}
                    class:selected={selectedEvent?.id === event.id}
                    aria-label={`Preview ${event.title || 'Untitled clip'}`}
                    aria-controls="clip-preview"
                    aria-pressed={selectedEvent?.id === event.id}
                    onclick={() => preview(event)}
                  >
                    <time datetime={event.startedAt}
                      >{timeFormatter.format(new Date(event.startedAt))}</time
                    >
                    <span class="event-content">
                      <span class="event-thumbnail" aria-hidden="true">
                        <span>No image</span>
                        <img
                          src={`${routes.tagsThumbnails}/${encodeURIComponent(event.clipId)}.jpg`}
                          alt=""
                          width="320"
                          height="180"
                          loading="lazy"
                          decoding="async"
                          onerror={(event) =>
                            ((event.currentTarget as HTMLImageElement).hidden = true)}
                        />
                      </span>
                      <span class="event-details">
                        <strong>{event.title || 'Untitled clip'}</strong>
                        <span class="path" title={event.path}>{event.path}</span>
                        {#if event.source}
                          <span class="source" title={event.source}>Source: {event.source}</span>
                        {/if}
                        <span class="event-meta">
                          <span>{formatDuration(event.durationSec)}</span>
                          <span class="output">{event.outputId}</span>
                          {#if event.inactive}<span class="inactive-badge">Inactive</span>{/if}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="empty">
              {log.activeSearch
                ? `No plays match "${log.activeSearch}".`
                : 'No recorded plays in this window.'}
            </p>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
  <ResizeHandle
    class="preview-resize-handle"
    label="Resize preview"
    panelId="clip-preview"
    orientation={isStacked ? 'horizontal' : 'vertical'}
    size={isStacked ? visiblePreviewHeight : visiblePreviewWidth}
    minSize={isStacked ? minPreviewHeight : 280}
    maxSize={isStacked ? maxPreviewHeight : maxPreviewWidth}
    defaultSize={isStacked ? defaultPreviewHeight : 400}
    reverse
    onresize={resizePreview}
  />

  <aside class="clip-preview" id="clip-preview" aria-labelledby="preview-heading">
    <header class="preview-header">
      <h2 id="preview-heading">Clip preview</h2>
      <div class="preview-actions">
        <button
          type="button"
          class="icon-button"
          title="Previous clip (earlier play)"
          aria-label="Previous clip"
          disabled={log.isRefreshing || selectedPage?.loading || !canGoBack}
          onclick={() => movePreview('earlier')}>&larr;</button
        >
        <button
          type="button"
          class="icon-button"
          title="Next clip (later play)"
          aria-label="Next clip"
          disabled={log.isRefreshing || selectedPage?.loading || selectedIndex <= 0}
          onclick={() => movePreview('later')}>&rarr;</button
        >
      </div>
    </header>
    {#if selectedEvent}
      {#key selectedEvent.id}
        {#if selectedEvent.previewUrl && !previewFailed}
          <video
            src={selectedEvent.previewUrl}
            controls
            muted
            playsinline
            preload="metadata"
            onerror={() => (previewFailed = true)}
          ></video>
        {:else}
          <p class="preview-unavailable">
            {previewFailed ? 'Could not load this clip.' : 'Clip no longer available.'}
          </p>
        {/if}
      {/key}
      <h3 aria-live="polite">{selectedEvent.title || 'Untitled clip'}</h3>
      <p class="preview-path">{selectedEvent.path}</p>
      <label class="inactive-control">
        <input
          type="checkbox"
          bind:checked={inactive}
          disabled={savingClipId !== null || selectedEvent.previewUrl === null}
          onchange={(event) => void saveInactive(event.currentTarget.checked)}
        />
        Inactive
        {#if savingClipId === selectedEvent.clipId}<span role="status">Saving...</span>{/if}
      </label>
      <dl>
        <dt>Logged</dt>
        <dd>{rangeFormatter.format(new Date(selectedEvent.startedAt))}</dd>
        <dt>Channel</dt>
        <dd>
          {log.channels.find((channel) => channel.id === selectedEvent?.channelId)?.name ??
            selectedEvent.channelId}
        </dd>
        <dt>Duration</dt>
        <dd>{formatDuration(selectedEvent.durationSec)}</dd>
        {#if selectedEvent.source}<dt>Source</dt>
          <dd>{selectedEvent.source}</dd>{/if}
      </dl>
    {:else}
      <p class="preview-unavailable">No clip selected.</p>
    {/if}
  </aside>
</div>
