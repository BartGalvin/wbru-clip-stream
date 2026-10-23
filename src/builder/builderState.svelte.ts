import { SvelteMap } from 'svelte/reactivity';
import type { ChannelInfo, TaggableClip } from '../../shared/contract';
import type { TagFilter } from '../../shared/tagFilter';
import { fetchBuilderData } from './api';
import {
  buildStreamUrl,
  calculateBuilderModel,
  nextTagChoice,
  getChannelSelection,
  type TagChoice,
} from './model';

export const builder = $state({
  channelId: '',
  channels: [] as ChannelInfo[],
  defaultChannel: null as ChannelInfo | null,
  matchAll: false,
  audio: false,
  tagChoices: new SvelteMap<string, TagChoice>(),
  vocab: [] as string[],
  clips: [] as TaggableClip[],
  loading: true,
  loadError: '',
});

// Derive counts and effective filtering from the current builder controls.
const model = $derived.by(() =>
  calculateBuilderModel({
    channelId: builder.channelId,
    channels: builder.channels,
    defaultChannel: builder.defaultChannel,
    matchAll: builder.matchAll,
    tagChoices: builder.tagChoices,
    clips: builder.clips,
  }),
);

const origin = typeof location === 'undefined' ? '' : location.origin;
const url = $derived.by(() =>
  buildStreamUrl({
    origin,
    channels: builder.channels,
    defaultChannel: builder.defaultChannel,
    selectedFilter: model.selectedFilter,
    channelId: builder.channelId,
    includeAudio: builder.audio,
    audioAvailable: model.audioAvailable,
  }),
);

// Cycle a tag through neutral, included, and excluded states.
export function cycleTagChoice(tag: string): void {
  const nextChoice = nextTagChoice(builder.tagChoices.get(tag));
  if (nextChoice === undefined) builder.tagChoices.delete(tag);
  else builder.tagChoices.set(tag, nextChoice);
}

// Reset ad hoc choices to the newly selected channel's defaults.
export function selectChannel(id: string): void {
  const channel = getChannelSelection(builder.channels, id, builder.defaultChannel);
  builder.channelId = id;
  builder.tagChoices.clear();
  builder.matchAll = channel.defaultFilter?.matchAll ?? false;
  if (channel.defaultFilter) {
    for (const tag of channel.defaultFilter.includeTags) {
      builder.tagChoices.set(tag, 'include');
    }
    for (const tag of channel.defaultFilter.excludeTags) {
      builder.tagChoices.set(tag, 'exclude');
    }
  }
}

export function selectedFilter(): TagFilter {
  return model.selectedFilter;
}

export function hasAudio(): boolean {
  return model.audioAvailable;
}

export function streamUrl(): string {
  return url;
}

export function matchCount(): number {
  return model.matchCount;
}

export function availableCount(): number {
  return model.availableCount;
}

export function isUnfiltered(): boolean {
  return model.isUnfiltered;
}

// Load the channels, clips, and tags used by the builder.
export async function load(): Promise<void> {
  builder.loading = true;
  builder.loadError = '';
  try {
    const data = await fetchBuilderData();
    builder.vocab = data.vocab;
    builder.clips = data.clips;
    builder.channels = data.channels;
    builder.defaultChannel = data.defaultChannel;
    if (!builder.channelId && builder.tagChoices.size === 0) selectChannel('');
  } catch (error) {
    builder.loadError = error instanceof Error ? error.message : String(error);
  } finally {
    builder.loading = false;
  }
}
