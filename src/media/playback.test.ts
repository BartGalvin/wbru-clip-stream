import { afterEach, describe, expect, it, vi } from 'vitest';

const hlsJs = vi.hoisted(() => ({
  isSupported: vi.fn(() => true),
  on: vi.fn(),
  loadSource: vi.fn(),
  attachMedia: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('hls.js', () => ({
  default: class MockHls {
    static Events = { ERROR: 'error' };
    static isSupported = hlsJs.isSupported;
    on = hlsJs.on;
    loadSource = hlsJs.loadSource;
    attachMedia = hlsJs.attachMedia;
    destroy = hlsJs.destroy;
  },
}));

import { attachHls, playWithAudioFallback } from './playback';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('attachHls', () => {
  it('reports native HLS playback errors and removes its listener on destroy', async () => {
    let onError: (() => void) | undefined;
    const media = {
      canPlayType: vi.fn(() => 'maybe'),
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === 'error') onError = listener;
      }),
      removeEventListener: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      src: '',
    } as unknown as HTMLMediaElement;
    const onFatal = vi.fn();

    const handle = await attachHls(media, 'https://example.com/live.m3u8', onFatal);
    onError?.();
    expect(onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Native HLS playback error' }),
    );

    handle.destroy();
    handle.destroy();
    expect(media.removeEventListener).toHaveBeenCalledWith('error', onError);
    expect(media.removeAttribute).toHaveBeenCalledWith('src');
    expect(media.load).toHaveBeenCalledOnce();
  });

  it('reports fatal hls.js errors and destroys its instance', async () => {
    const media = {
      canPlayType: vi.fn(() => ''),
    } as unknown as HTMLMediaElement;
    const onFatal = vi.fn();

    const handle = await attachHls(media, 'https://example.com/live.m3u8', onFatal);
    const onHlsError = hlsJs.on.mock.calls[0][1] as (
      event: string,
      data: { fatal: boolean; type: string },
    ) => void;
    onHlsError('error', { fatal: false, type: 'networkError' });
    expect(onFatal).not.toHaveBeenCalled();

    onHlsError('error', { fatal: true, type: 'networkError' });
    expect(onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'HLS stream error: networkError' }),
    );

    handle.destroy();
    handle.destroy();
    expect(hlsJs.destroy).toHaveBeenCalledOnce();
  });

  it('destroys hls.js when setup throws', async () => {
    const media = {
      canPlayType: vi.fn(() => ''),
    } as unknown as HTMLMediaElement;
    const error = new Error('attach failed');
    hlsJs.attachMedia.mockImplementationOnce(() => {
      throw error;
    });

    await expect(attachHls(media, 'https://example.com/live.m3u8', vi.fn())).rejects.toBe(error);
    expect(hlsJs.destroy).toHaveBeenCalledOnce();
  });

  it('calls onResumed when initial playback succeeds', async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('window', {
      addEventListener,
      removeEventListener: vi.fn(),
    });
    const media = {
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLMediaElement;
    const onBlocked = vi.fn();
    const onResumed = vi.fn();

    playWithAudioFallback(media, { onBlocked, onResumed });
    await Promise.resolve();

    expect(onResumed).toHaveBeenCalledOnce();
    expect(onBlocked).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('keeps listening for a gesture until blocked playback succeeds', async () => {
    const listeners = new Map<string, () => void>();
    const removeEventListener = vi.fn((event: string) => listeners.delete(event));
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, listener: () => void) =>
        listeners.set(event, listener),
      ),
      removeEventListener,
    });
    const media = {
      play: vi
        .fn()
        .mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
        .mockRejectedValueOnce(new DOMException('still blocked', 'NotAllowedError'))
        .mockResolvedValueOnce(undefined),
    } as unknown as HTMLMediaElement;
    const onBlocked = vi.fn();
    const onResumed = vi.fn();

    playWithAudioFallback(media, { onBlocked, onResumed });
    await Promise.resolve();
    expect(onBlocked).toHaveBeenCalledOnce();

    listeners.get('pointerdown')?.();
    await Promise.resolve();
    expect(removeEventListener).not.toHaveBeenCalled();

    listeners.get('pointerdown')?.();
    await Promise.resolve();
    expect(onResumed).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('removes pending gesture listeners when destroyed', async () => {
    const listeners = new Map<string, () => void>();
    const removeEventListener = vi.fn((event: string) => listeners.delete(event));
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, listener: () => void) =>
        listeners.set(event, listener),
      ),
      removeEventListener,
    });
    const media = {
      play: vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError')),
    } as unknown as HTMLMediaElement;

    const handle = playWithAudioFallback(media);
    await Promise.resolve();
    expect(listeners.size).toBe(2);

    handle.destroy();

    expect(listeners.size).toBe(0);
    expect(removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('reports non-policy failures without installing gesture listeners', async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('window', {
      addEventListener,
      removeEventListener: vi.fn(),
    });
    const error = new DOMException('media unavailable', 'NotSupportedError');
    const media = {
      play: vi.fn().mockRejectedValue(error),
    } as unknown as HTMLMediaElement;
    const onBlocked = vi.fn();
    const onError = vi.fn();

    playWithAudioFallback(media, { onBlocked, onError });
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
