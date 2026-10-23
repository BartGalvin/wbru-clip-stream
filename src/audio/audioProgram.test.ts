import { afterEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
  attachHls: vi.fn(),
  HlsNotSupportedError: class HlsNotSupportedError extends Error {},
  playWithAudioFallback: vi.fn(),
}));

vi.mock('../media/playback', () => media);

import { createAudioProgram } from './audioProgram';

// Minimal audio element with observable playback and source-reset operations.
class FakeAudio extends EventTarget {
  preload = '';
  src = '';
  paused = false;
  currentTime = 0;
  load = vi.fn();
  pause = vi.fn();
  removeAttribute = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('createAudioProgram', () => {
  it('does not reconnect Icecast before playback starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.stubGlobal('window', { setInterval: globalThis.setInterval });
    const audio = new FakeAudio();
    vi.stubGlobal('document', { createElement: vi.fn(() => audio) });
    const program = createAudioProgram({
      kind: 'icecast',
      url: 'https://example.com/live.mp3',
    });

    audio.dispatchEvent(new Event('error'));

    expect(media.playWithAudioFallback).not.toHaveBeenCalled();
    expect(audio.load).not.toHaveBeenCalled();
    program.destroy();
  });

  it('replaces Icecast playback through the fallback and cancels it on destroy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.stubGlobal('window', { setInterval: globalThis.setInterval });
    const audio = new FakeAudio();
    vi.stubGlobal('document', { createElement: vi.fn(() => audio) });
    const firstDestroy = vi.fn();
    const reconnectDestroy = vi.fn();
    media.playWithAudioFallback
      .mockReturnValueOnce({ destroy: firstDestroy })
      .mockReturnValueOnce({ destroy: reconnectDestroy });
    const hooks = { onBlocked: vi.fn(), onResumed: vi.fn() };
    const program = createAudioProgram({
      kind: 'icecast',
      url: 'https://example.com/live.mp3',
    });

    await program.start(hooks);
    audio.dispatchEvent(new Event('error'));

    expect(firstDestroy).toHaveBeenCalledOnce();
    expect(media.playWithAudioFallback).toHaveBeenNthCalledWith(1, audio, hooks);
    expect(media.playWithAudioFallback).toHaveBeenNthCalledWith(2, audio, hooks);
    expect(audio.src).toBe('https://example.com/live.mp3?t=10000');

    program.destroy();
    program.destroy();

    expect(reconnectDestroy).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    audio.dispatchEvent(new Event('error'));
    expect(media.playWithAudioFallback).toHaveBeenCalledTimes(2);
  });

