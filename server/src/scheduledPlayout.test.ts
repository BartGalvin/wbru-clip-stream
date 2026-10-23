import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClipRef, RecentPlayout } from '../../shared/contract';
import { getChannel, listChannels, listScheduledTargets } from './config/channels';
import { UNKNOWN_CLIP_DURATION_SEC } from './config/playoutPolicy';
import { SCHEDULED_PLAYOUT_RETRY_MS, startScheduledPlayouts } from './scheduledPlayout';

const NOW = Date.parse('2026-08-29T17:00:00Z');

function clip(channelId: string, position: number, durationSec = 0): ClipRef {
  return {
    clipId: `${channelId}-${position}`,
    title: `${channelId} ${position}`,
    url: `/clips/${channelId}-${position}.mp4`,
    durationSec,
    cursor: String(position),
    tags: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduled playouts', () => {
  it('derives its outputs from channels with a server timeline', () => {
    expect(listScheduledTargets()).toEqual(
      listChannels()
        .filter((channel) => channel.timeline === 'server')
        .map((channel) => ({
          channelId: channel.id,
          outputId: getChannel(channel.id)?.serverTimelineOutputId,
        })),
    );
  });

  it('records all server-owned channels and advances on the fallback cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const nextPosition = new Map<string, number>();
    const record = vi.fn(() => true);
    const stop = startScheduledPlayouts({
      latestPlayout: () => null,
      nextClip: (channelId) => {
        const position = (nextPosition.get(channelId) ?? 0) + 1;
        nextPosition.set(channelId, position);
        return clip(channelId, position);
      },
      record,
    });

    expect(record).toHaveBeenCalledTimes(3);
    expect(record).toHaveBeenCalledWith(
      'indie-server',
      'indie',
      expect.objectContaining({ clipId: 'indie-1' }),
    );
    expect(record).toHaveBeenCalledWith(
      '360-server',
      '360',
      expect.objectContaining({ clipId: '360-1' }),
    );
    expect(record).toHaveBeenCalledWith(
      'wbru-tv',
      'wbru-tv',
      expect.objectContaining({ clipId: 'wbru-tv-1' }),
    );

    await vi.advanceTimersByTimeAsync(UNKNOWN_CLIP_DURATION_SEC * 1_000);
    expect(record).toHaveBeenCalledTimes(6);
    stop();
  });

  it('resumes after the remaining duration of the latest stored event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const latest = (outputId: string): RecentPlayout => ({
      id: 1,
      outputId,
      channelId:
        outputId === 'indie-server' ? 'indie' : outputId === '360-server' ? '360' : 'wbru-tv',
      clipId: `${outputId}-previous`,
      cursor: 'previous',
      title: 'Previous',
      path: 'previous.mp4',
      library: 'visualizer',
      source: null,
      previewUrl: '/clips/previous.mp4',
      durationSec: 20,
      startedAt: '2026-08-29T16:59:55.000Z',
    });
    const record = vi.fn(() => true);
    const stop = startScheduledPlayouts({
      latestPlayout: latest,
      nextClip: (channelId, after) => {
        expect(after).toBe('previous');
        return clip(channelId, 2, 20);
      },
      record,
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(record).toHaveBeenCalledTimes(3);
    stop();
  });

  it('retries an empty channel and cancels pending work when stopped', async () => {
    vi.useFakeTimers();
    const nextClip = vi.fn(() => null);
    const record = vi.fn(() => true);
    const stop = startScheduledPlayouts({
      latestPlayout: () => null,
      nextClip,
      record,
    });

    expect(nextClip).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(SCHEDULED_PLAYOUT_RETRY_MS);
    expect(nextClip).toHaveBeenCalledTimes(6);
    expect(record).not.toHaveBeenCalled();

    stop();
    await vi.advanceTimersByTimeAsync(SCHEDULED_PLAYOUT_RETRY_MS * 2);
    expect(nextClip).toHaveBeenCalledTimes(6);
  });
});
