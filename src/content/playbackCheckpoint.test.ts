import { describe, expect, it } from 'vitest';
import type { ClipRef } from '../../shared/contract';
import type { TagFilter } from '../../shared/tagFilter';
import { createPlaybackCheckpointStore } from './playbackCheckpoint';

function filter(include: string[] = []): TagFilter {
  return {
    includeTags: new Set(include),
    excludeTags: new Set(),
    matchAll: false,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const clip: ClipRef = {
  clipId: 'clip-12',
  title: 'Clip 12',
  url: '/clips/12.mp4',
  durationSec: 30,
  cursor: 'cursor-12',
  tags: ['indie'],
};

describe('playback checkpoint storage', () => {
  it('restores the clip and playback time for the same channel and filter', () => {
    const storage = memoryStorage();
    createPlaybackCheckpointStore('indie', filter(['indie']), storage).save({
      clip,
      timeSec: 12.8,
    });
    expect(createPlaybackCheckpointStore('indie', filter(['indie']), storage).load()).toEqual({
      clip,
      timeSec: 12,
    });
  });

  it('keeps channels and filters independent', () => {
    const storage = memoryStorage();
    createPlaybackCheckpointStore('indie', filter(), storage).save({ clip, timeSec: 1 });
    createPlaybackCheckpointStore('360', filter(), storage).save({ clip, timeSec: 2 });
    createPlaybackCheckpointStore('indie', filter(['cartoon']), storage).save({
      clip,
      timeSec: 3,
    });

    expect(createPlaybackCheckpointStore('indie', filter(), storage).load()?.timeSec).toBe(1);
    expect(createPlaybackCheckpointStore('360', filter(), storage).load()?.timeSec).toBe(2);
    expect(
      createPlaybackCheckpointStore('indie', filter(['cartoon']), storage).load()?.timeSec,
    ).toBe(3);
  });

  it('uses a canonical key for tag sets regardless of insertion order', () => {
    const storage = memoryStorage();
    createPlaybackCheckpointStore('indie', filter(['b', 'a']), storage).save({
      clip,
      timeSec: 4,
    });
    expect(
      createPlaybackCheckpointStore('indie', filter(['a', 'b']), storage).load()?.clip,
    ).toEqual(clip);
  });

  it('ignores malformed saved data', () => {
    const storage = memoryStorage();
    storage.setItem(
      'wbru:clip-playback:v2:{"channelId":"indie","include":[],"exclude":[],"matchAll":false}',
      '{"clip":{"url":"/clips/12.mp4"},"timeSec":"yesterday"}',
    );
    expect(createPlaybackCheckpointStore('indie', filter(), storage).load()).toBeNull();
  });
});
