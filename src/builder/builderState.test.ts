import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInfo, TaggableClip } from '../../shared/contract';
import { routes } from '../../shared/routes';
import { listChannels } from '../../server/src/config/channels';
import {
  availableCount,
  builder,
  cycleTagChoice,
  hasAudio,
  isUnfiltered,
  load,
  matchCount,
  selectedFilter,
  selectChannel,
  streamUrl,
} from './builderState.svelte';

function clip(id: string, library: string, tags: string[]): TaggableClip {
  return {
    id,
    title: id,
    url: `/clips/${id}.mp4`,
    path: `${id}.mp4`,
    library,
    tags,
    source: null,
  };
}

beforeEach(() => {
  builder.channelId = '';
  builder.defaultChannel = {
    id: 'all',
    name: 'All',
    program: {
      video: {
        kind: 'clips',
        library: 'visualizer',
        filter: { includeTags: [], excludeTags: [], matchAll: false },
      },
      audio: { kind: 'icecast', url: 'https://audio.example/listen' },
    },
  };
  builder.channels = [
    {
      id: 'indie',
      name: 'WBRU Indie',
      program: {
        video: {
          kind: 'clips',
          library: 'visualizer',
          filter: { includeTags: ['indie'], excludeTags: [], matchAll: false },
        },
        audio: { url: 'http://audio', kind: 'icecast' },
      },
    },
    {
      id: 'wbru-tv',
      name: 'WBRU TV',
      program: {
        video: {
          kind: 'clips',
          library: 'wbru-youtube',
          filter: { includeTags: [], excludeTags: [], matchAll: false },
        },
        audio: { url: 'http://audio', kind: 'icecast' },
      },
    },
    {
      id: 'live',
      name: 'A live feed',
      program: {
        video: { kind: 'hls', url: 'http://feed.m3u8' },
        audio: { kind: 'embedded' },
      },
    },
  ];
  builder.matchAll = false;
  builder.audio = false;
  builder.loading = false;
  builder.loadError = '';
  builder.tagChoices.clear();
  builder.vocab = ['360', 'bw', 'indie'];
  builder.clips = [
    clip('one', 'visualizer', ['360']),
    clip('two', 'visualizer', ['360', 'bw']),
    clip('three', 'visualizer', ['indie', 'bw']),
    clip('four', 'wbru-youtube', ['indie']),
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('builder state transitions', () => {
  it('offers default radio audio on initial selection and after returning from a channel', () => {
    expect(hasAudio()).toBe(true);
    expect(streamUrl()).toBe('/stream.html');
    builder.audio = true;
    expect(streamUrl()).toBe('/stream.html?audio=1');

    selectChannel('live');
    expect(hasAudio()).toBe(false);
    expect(streamUrl()).toBe('/stream.html?channel=live');

    selectChannel('');
    expect(hasAudio()).toBe(true);
    expect(matchCount()).toBe(3);
    expect(availableCount()).toBe(3);
    expect(streamUrl()).toBe('/stream.html?audio=1');
  });

  it('cycles a selected tag through include, exclude, and off', () => {
    cycleTagChoice('360');
    expect([...selectedFilter().includeTags]).toEqual(['360']);

    cycleTagChoice('360');
    expect([...selectedFilter().excludeTags]).toEqual(['360']);

    cycleTagChoice('360');
    expect(isUnfiltered()).toBe(true);
  });

  it('seeds channel defaults as editable choices', () => {
    selectChannel('indie');
    expect([...selectedFilter().includeTags]).toEqual(['indie']);
    expect(matchCount()).toBe(1);
    expect(isUnfiltered()).toBe(false);
    expect(streamUrl()).toBe('/stream.html?channel=indie');

    cycleTagChoice('bw');
    expect(matchCount()).toBe(2);
    expect(streamUrl()).toContain('include=indie%2Cbw');
  });

  it('restores the channel default after all editable choices are cleared', () => {
    selectChannel('indie');
    cycleTagChoice('indie');
    cycleTagChoice('indie');

    expect(selectedFilter().includeTags.size).toBe(0);
    expect(matchCount()).toBe(1);
    expect(streamUrl()).toBe('/stream.html?channel=indie');
  });

  it('omits unchanged defaults for the configured named streams', () => {
    builder.channels = listChannels();
    for (const channel of builder.channels) {
      selectChannel(channel.id);
      expect(streamUrl()).toBe(`/stream.html?channel=${channel.id}`);
    }
  });

  it('returns to a clean URL when edited choices match the channel again', () => {
    selectChannel('indie');
    cycleTagChoice('bw');
    cycleTagChoice('bw');
    expect(streamUrl()).toContain('exclude=bw');
    cycleTagChoice('bw');
    expect(streamUrl()).toBe('/stream.html?channel=indie');
  });

  it('keeps channel libraries and non-clip programs distinct', () => {
    selectChannel('wbru-tv');
    expect(availableCount()).toBe(1);
    expect(matchCount()).toBe(1);

    selectChannel('live');
    expect(availableCount()).toBe(0);
    expect(matchCount()).toBe(0);
  });

  it('offers and encodes audio only for station-audio channels', () => {
    selectChannel('live');
    builder.audio = true;
    expect(hasAudio()).toBe(false);
    expect(streamUrl()).not.toContain('audio=1');

    selectChannel('indie');
    expect(hasAudio()).toBe(true);
    expect(streamUrl()).toContain('channel=indie');
    expect(streamUrl()).toContain('audio=1');
  });
});

describe('builder loading', () => {
  const defaultChannel: ChannelInfo = {
    id: 'server-default',
    name: 'Server default',
    program: {
      video: {
        kind: 'clips',
        library: 'visualizer',
        filter: { includeTags: ['360', 'bw'], excludeTags: ['indie'], matchAll: true },
      },
      audio: { kind: 'hls', url: 'https://audio.example/live.m3u8' },
    },
  };

  beforeEach(() => {
    const payloads = new Map<string, unknown>([
      [routes.tagsVocab, builder.vocab],
      [routes.tagsClips, builder.clips],
      [routes.channels, builder.channels],
      [routes.channel, defaultChannel],
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => Response.json(payloads.get(url))),
    );
    builder.defaultChannel = null;
  });

  it('loads and seeds the actual default without adding it to the channel list or URL', async () => {
    await load();

    expect(fetch).toHaveBeenCalledWith(routes.channel);
    expect(builder.defaultChannel).toEqual(defaultChannel);
    expect(builder.channels.map((channel) => channel.id)).toEqual(['indie', 'wbru-tv', 'live']);
    expect(builder.channelId).toBe('');
    expect(builder.matchAll).toBe(true);
    expect([...selectedFilter().includeTags]).toEqual(['360', 'bw']);
    expect([...selectedFilter().excludeTags]).toEqual(['indie']);
    expect(matchCount()).toBe(1);
    expect(availableCount()).toBe(3);
    expect(hasAudio()).toBe(true);
    expect(streamUrl()).toBe('/stream.html');
    expect(builder.loading).toBe(false);
    expect(builder.loadError).toBe('');

    cycleTagChoice('bw');
    expect(streamUrl()).toBe('/stream.html?include=360&exclude=bw%2Cindie&match=all');
    selectChannel('indie');
    selectChannel('');
    expect([...selectedFilter().includeTags]).toEqual(['360', 'bw']);
    expect(matchCount()).toBe(1);
    expect(streamUrl()).toBe('/stream.html');
  });

  it.each([
    ['', '/stream.html?include=indie%2Cbw&audio=1'],
    ['indie', '/stream.html?include=indie%2Cbw&channel=indie&audio=1'],
  ])(
    'preserves edited choices for channel "%s" when loading the default',
    async (channelId, url) => {
      selectChannel(channelId);
      if (!channelId) cycleTagChoice('indie');
      cycleTagChoice('bw');
      builder.audio = true;

      await load();

      expect(builder.channelId).toBe(channelId);
      expect([...selectedFilter().includeTags]).toEqual(['indie', 'bw']);
      expect(builder.matchAll).toBe(false);
      expect(matchCount()).toBe(2);
      expect(streamUrl()).toBe(url);
    },
  );

  it('reports a default-channel failure without inventing defaults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === routes.channel ? new Response(null, { status: 503 }) : Response.json([]),
      ),
    );

    await load();

    expect(builder.loading).toBe(false);
    expect(builder.loadError).toBe(`${routes.channel} -> 503`);
    expect(builder.defaultChannel).toBeNull();
    expect(hasAudio()).toBe(false);
    expect(availableCount()).toBe(0);
    expect(matchCount()).toBe(0);
  });
});
