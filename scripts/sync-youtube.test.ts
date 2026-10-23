import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createScanQueue } from '../server/src/rescan';

vi.mock('../server/src/db', () => ({ refreshClips: vi.fn() }));

let root: string;
let dataDir: string;
let fakeYtDlp: string;
let argsFile: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'youtube-sync-clips-'));
  dataDir = mkdtempSync(join(tmpdir(), 'youtube-sync-data-'));
  fakeYtDlp = join(root, 'fake-yt-dlp');
  argsFile = join(root, 'args.txt');
  writeFileSync(
    fakeYtDlp,
    `#!/bin/sh
set -eu
mkdir -p "$CLIPS_DIR/wbru-youtube"
printf 'video payload' > "$CLIPS_DIR/wbru-youtube/session.mp4"
printf '{"title":"Cloud Session","duration":31}' > "$CLIPS_DIR/wbru-youtube/session.info.json"
printf '%s\\n' "$@" > "$ARGS_FILE"
`,
  );
  chmodSync(fakeYtDlp, 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('sync-youtube', () => {
  it('requires a channel URL before creating download directories', () => {
    const clips = join(root, 'unconfigured');
    const result = spawnSync(process.execPath, ['scripts/sync-youtube.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        YOUTUBE_CHANNEL_URL: '',
        CLIPS_DIR: clips,
        YT_DLP_BIN: fakeYtDlp,
        ARGS_FILE: argsFile,
        PROGRAM_REFRESH_URL: '',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Set YOUTUBE_CHANNEL_URL before downloading.');
    expect(existsSync(clips)).toBe(false);
  });

  it('downloads videos and sidecars without indexing when refresh is disabled', () => {
    execFileSync(process.execPath, ['scripts/sync-youtube.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        YOUTUBE_CHANNEL_URL: 'https://www.youtube.com/@example/videos',
        CLIPS_DIR: root,
        CLIPS_URL_PREFIX: '/clips/',
        TAGGER_DATA_DIR: dataDir,
        YT_DLP_BIN: fakeYtDlp,
        YOUTUBE_COOKIES_FILE: '/etc/wbru-youtube-cookies.txt',
        ARGS_FILE: argsFile,
        PROGRAM_REFRESH_URL: '',
      },
      encoding: 'utf8',
    });

    expect(readdirSync(dataDir)).toEqual([]);
    expect(readFileSync(join(root, 'wbru-youtube/session.mp4'), 'utf8')).toBe('video payload');
    expect(JSON.parse(readFileSync(join(root, 'wbru-youtube/session.info.json'), 'utf8'))).toEqual({
      title: 'Cloud Session',
      duration: 31,
    });
    const args = readFileSync(argsFile, 'utf8');
    expect(args).toContain('--no-abort-on-error');
    expect(args).not.toContain('--ignore-errors');
    expect(args).toContain('--download-archive');
    expect(args).toContain('--write-info-json');
    expect(args).toContain('--js-runtimes\nnode');
    expect(args).toContain('--sleep-interval\n5');
    expect(args).toContain(`--cache-dir\n${join(root, '.yt-dlp-cache')}`);
    expect(args).toContain('--cookies\n/etc/wbru-youtube-cookies.txt');
    expect(args).toContain('https://www.youtube.com/@example/videos');
  });

  it.each([
    { failure: 'HTTP 503', recovers: false },
    { failure: 'HTTP 503', recovers: true },
    { failure: 'timeout', recovers: false },
    { failure: 'timeout', recovers: true },
  ])(
    'never starts a local scanner after $failure; recovers=$recovers',
    async ({ failure, recovers }) => {
      const child = new EventEmitter();
      const spawn = vi.fn(() => {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      });
      const failRefresh = async () => {
        if (failure === 'timeout') throw new DOMException('Request timed out', 'TimeoutError');
        return { ok: false, status: 503, text: async () => '' };
      };
      const fetch = vi.fn(failRefresh);
      if (recovers) {
        fetch.mockImplementationOnce(failRefresh);
        fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{"total":1}' });
      }
      const exitCode = process.exitCode;

      vi.resetModules();
      vi.doMock('node:child_process', () => ({ spawn }));
      vi.stubEnv('CLIPS_DIR', root);
      vi.stubEnv('YOUTUBE_CHANNEL_URL', 'https://www.youtube.com/@example/videos');
      vi.stubEnv('YOUTUBE_CACHE_DIR', join(root, '.cache'));
      vi.stubEnv('YT_DLP_BIN', 'fake-yt-dlp');
      vi.stubEnv('PROGRAM_REFRESH_URL', 'http://localhost/fixture-refresh?force=0');
      vi.stubGlobal('fetch', fetch);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await import('./sync-youtube.mjs');

        expect(spawn).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledWith('fake-yt-dlp', expect.any(Array), expect.any(Object));
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining('Catalog refresh request failed:'),
        );
        expect(process.exitCode).toBe(recovers ? exitCode : 1);
      } finally {
        process.exitCode = exitCode;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.doUnmock('node:child_process');
      }
    },
  );

  it.each([
    { code: 0, otherCaller: false, force: false },
    { code: 1, otherCaller: false, force: false },
    { code: 0, otherCaller: true, force: false },
    { code: 0, otherCaller: true, force: true },
  ])(
    'finishes with a fresh scan: exit=$code, otherCaller=$otherCaller, force=$force',
    async ({ code, otherCaller, force }) => {
      const clipsDir = mkdtempSync(join(tmpdir(), 'youtube-sync-refresh-'));
      const outputDir = join(clipsDir, 'wbru-youtube');
      const child = new EventEmitter();
      const pendingScan = Promise.withResolvers<void>();
      const snapshots: string[][] = [];
      let activeScans = 0;
      let maxActiveScans = 0;
      const exitCode = process.exitCode;
      const spawn = vi.fn(() => child);
      const scan = createScanQueue(async () => {
        activeScans++;
        maxActiveScans = Math.max(maxActiveScans, activeScans);
        const files = readdirSync(outputDir);
        snapshots.push(files);
        if (snapshots.length === 2) await pendingScan.promise;
        activeScans--;
        return { added: files.length, removed: 0, total: files.length };
      });
      const fetch = vi.fn(async (url: URL) => {
        const result = await scan({
          force: url.searchParams.get('force') !== '0',
          afterCurrent: url.searchParams.get('afterCurrent') === '1',
        });
        return { ok: true, text: async () => JSON.stringify(result) };
      });

      vi.resetModules();
      vi.useFakeTimers();
      vi.doMock('node:child_process', () => ({ spawn }));
      vi.stubEnv('CLIPS_DIR', clipsDir);
      vi.stubEnv('YOUTUBE_CHANNEL_URL', 'https://www.youtube.com/@example/videos');
      vi.stubEnv('YOUTUBE_CACHE_DIR', join(clipsDir, '.cache'));
      vi.stubEnv('YT_DLP_BIN', 'fake-yt-dlp');
      vi.stubEnv('PROGRAM_REFRESH_URL', 'http://localhost/fixture-refresh?force=0');
      vi.stubGlobal('fetch', fetch);
      const setInterval = vi.spyOn(globalThis, 'setInterval');
      const syncing = import('./sync-youtube.mjs');

      try {
        await vi.waitFor(() => expect(setInterval).toHaveBeenCalledOnce());
        expect(spawn).toHaveBeenCalledOnce();
        expect(snapshots).toEqual([[]]);

        if (otherCaller) {
          void scan({ force });
        } else {
          await vi.advanceTimersByTimeAsync(2 * 60_000);
          expect(fetch).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(4 * 60_000);
          expect(fetch).toHaveBeenCalledTimes(2);
        }

        writeFileSync(join(outputDir, 'last.mp4'), 'completed video');
        child.emit('exit', code);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(2);

        pendingScan.resolve();
        await syncing;

        expect(snapshots).toEqual([[], [], ['last.mp4']]);
        expect(maxActiveScans).toBe(1);
        expect(process.exitCode).toBe(code || exitCode);
        const calls = otherCaller ? 2 : 3;
        expect(fetch.mock.calls.at(-1)?.[0].searchParams.get('afterCurrent')).toBe('1');
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(fetch).toHaveBeenCalledTimes(calls);
      } finally {
        pendingScan.resolve();
        child.emit('exit', 0);
        try {
          await syncing;
        } finally {
          process.exitCode = exitCode;
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
          vi.doUnmock('node:child_process');
          vi.useRealTimers();
          rmSync(clipsDir, { recursive: true, force: true });
        }
      }
    },
  );
});
