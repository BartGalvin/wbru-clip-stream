import { describe, expect, it } from 'vitest';
import { activeProgram, isStationAudio, type ChannelInfo } from './contract';

const channel: ChannelInfo = {
  id: 'indie',
  name: 'Indie',
  program: {
    video: {
      kind: 'clips',
      library: 'visualizer',
      filter: { includeTags: ['indie'], excludeTags: [], matchAll: false },
    },
    audio: { kind: 'icecast', url: 'https://example.com/radio' },
  },
};

describe('channel programs', () => {
  it('uses the normal program until a live replacement is present', () => {
    expect(activeProgram(channel)).toBe(channel.program);
    const live = {
      video: { kind: 'hls' as const, url: 'https://example.com/live.m3u8' },
      audio: { kind: 'embedded' as const },
    };
    expect(activeProgram({ ...channel, live })).toBe(live);
  });

  it('distinguishes station streams from embedded and silent audio', () => {
    expect(isStationAudio({ kind: 'icecast', url: 'https://example.com/radio' })).toBe(true);
    expect(isStationAudio({ kind: 'hls', url: 'https://example.com/radio.m3u8' })).toBe(true);
    expect(isStationAudio({ kind: 'embedded' })).toBe(false);
    expect(isStationAudio({ kind: 'none' })).toBe(false);
  });
});