  it('reconnects HLS audio after a fatal stream error', async () => {
    vi.useFakeTimers();
    const callbacks: Array<(error: Error) => void> = [];
    const connectionDestroys = [vi.fn(), vi.fn()];
    const playbackDestroys = [vi.fn(), vi.fn()];
    media.attachHls.mockImplementation(
      (_audio: HTMLAudioElement, _url: string, onFatal: (error: Error) => void) => {
        callbacks.push(onFatal);
        return Promise.resolve({ destroy: connectionDestroys[callbacks.length - 1] });
      },
    );
    media.playWithAudioFallback.mockImplementation(() => ({
      destroy: playbackDestroys[media.playWithAudioFallback.mock.calls.length - 1],
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audio = new FakeAudio();
    vi.stubGlobal('document', { createElement: vi.fn(() => audio) });
    const program = createAudioProgram({
      kind: 'hls',
      url: 'https://example.com/live.m3u8',
    });

    await program.start();
    const error = new Error('stream failed');
    callbacks[0](error);
    callbacks[0](error);

    expect(connectionDestroys[0]).toHaveBeenCalledOnce();
    expect(playbackDestroys[0]).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('audio error:', error);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(media.attachHls).toHaveBeenCalledTimes(2);
    expect(media.playWithAudioFallback).toHaveBeenCalledTimes(2);

    program.destroy();
    program.destroy();
    expect(connectionDestroys[1]).toHaveBeenCalledOnce();
    expect(playbackDestroys[1]).toHaveBeenCalledOnce();
  });

  it('retries a transient HLS attachment failure', async () => {
    vi.useFakeTimers();
    const connectionDestroy = vi.fn();
    const playbackDestroy = vi.fn();
    media.attachHls
      .mockRejectedValueOnce(new Error('stream unavailable'))
      .mockResolvedValueOnce({ destroy: connectionDestroy });
    media.playWithAudioFallback.mockReturnValue({ destroy: playbackDestroy });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: vi.fn(() => new FakeAudio()) });
    const program = createAudioProgram({
      kind: 'hls',
      url: 'https://example.com/live.m3u8',
    });

    await program.start();
    expect(media.playWithAudioFallback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(media.attachHls).toHaveBeenCalledTimes(2);
    expect(media.playWithAudioFallback).toHaveBeenCalledOnce();

    program.destroy();
    expect(connectionDestroy).toHaveBeenCalledOnce();
    expect(playbackDestroy).toHaveBeenCalledOnce();
  });

  it('cancels a pending HLS retry on destroy', async () => {
    vi.useFakeTimers();
    let onFatal: ((error: Error) => void) | undefined;
    const connectionDestroy = vi.fn();
    const playbackDestroy = vi.fn();
    media.attachHls.mockImplementation(
      (_audio: HTMLAudioElement, _url: string, callback: (error: Error) => void) => {
        onFatal = callback;
        return Promise.resolve({ destroy: connectionDestroy });
      },
    );
    media.playWithAudioFallback.mockReturnValue({ destroy: playbackDestroy });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: vi.fn(() => new FakeAudio()) });
    const program = createAudioProgram({
      kind: 'hls',
      url: 'https://example.com/live.m3u8',
    });

    await program.start();
    onFatal?.(new Error('stream failed'));
    program.destroy();
    program.destroy();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(media.attachHls).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(connectionDestroy).toHaveBeenCalledOnce();
    expect(playbackDestroy).toHaveBeenCalledOnce();
  });

  it('shares one pending HLS attachment across overlapping starts', async () => {
    let resolveAttachment!: (handle: { destroy: () => void }) => void;
    media.attachHls.mockReturnValue(
      new Promise((resolve) => {
        resolveAttachment = resolve;
      }),
    );
    const connectionDestroy = vi.fn();
    const playbackDestroy = vi.fn();
    media.playWithAudioFallback.mockReturnValue({ destroy: playbackDestroy });
    vi.stubGlobal('document', { createElement: vi.fn(() => new FakeAudio()) });
    const program = createAudioProgram({
      kind: 'hls',
      url: 'https://example.com/live.m3u8',
    });

    const firstStart = program.start();
    const secondStart = program.start();
    expect(media.attachHls).toHaveBeenCalledOnce();

    resolveAttachment({ destroy: connectionDestroy });
    await Promise.all([firstStart, secondStart]);
    expect(media.playWithAudioFallback).toHaveBeenCalledOnce();

    program.destroy();
    expect(connectionDestroy).toHaveBeenCalledOnce();
    expect(playbackDestroy).toHaveBeenCalledOnce();
  });

  it('ignores a late HLS attachment failure after destroy', async () => {
    let rejectAttachment!: (error: Error) => void;
    media.attachHls.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAttachment = reject;
      }),
    );
    const audio = new FakeAudio();
    vi.stubGlobal('document', { createElement: vi.fn(() => audio) });
    const program = createAudioProgram({
      kind: 'hls',
      url: 'https://example.com/live.m3u8',
    });

    const start = program.start();
    program.destroy();
    rejectAttachment(new media.HlsNotSupportedError('unsupported'));

    await expect(start).resolves.toBeUndefined();
    expect(media.playWithAudioFallback).not.toHaveBeenCalled();
  });
});
