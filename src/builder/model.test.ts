import { describe, expect, it } from 'vitest';
import type { ChannelInfo, TaggableClip } from '../../shared/contract';
import { fromTagFilterJson } from '../../shared/tagFilter';
import { buildStreamUrl, calculateBuilderModel, nextTagChoice, type TagChoice } from './model';

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

const defaultChannel: ChannelInfo = {
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

const channels: ChannelInfo[] = [
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
      audio: { url: 'http://audio', kind: 'hls' },
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

const clips = [
  clip('one', 'visualizer', ['360']),
  clip('two', 'visualizer', ['360', 'bw']),
  clip('three', 'visualizer', ['indie', 'bw']),
  clip('four', 'wbru-youtube', ['indie']),
];

function calculate(
  tagChoices: ReadonlyMap<string, TagChoice>,
  options: { channelId?: string; matchAll?: boolean; defaultChannel?: ChannelInfo | null } = {},
) {
  return calculateBuilderModel({
    channelId: options.channelId ?? '',
    channels,
    defaultChannel: options.defaultChannel === undefined ? defaultChannel : options.defaultChannel,
    matchAll: options.matchAll ?? false,
    tagChoices,
    clips,
  });
}

describe('builder model', () => {
  it('cycles tag choices in order', () => {
    expect(nextTagChoice(undefined)).toBe('include');
    expect(nextTagChoice('include')).toBe('exclude');
    expect(nextTagChoice('exclude')).toBeUndefined();
  });

  it('offers the default channel audio without adding a channel URL parameter', () => {
    const model = calculate(new Map());
    expect(model.audioAvailable).toBe(true);
    expect(model.selectedLibrary).toBe('visualizer');
    expect(model.matchCount).toBe(3);
    expect(model.availableCount).toBe(3);
    expect(model.isUnfiltered).toBe(true);
    expect(
      buildStreamUrl({
        origin: 'https://stream.example',
        channels,
        defaultChannel,
        selectedFilter: model.selectedFilter,
        channelId: '',
        includeAudio: true,
        audioAvailable: model.audioAvailable,
      }),
    ).toBe('https://stream.example/stream.html?audio=1');
  });

  it('uses the returned default channel active program for counts and URL defaults', () => {
    const filter = { includeTags: ['indie'], excludeTags: ['bw'], matchAll: false };
    const currentDefault: ChannelInfo = {
      ...defaultChannel,
      id: 'server-default',
      live: {
        video: { kind: 'clips', library: 'wbru-youtube', filter },
        audio: { kind: 'embedded' },
      },
    };
    const model = calculate(new Map(), { defaultChannel: currentDefault });
    expect(model.selectedLibrary).toBe('wbru-youtube');
    expect(model.availableCount).toBe(1);
    expect(model.matchCount).toBe(1);
    expect(model.audioAvailable).toBe(false);
    expect(model.isUnfiltered).toBe(false);
    expect(model.effectiveFilter).toEqual(fromTagFilterJson(filter));
    expect(
      calculate(new Map([['bw', 'include']]), { defaultChannel: currentDefault }).matchCount,
    ).toBe(0);
    expect(
      buildStreamUrl({
        origin: 'https://stream.example',
        channels,
        defaultChannel: currentDefault,
        selectedFilter: fromTagFilterJson(filter),
        channelId: '',
        includeAudio: true,
        audioAvailable: model.audioAvailable,
      }),
    ).toBe('https://stream.example/stream.html');
  });

  it('does not invent a clip program before the default channel is loaded', () => {
    const model = calculate(new Map(), { defaultChannel: null });
    expect(model.selectedLibrary).toBeNull();
    expect(model.effectiveFilter).toBeNull();
    expect(model.availableCount).toBe(0);
    expect(model.matchCount).toBe(0);
    expect(model.audioAvailable).toBe(false);
  });

  it.each<ChannelInfo['program']['video']>([
    { kind: 'hls', url: 'https://video.example/live.m3u8' },
    { kind: 'youtube', playlistId: 'test-playlist' },
  ])('keeps a silent $kind default outside the clip library', (video) => {
    const model = calculate(new Map(), {
      defaultChannel: {
        ...defaultChannel,
        live: { video, audio: { kind: 'none' } },
      },
    });
    expect(model.selectedLibrary).toBeNull();
    expect(model.effectiveFilter).toBeNull();
    expect(model.availableCount).toBe(0);
    expect(model.matchCount).toBe(0);
    expect(model.audioAvailable).toBe(false);
  });

  it('calculates match-any, match-all, and excluded-tag counts', () => {
    expect(calculate(new Map()).matchCount).toBe(3);
    expect(calculate(new Map([['360', 'include']])).matchCount).toBe(2);
    expect(
      calculate(
        new Map([
          ['360', 'include'],
          ['bw', 'include'],
        ]),
      ).matchCount,
    ).toBe(3);
    expect(
      calculate(
        new Map([
          ['360', 'include'],
          ['bw', 'include'],
        ]),
        { matchAll: true },
      ).matchCount,
    ).toBe(1);
    expect(
      calculate(
        new Map([
          ['360', 'include'],
          ['bw', 'exclude'],
        ]),
      ).matchCount,
    ).toBe(1);
  });

  it('uses a channel default only when no editable filter is selected', () => {
    expect(calculate(new Map(), { channelId: 'indie' }).matchCount).toBe(1);
    expect(calculate(new Map([['bw', 'include']]), { channelId: 'indie' }).matchCount).toBe(2);
  });

  it('calculates the selected library and rejects non-clip programs', () => {
    const tv = calculate(new Map(), { channelId: 'wbru-tv' });
    expect(tv.selectedLibrary).toBe('wbru-youtube');
    expect(tv.availableCount).toBe(1);
    expect(tv.matchCount).toBe(1);

    const live = calculate(new Map(), { channelId: 'live' });
    expect(live.selectedLibrary).toBeNull();
    expect(live.availableCount).toBe(0);
    expect(live.matchCount).toBe(0);
  });

  it('counts only playable clips without changing the catalog', () => {
    const catalog = [
      clip('untagged', 'visualizer', []),
      clip('inactive', 'visualizer', ['inactive']),
      clip('tv', 'wbru-youtube', []),
      clip('inactive-tv', 'wbru-youtube', ['inactive']),
    ];
    const input = {
      channels,
      defaultChannel,
      clips: catalog,
      matchAll: false,
      tagChoices: new Map(),
    };
    const visualizer = calculateBuilderModel({ ...input, channelId: '' });
    expect(visualizer.matchCount).toBe(0);
    expect(visualizer.availableCount).toBe(0);
    expect(calculateBuilderModel({ ...input, channelId: 'wbru-tv' }).matchCount).toBe(1);
    expect(catalog).toHaveLength(4);
  });

  it('builds a stream URL from the injected origin and editable choices', () => {
    const selectedFilter = calculate(
      new Map([
        ['indie', 'include'],
        ['bw', 'include'],
      ]),
    ).selectedFilter;

    expect(
      buildStreamUrl({
        origin: 'https://stream.example',
        channels,
        defaultChannel,
        selectedFilter,
        channelId: 'indie',
        includeAudio: true,
        audioAvailable: true,
      }),
    ).toBe('https://stream.example/stream.html?include=indie%2Cbw&channel=indie&audio=1');
    expect(
      buildStreamUrl({
        origin: 'https://stream.example',
        channels,
        defaultChannel,
        selectedFilter,
        channelId: 'live',
        includeAudio: true,
        audioAvailable: false,
      }),
    ).not.toContain('audio=1');
  });
});
