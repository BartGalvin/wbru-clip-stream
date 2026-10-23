import { afterEach, describe, expect, it, vi } from 'vitest';

import { HlsNotSupportedError, type MediaHandle } from './playback';
import { createRecoveringHlsConnection } from './recoveringHls';

// Test attachment callback that exposes the connection's fatal-error hook.
type Attach = (onFatal: (error: Error) => void) => Promise<MediaHandle>;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function createOptions(attach: Attach) {
  return {
    attach,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onRetry: vi.fn(),
    onRetryError: vi.fn(),
  };
}

describe('createRecoveringHlsConnection', () => {
  it('deduplicates fatal errors while one retry is pending', async () => {
    vi.useFakeTimers();
    let onFatal: ((error: Error) => void) | undefined;
    const connectionDestroys = [vi.fn(), vi.fn()];
    const attach = vi
      .fn()
      .mockImplementationOnce((callback: (error: Error) => void) => {
        onFatal = callback;
        return Promise.resolve({ destroy: connectionDestroys[0] });
      })
      .mockResolvedValueOnce({ destroy: connectionDestroys[1] });
    const options = createOptions(attach);
    const controller = createRecoveringHlsConnection(options);

    await controller.start();
    const error = new Error('stream failed');
    onFatal?.(error);
    onFatal?.(error);

    expect(connectionDestroys[0]).toHaveBeenCalledOnce();
    expect(options.onRetry).toHaveBeenCalledOnce();
    expect(options.onRetry).toHaveBeenCalledWith(error);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(options.onConnected).toHaveBeenCalledTimes(2);

    controller.destroy();
    controller.destroy();
    expect(connectionDestroys[1]).toHaveBeenCalledOnce();
  });

  it('disposes a stale attachment that resolves after recovery starts', async () => {
    vi.useFakeTimers();
    let onFatal: ((error: Error) => void) | undefined;
    let resolveFirst!: (handle: MediaHandle) => void;
    const staleDestroy = vi.fn();
    const activeDestroy = vi.fn();
    const attach = vi
      .fn()
      .mockImplementationOnce((callback: (error: Error) => void) => {
        onFatal = callback;
        return new Promise<MediaHandle>((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce({ destroy: activeDestroy });
    const options = createOptions(attach);
    const controller = createRecoveringHlsConnection(options);

    const firstStart = controller.start();
    onFatal?.(new Error('stream failed'));
    await vi.advanceTimersByTimeAsync(3_000);
    resolveFirst({ destroy: staleDestroy });
    await firstStart;

    expect(staleDestroy).toHaveBeenCalledOnce();
    expect(activeDestroy).not.toHaveBeenCalled();
    expect(options.onConnected).toHaveBeenCalledOnce();

    controller.destroy();
    expect(activeDestroy).toHaveBeenCalledOnce();
  });

  it('propagates unsupported HLS without scheduling a retry', async () => {
    vi.useFakeTimers();
    const error = new HlsNotSupportedError('HLS is not supported');
    const options = createOptions(vi.fn<Attach>().mockRejectedValue(error));
    const controller = createRecoveringHlsConnection(options);

    await expect(controller.start()).rejects.toBe(error);

    expect(options.onRetry).not.toHaveBeenCalled();
    expect(options.onRetryError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unsupported HLS encountered by a retry', async () => {
    vi.useFakeTimers();
    let onFatal: ((error: Error) => void) | undefined;
    const unsupported = new HlsNotSupportedError('HLS became unavailable');
    const attach = vi
      .fn()
      .mockImplementationOnce((callback: (error: Error) => void) => {
        onFatal = callback;
        return Promise.resolve({ destroy: vi.fn() });
      })
      .mockRejectedValueOnce(unsupported);
    const options = createOptions(attach);
    const controller = createRecoveringHlsConnection(options);

    await controller.start();
    onFatal?.(new Error('stream failed'));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(options.onRetryError).toHaveBeenCalledOnce();
    expect(options.onRetryError).toHaveBeenCalledWith(unsupported);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending retry during teardown', async () => {
    vi.useFakeTimers();
    let onFatal: ((error: Error) => void) | undefined;
    const connectionDestroy = vi.fn();
    const attach = vi.fn().mockImplementation((callback: (error: Error) => void) => {
      onFatal = callback;
      return Promise.resolve({ destroy: connectionDestroy });
    });
    const options = createOptions(attach);
    const controller = createRecoveringHlsConnection(options);

    await controller.start();
    onFatal?.(new Error('stream failed'));
    controller.destroy();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(attach).toHaveBeenCalledOnce();
    expect(connectionDestroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
