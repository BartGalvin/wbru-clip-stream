import {
  PLAYOUT_RETENTION_DAYS,
  type ChannelInfo,
  type ClipTagUpdate,
  type RecentPlayout,
} from '../../shared/contract';
import { routes } from '../../shared/routes';

export const PLAYOUT_PAGE_SIZE = 100;
export const PLAYOUT_LOOKBACK_MS = PLAYOUT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Change only the inactive tag and return its stored state.
export async function setClipInactive(
  clipId: string,
  inactive: boolean,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(`${routes.tagsClips}/${encodeURIComponent(clipId)}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag: 'inactive', enabled: inactive }),
  });
  if (!response.ok) throw new Error(`Tag update failed (${response.status}).`);
  const clip = (await response.json()) as ClipTagUpdate;
  return clip.tags.includes('inactive');
}

const CHANNEL_ACCENTS = ['#49d6a2', '#f1b85b', '#a995ff', '#68b8f7'] as const;

// Display details for one server-timed channel in the playout log.
export interface PlayoutChannel {
  id: string;
  name: string;
  accent: string;
}

// One bounded history page and the cursor for its next page.
export interface PlayoutPage {
  items: RecentPlayout[];
  nextBeforeId?: number;
}

// Build the log's channel list from public server configuration.
export async function fetchPlayoutChannels(
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  } = {},
): Promise<PlayoutChannel[]> {
  const { signal, fetcher = fetch } = options;
  const response = await fetcher(routes.channels, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`channel list request failed (${response.status})`);

  return ((await response.json()) as ChannelInfo[])
    .filter((channel) => channel.timeline === 'server')
    .map((channel, index) => ({
      id: channel.id,
      name: channel.name,
      accent: CHANNEL_ACCENTS[index % CHANNEL_ACCENTS.length],
    }));
}

// Fetch one history page within the retained log window, optionally ending at a chosen time.
// With afterId, events arrive oldest first so each poll continues where the last ended.
export async function fetchPlayoutPage(options: {
  channelId?: string;
  beforeId?: number;
  afterId?: number;
  limit?: number;
  search?: string;
  until?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  nowMs?: number;
}): Promise<PlayoutPage> {
  const {
    channelId,
    beforeId,
    afterId,
    limit = PLAYOUT_PAGE_SIZE,
    search,
    until,
    signal,
    fetcher = fetch,
    nowMs = Date.now(),
  } = options;
  const params = new URLSearchParams({
    limit: String(limit),
    since: new Date(nowMs - PLAYOUT_LOOKBACK_MS).toISOString(),
  });
  if (channelId !== undefined) params.set('channel', channelId);
  if (beforeId !== undefined) params.set('beforeId', String(beforeId));
  if (afterId !== undefined) params.set('afterId', String(afterId));
  if (until !== undefined) params.set('until', until);
  if (search?.trim()) params.set('q', search.trim());

  const response = await fetcher(`${routes.tagsPlayout}?${params}`, {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`playout history request failed (${response.status})`);
  const items = (await response.json()) as RecentPlayout[];
  return {
    items,
    ...(afterId === undefined && items.length === limit
      ? { nextBeforeId: items[items.length - 1].id }
      : {}),
  };
}
