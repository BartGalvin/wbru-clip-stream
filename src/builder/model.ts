import {
  activeProgram,
  getClipFilter,
  isStationAudio,
  type ChannelInfo,
  type TaggableClip,
} from '../../shared/contract';
import { isClipEligibleForRotation } from '../../shared/libraries';
import {
  effectiveFilter,
  encodeTagFilter,
  isEmptyTagFilter,
  matchesTagFilter,
  sameTagFilter,
  type TagFilter,
} from '../../shared/tagFilter';

// Per-tag choice made by the operator; absence represents a neutral tag.
export type TagChoice = 'include' | 'exclude';

// Channel defaults relevant to the builder's available controls and clip counts.
interface ChannelSelection {
  defaultFilter: TagFilter | null;
  library: string | null;
  audioAvailable: boolean;
}

// Complete derived view of the current builder selections.
interface BuilderModel {
  selectedFilter: TagFilter;
  effectiveFilter: TagFilter | null;
  selectedLibrary: string | null;
  audioAvailable: boolean;
  matchCount: number;
  availableCount: number;
  isUnfiltered: boolean;
}

export function nextTagChoice(choice: TagChoice | undefined): TagChoice | undefined {
  if (choice === undefined) return 'include';
  if (choice === 'include') return 'exclude';
  return undefined;
}

function filterFromChoices(
  tagChoices: ReadonlyMap<string, TagChoice>,
  matchAll: boolean,
): TagFilter {
  const includeTags = new Set<string>();
  const excludeTags = new Set<string>();
  for (const [tag, choice] of tagChoices) {
    (choice === 'include' ? includeTags : excludeTags).add(tag);
  }
  return { includeTags, excludeTags, matchAll };
}

// Resolve a channel into the library, default filter, and audio controls the builder can offer.
export function getChannelSelection(
  channels: readonly ChannelInfo[],
  channelId: string,
  defaultChannel: ChannelInfo | null,
): ChannelSelection {
  const channel = channelId
    ? channels.find((candidate) => candidate.id === channelId)
    : defaultChannel;
  if (!channel) {
    return {
      defaultFilter: null,
      library: null,
      audioAvailable: false,
    };
  }

  const program = activeProgram(channel);
  return {
    defaultFilter: getClipFilter(program.video),
    library: program.video.kind === 'clips' ? program.video.library : null,
    audioAvailable: isStationAudio(program.audio),
  };
}

// Combine channel defaults with operator choices and count the resulting catalog matches.
export function calculateBuilderModel(input: {
  channelId: string;
  channels: readonly ChannelInfo[];
  defaultChannel: ChannelInfo | null;
  matchAll: boolean;
  tagChoices: ReadonlyMap<string, TagChoice>;
  clips: readonly TaggableClip[];
}): BuilderModel {
  const selectedFilter = filterFromChoices(input.tagChoices, input.matchAll);
  const channel = getChannelSelection(input.channels, input.channelId, input.defaultChannel);
  const currentFilter =
    channel.defaultFilter === null ? null : effectiveFilter(channel.defaultFilter, selectedFilter);
  const libraryClips =
    channel.library === null
      ? []
      : input.clips.filter(
          (clip) => clip.library === channel.library && isClipEligibleForRotation(clip),
        );
  const matchCount =
    currentFilter === null
      ? 0
      : libraryClips.filter((clip) => matchesTagFilter(clip.tags, currentFilter)).length;

  return {
    selectedFilter,
    effectiveFilter: currentFilter,
    selectedLibrary: channel.library,
    audioAvailable: channel.audioAvailable,
    matchCount,
    availableCount: libraryClips.length,
    isUnfiltered: currentFilter !== null && isEmptyTagFilter(currentFilter),
  };
}

// Encode only choices that affect playback into a shareable stream URL.
export function buildStreamUrl(input: {
  origin: string;
  channels: readonly ChannelInfo[];
  defaultChannel: ChannelInfo | null;
  selectedFilter: TagFilter;
  channelId: string;
  includeAudio: boolean;
  audioAvailable: boolean;
}): string {
  const { defaultFilter } = getChannelSelection(
    input.channels,
    input.channelId,
    input.defaultChannel,
  );
  const usesDefaults =
    isEmptyTagFilter(input.selectedFilter) ||
    (defaultFilter !== null && sameTagFilter(input.selectedFilter, defaultFilter));
  const params = usesDefaults ? new URLSearchParams() : encodeTagFilter(input.selectedFilter);
  if (input.channelId) params.set('channel', input.channelId);
  if (input.includeAudio && input.audioAvailable) params.set('audio', '1');
  const query = params.toString();
  return `${input.origin}/stream.html${query ? `?${query}` : ''}`;
}
