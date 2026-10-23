import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
const refreshClips = vi.hoisted(() => vi.fn());
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

vi.mock('node:child_process', () => ({ spawn }));
vi.mock('./db', () => ({ refreshClips }));

import { createScanQueue, markTaggerActivity, runClipIndexer, startAutoRescan } from './rescan';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  spawn.mockReset();
  refreshClips.mockReset();
});

describe('runClipIndexer', () => {
  it('uses the current Node process and inherits child diagnostics', async () => {
    const child = new EventEmitter();
    spawn.mockReturnValueOnce(child);

    const completed = runClipIndexer(true);

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/scripts\/index-clips\.mjs$/), '--force'],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: 'inherit',
      },
    );

    child.emit('close', 0, null);
    await expect(completed).resolves.toBeUndefined();
  });

  it('reports a nonzero indexer exit', async () => {
    const child = new EventEmitter();
    spawn.mockReturnValueOnce(child);

    const completed = runClipIndexer(false);
    child.emit('close', 23, null);

    await expect(completed).rejects.toThrow('index-clips exited with code 23');
  });
});

describe('createScanQueue', () => {
  it('coalesces concurrent ordinary scans', async () => {
    const pendingScan = deferred<{ added: number; removed: number; total: number }>();
    const runScan = vi.fn(() => pendingScan.promise);
    const scan = createScanQueue(runScan);

    const first = scan();
    const second = scan();

    expect(second).toBe(first);
    expect(runScan).toHaveBeenCalledOnce();
    expect(runScan).toHaveBeenCalledWith(false);

    pendingScan.resolve({ added: 1, removed: 0, total: 4 });
    await expect(first).resolves.toEqual({ added: 1, removed: 0, total: 4 });
  });

  it('queues one forced scan after an ordinary scan', async () => {
    const ordinaryScan = deferred<{ added: number; removed: number; total: number }>();
    const forcedScan = deferred<{ added: number; removed: number; total: number }>();
    const runScan = vi
      .fn()
      .mockReturnValueOnce(ordinaryScan.promise)
      .mockReturnValueOnce(forcedScan.promise);
    const scan = createScanQueue(runScan);

    const ordinary = scan();
    const forced = scan({ force: true });

    expect(scan({ force: true })).toBe(forced);
    const ordinaryFailure = expect(ordinary).rejects.toThrow('ordinary scan failed');
    ordinaryScan.reject(new Error('ordinary scan failed'));
    await ordinaryFailure;
    await vi.waitFor(() => expect(runScan).toHaveBeenCalledTimes(2));
    expect(runScan).toHaveBeenNthCalledWith(2, true);

    forcedScan.resolve({ added: 1, removed: 0, total: 4 });
    await expect(forced).resolves.toEqual({ added: 1, removed: 0, total: 4 });
  });

  it('coalesces all callers into an active forced scan', async () => {
    const pendingScan = deferred<{ added: number; removed: number; total: number }>();
    const runScan = vi.fn(() => pendingScan.promise);
    const scan = createScanQueue(runScan);

    const forced = scan({ force: true });

    expect(scan()).toBe(forced);
    expect(scan({ force: true })).toBe(forced);
    expect(runScan).toHaveBeenCalledOnce();

    pendingScan.resolve({ added: 0, removed: 0, total: 4 });
    await forced;
  });

  it.each([false, true])(
    'starts a fresh scan after an active scan with force=%s',
    async (force) => {
      const pending = deferred<{ added: number; removed: number; total: number }>();
      const files = ['earlier.mp4'];
      const runScan = vi.fn(async () => {
        const total = files.length;
        if (total === 1) await pending.promise;
        return { added: 0, removed: 0, total };
      });
      const scan = createScanQueue(runScan);
      const active = scan({ force });

      files.push('last.mp4');
      const fresh = scan({ afterCurrent: true });
      expect(scan({ afterCurrent: true })).toBe(fresh);
      expect(runScan).toHaveBeenCalledOnce();

      pending.resolve({ added: 0, removed: 0, total: 1 });
      await expect(active).resolves.toEqual({ added: 0, removed: 0, total: 1 });
      await expect(fresh).resolves.toEqual({ added: 0, removed: 0, total: 2 });
      expect(runScan).toHaveBeenNthCalledWith(2, false);
    },
  );

  it('upgrades a waiting fresh scan when a forced scan is requested', async () => {
    const pending = deferred<{ added: number; removed: number; total: number }>();
    const result = { added: 0, removed: 0, total: 1 };
    const runScan = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(result);
    const scan = createScanQueue(runScan);
    const active = scan();
    const fresh = scan({ afterCurrent: true });

    expect(scan({ force: true })).toBe(fresh);
    pending.resolve(result);
    await active;
    await fresh;
    expect(runScan).toHaveBeenNthCalledWith(2, true);
  });
});

describe('automatic rescanning', () => {
  it('does not start a timer when development uses remote media', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubEnv('CLIPS_SCAN_ENABLED', '0');
    try {
      markTaggerActivity();
      const stop = startAutoRescan();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(spawn).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it('runs only after recent tagger activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const child = new EventEmitter();
    spawn.mockReturnValueOnce(child);
    refreshClips.mockReturnValue({ added: 1, removed: 0, total: 4 });
    const stop = startAutoRescan();

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spawn).not.toHaveBeenCalled();

      markTaggerActivity();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spawn).toHaveBeenCalledOnce();

      child.emit('close', 0, null);
      await Promise.resolve();
      await Promise.resolve();
      expect(refreshClips).toHaveBeenCalledOnce();

      vi.setSystemTime(1_150_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
