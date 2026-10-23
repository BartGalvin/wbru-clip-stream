import { afterEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
  attachHls: vi.fn(),
  HlsNotSupportedError: class HlsNotSupportedError extends Error {},
  playWithAudioFallback: vi.fn(),
}));

vi.mock('../media/playback', () => media);

import { createVideoProgram } from './videoProgram';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('createVideoProgram', () => {
  it('reports the unsupported YouTube branch clearly', () => {
    expect(() =>
      createVideoProgram(
        { kind: 'youtube', playlistId: 'playlist' },
        {
          stage: {} as HTMLElement,
          muted: true,
          onStatus: () => {},
        },
      ),
    ).toThrow('YouTube playback is not implemented yet');
  });

  it('makes an HLS video visible when playback starts', async () => {
    const destroy = vi.fn();
    const playbackDestroy = vi.fn();
    media.attachHls.mockResolvedValue({ destroy });
    media.playWithAudioFallback.mockReturnValue({ destroy: playbackDestroy });
    const video = {
      classList: { add: vi.fn() },
      remove: vi.fn(),
    } as unknown as HTMLVideoElement;
    const stage = { appendChild: vi.fn() } as unknown as HTMLElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => video) });

    const program = createVideoProgram(
      { kind: 'hls', url: 'https://example.com/live.m3u8' },
      {
        stage,
        muted: false,
        onStatus: vi.fn(),
      },
    );
    await program.start();

    expect(video.classList.add).toHaveBeenCalledWith('on');
    expect(media.playWithAudioFallback).toHaveBeenCalledWith(video, undefined);
    program.destroy();
    expect(destroy).toHaveBeenCalledOnce();
    expect(playbackDestroy).toHaveBeenCalledOnce();
  });

  it('reconnects after an HLS fatal error', async () => {
    vi.useFakeTimers();
    const callbacks: Array<(error: Error) => void> = [];
    const destroys = [vi.fn(), vi.fn()];
    const playbackDestroys = [vi.fn(), vi.fn()];
    media.attachHls.mockImplementation(
      (_video: HTMLVideoElement, _url: string, onFatal: (error: Error) => void) => {
        callbacks.push(onFatal);
        return Promise.resolve({ destroy: destroys[callbacks.length - 1] });
      },
    );
    media.playWithAudioFallback.mockImplementation(() => ({
      destroy: playbackDestroys[media.playWithAudioFallback.mock.calls.length - 1],
    }));
    const video = {
      classList: { add: vi.fn() },
      remove: vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => video) });
    const onStatus = vi.fn();

    const program = createVideoProgram(
      { kind: 'hls', url: 'https://example.com/live.m3u8' },
      {
        stage: { appendChild: vi.fn() } as unknown as HTMLElement,
        muted: true,
        onStatus,
      },
    );
    await program.start();
    callbacks[0](new Error('HLS stream error'));
    callbacks[0](new Error('HLS stream error'));

    expect(destroys[0]).toHaveBeenCalledOnce();
    expect(playbackDestroys[0]).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith('HLS stream error. Retrying...');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(media.attachHls).toHaveBeenCalledTimes(2);
    expect(media.playWithAudioFallback).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith(null);

    program.destroy();
    program.destroy();
    expect(destroys[1]).toHaveBeenCalledOnce();
    expect(playbackDestroys[1]).toHaveBeenCalledOnce();
  });

  it('does not retry when the browser cannot play HLS', async () => {
    vi.useFakeTimers();
    media.attachHls.mockRejectedValue(
      new media.HlsNotSupportedError('HLS is not supported in this browser'),
    );
    const video = {
      classList: { add: vi.fn() },
      remove: vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => video) });
    const program = createVideoProgram(
      { kind: 'hls', url: 'https://example.com/live.m3u8' },
      {
        stage: { appendChild: vi.fn() } as unknown as HTMLElement,
        muted: true,
        onStatus: vi.fn(),
      },
    );

    await expect(program.start()).rejects.toThrow('HLS is not supported');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(media.attachHls).toHaveBeenCalledOnce();
  });

  it('ignores a late unsupported-HLS failure after destroy', async () => {
    let rejectAttachment!: (error: Error) => void;
    media.attachHls.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAttachment = reject;
      }),
    );
    const video = {
      classList: { add: vi.fn() },
      remove: vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => video) });
    const onStatus = vi.fn();
    const program = createVideoProgram(
      { kind: 'hls', url: 'https://example.com/live.m3u8' },
      {
        stage: { appendChild: vi.fn() } as unknown as HTMLElement,
        muted: true,
        onStatus,
      },
    );

    const start = program.start();
    program.destroy();
    rejectAttachment(new media.HlsNotSupportedError('unsupported'));

    await expect(start).resolves.toBeUndefined();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('reports unsupported HLS if it appears during a reconnect', async () => {
    vi.useFakeTimers();
    let onFatal: ((error: Error) => void) | undefined;
    media.attachHls
      .mockImplementationOnce(
        (_video: HTMLVideoElement, _url: string, callback: (error: Error) => void) => {
          onFatal = callback;
          return Promise.resolve({ destroy: vi.fn() });
        },
      )
      .mockRejectedValueOnce(new media.HlsNotSupportedError('HLS became unavailable'));
    media.playWithAudioFallback.mockReturnValue({ destroy: vi.fn() });
    const video = {
      classList: { add: vi.fn() },
      remove: vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => video) });
    const onStatus = vi.fn();
    const program = createVideoProgram(
      { kind: 'hls', url: 'https://example.com/live.m3u8' },
      {
        stage: { appendChild: vi.fn() } as unknown as HTMLElement,
        muted: true,
        onStatus,
      },
    );

    await program.start();
    onFatal?.(new Error('stream failed'));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(onStatus).toHaveBeenLastCalledWith('HLS became unavailable');
    program.destroy();
  });
});
