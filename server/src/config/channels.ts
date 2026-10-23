import type { AudioSource, ChannelInfo, ChannelProgram } from '../../../shared/contract';
import { VISUALIZER_LIBRARY, WBRU_YOUTUBE_LIBRARY } from '../../../shared/libraries';

// Channels without a radio endpoint play video without external audio.
const indieUrl = process.env.RADIO_INDIE_URL?.trim();
const m360Url = process.env.RADIO_360_URL?.trim();
const INDIE_AUDIO: Readonly<AudioSource> = indieUrl
  ? { kind: 'icecast', url: indieUrl }
  : { kind: 'none' };
const M360_AUDIO: Readonly<AudioSource> = m360Url
  ? { kind: 'icecast', url: m360Url }
  : { kind: 'none' };

// Server-owned channel entry, including whether it belongs in public channel lists.
interface Channel {
  readonly id: string;
  readonly name: string;
  readonly viewerFacing: boolean;
  readonly program: Readonly<ChannelProgram>;
  readonly serverTimelineOutputId?: string;
  readonly titleOutputId?: string;
  readonly live?: Readonly<ChannelProgram>;
}

const CHANNELS: readonly Channel[] = [
  {
    id: 'all',
    name: 'All',
    viewerFacing: false,
    program: {
      video: {
        kind: 'clips',
        library: VISUALIZER_LIBRARY.id,
        filter: { includeTags: [], excludeTags: [], matchAll: false },
      },
      audio: INDIE_AUDIO,
    },
  },
  {
    id: 'indie',
    name: 'WBRU Indie',
    viewerFacing: true,
    serverTimelineOutputId: 'indie-server',
    program: {
      video: {
        kind: 'clips',
        library: VISUALIZER_LIBRARY.id,
        filter: { includeTags: [], excludeTags: ['360'], matchAll: false },
      },
      audio: INDIE_AUDIO,
    },
  },
  {
    id: '360',
    name: 'WBRU 360',
    viewerFacing: true,
    serverTimelineOutputId: '360-server',
    program: {
      video: {
        kind: 'clips',
        library: VISUALIZER_LIBRARY.id,
        filter: { includeTags: [], excludeTags: ['retro'], matchAll: false },
      },
      audio: M360_AUDIO,
    },
  },
  {
    id: 'wbru-tv',
    name: 'WBRU TV',
    viewerFacing: true,
    serverTimelineOutputId: 'wbru-tv',
    titleOutputId: 'wbru-tv',
    program: {
      video: {
        kind: 'clips',
        library: WBRU_YOUTUBE_LIBRARY.id,
        filter: { includeTags: [], excludeTags: [], matchAll: false },
      },
      audio: { kind: 'embedded' },
    },
  },
];

// Resolve both viewer-facing channels and internal defaults such as "all."
export function getChannel(id: string): Channel | undefined {
  return CHANNELS.find((channel) => channel.id === id);
}

// Strip server-only configuration before returning a channel to clients.
export function channelInfo(channel: Channel): ChannelInfo {
  return {
    id: channel.id,
    name: channel.name,
    program: channel.program,
    ...(channel.serverTimelineOutputId ? { timeline: 'server' as const } : {}),
    ...(channel.titleOutputId ? { titleOutputId: channel.titleOutputId } : {}),
    ...(channel.live ? { live: channel.live } : {}),
  };
}

// Public channel lists omit internal defaults used only by the API.
export function listChannels(): ChannelInfo[] {
  return CHANNELS.filter((channel) => channel.viewerFacing).map(channelInfo);
}

// Each configured server output gets one clip schedule.
export function listScheduledTargets(): { channelId: string; outputId: string }[] {
  return CHANNELS.flatMap((channel) =>
    channel.serverTimelineOutputId
      ? [{ channelId: channel.id, outputId: channel.serverTimelineOutputId }]
      : [],
  );
}
