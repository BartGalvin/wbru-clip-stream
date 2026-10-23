import {
  fetchPlayoutChannels,
  fetchPlayoutPage,
  PLAYOUT_LOOKBACK_MS,
  PLAYOUT_PAGE_SIZE,
  type PlayoutChannel,
  type PlayoutPage,
} from './playoutLog';

const SEARCH_DELAY_MS = 250;
const LIVE_POLL_INTERVAL_MS = 5_000;
const LIVE_POLL_LIMIT = 1_000;

// One channel's loaded rows, older-page cursor, and pending-page status.
interface ChannelPage extends PlayoutPage {
  loading: boolean;
}

// Owns one log page's history, search, and live polling.
export function createPlayoutState(view: {
  isLivePaused: () => boolean;
  onRefresh: (loadedAt: Date, until: string | null) => void;
}) {
  const state = $state({
    channels: [] as PlayoutChannel[],
    channelPages: {} as Record<string, ChannelPage>,
    loadedAt: null as Date | null,
    isLoading: true,
    isRefreshing: false,
    loadError: '',
    search: '',
    activeSearch: '',
    activeUntil: null as string | null,
  });
  const isLoadingMore = $derived(Object.values(state.channelPages).some((page) => page.loading));
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let latestSeenId = 0;
  let livePollInFlight = false;
  // Replacing the search or time window cancels all requests for the previous view.
  let requestController: AbortController | null = null;

  async function refresh(until: string | null = state.activeUntil): Promise<void> {
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
    }
    requestController?.abort();
    for (const page of Object.values(state.channelPages)) page.loading = false;
    const controller = new AbortController();
    requestController = controller;
    const requestedSearch = state.search.trim();
    const now = Date.now();
    if (!state.isLoading) state.isRefreshing = true;
    state.loadError = '';
    try {
      const requestedChannels = state.channels.length
        ? state.channels
        : await fetchPlayoutChannels({ signal: controller.signal });
      if (controller.signal.aborted) return;
      // Capture the live cursor before loading columns so intervening plays are not skipped.
      const latest = until
        ? null
        : await fetchPlayoutPage({
            limit: 1,
            signal: controller.signal,
            nowMs: now,
          });
      if (controller.signal.aborted) return;
      const pages = await Promise.all(
        requestedChannels.map((channel) =>
          fetchPlayoutPage({
            channelId: channel.id,
            search: requestedSearch,
            signal: controller.signal,
            nowMs: now,
            until: until ?? undefined,
          }),
        ),
      );
      if (controller.signal.aborted) return;
      state.channelPages = Object.fromEntries(
        requestedChannels.map((channel, index) => [
          channel.id,
          { ...pages[index], loading: false },
        ]),
      );
      state.channels = requestedChannels;
      state.activeSearch = requestedSearch;
      state.activeUntil = until;
      latestSeenId = latest?.items[0]?.id ?? 0;
      state.loadedAt = new Date(now);
      view.onRefresh(state.loadedAt, until);
    } catch (error) {
      if (controller.signal.aborted) return;
      state.loadError = error instanceof Error ? error.message : 'playout history request failed';
    } finally {
      if (!controller.signal.aborted) {
        state.isLoading = false;
        state.isRefreshing = false;
      }
    }
  }

  async function loadNewEvents(): Promise<void> {
    if (
      state.search.trim() ||
      state.activeSearch ||
      state.activeUntil ||
      view.isLivePaused() ||
      state.isLoading ||
      state.isRefreshing ||
      livePollInFlight ||
      isLoadingMore ||
      !requestController
    ) {
      return;
    }
    if (!state.loadedAt) {
      await refresh();
      return;
    }

    const controller = requestController;
    const now = Date.now();
    livePollInFlight = true;
    try {
      const page = await fetchPlayoutPage({
        afterId: latestSeenId,
        limit: LIVE_POLL_LIMIT,
        signal: controller.signal,
        nowMs: now,
      });
      // Reading history or opening a preview also pauses a poll already in flight.
      if (
        controller.signal.aborted ||
        state.search.trim() ||
        view.isLivePaused() ||
        isLoadingMore
      ) {
        return;
      }

      latestSeenId = Math.max(latestSeenId, ...page.items.map((item) => item.id));
      for (const channel of state.channels) {
        const current = state.channelPages[channel.id];
        const knownIds = new Set(current.items.map((item) => item.id));
        const additions = page.items.filter(
          (item) => item.channelId === channel.id && !knownIds.has(item.id),
        );
        const merged = [...additions, ...current.items]
          .filter((item) => Date.parse(item.startedAt) >= now - PLAYOUT_LOOKBACK_MS)
          .sort((a, b) => b.id - a.id);
        const items = merged.slice(0, PLAYOUT_PAGE_SIZE);
        // Polling keeps one page per channel; scrolling can still reach the trimmed rows.
        state.channelPages[channel.id] = {
          items,
          nextBeforeId: merged.length > items.length ? items.at(-1)?.id : current.nextBeforeId,
          loading: false,
        };
      }
      state.loadedAt = new Date(now);
      state.loadError = '';
    } catch (error) {
      if (controller.signal.aborted) return;
      state.loadError = error instanceof Error ? error.message : 'playout history request failed';
    } finally {
      livePollInFlight = false;
    }
  }

  function updateSearch(value: string): void {
    state.search = value;
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      void refresh();
    }, SEARCH_DELAY_MS);
  }

  // Each column advances its own cursor within the current search and time window.
  async function loadMore(channelId: string): Promise<void> {
    const page = state.channelPages[channelId];
    if (
      state.isRefreshing ||
      !page ||
      page.loading ||
      page.nextBeforeId === undefined ||
      !state.loadedAt ||
      !requestController
    ) {
      return;
    }
    const controller = requestController;
    state.channelPages[channelId] = { ...page, loading: true };
    state.loadError = '';
    try {
      const next = await fetchPlayoutPage({
        channelId,
        beforeId: page.nextBeforeId,
        search: state.activeSearch,
        signal: controller.signal,
        nowMs: state.loadedAt.getTime(),
        until: state.activeUntil ?? undefined,
      });
      if (controller.signal.aborted) return;
      const current = state.channelPages[channelId];
      const knownIds = new Set(current.items.map((item) => item.id));
      state.channelPages[channelId] = {
        items: [...current.items, ...next.items.filter((item) => !knownIds.has(item.id))],
        nextBeforeId: next.nextBeforeId,
        loading: false,
      };
    } catch (error) {
      if (controller.signal.aborted) return;
      state.channelPages[channelId] = { ...state.channelPages[channelId], loading: false };
      state.loadError = error instanceof Error ? error.message : 'playout history request failed';
    }
  }

  function start(): () => void {
    void refresh();
    const livePollTimer = setInterval(() => void loadNewEvents(), LIVE_POLL_INTERVAL_MS);
    return () => {
      requestController?.abort();
      if (searchTimer !== undefined) clearTimeout(searchTimer);
      clearInterval(livePollTimer);
    };
  }

  return {
    state,
    get isLoadingMore() {
      return isLoadingMore;
    },
    refresh,
    updateSearch,
    loadMore,
    start,
  };
}
