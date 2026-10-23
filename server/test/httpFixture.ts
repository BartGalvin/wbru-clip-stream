import { afterAll, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Module types exposed by the fixture after their environment-aware delayed imports.
type Database = typeof import('../src/db');
type ClipRescan = typeof import('../src/rescan');

// Shared integration-test server with isolated storage and direct access to test doubles.
export interface HttpAppFixture {
  readonly database: Database;
  readonly clipRescan: ClipRescan;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export function useHttpApp(): HttpAppFixture {
  let dataDir: string | undefined;
  let server: Server | undefined;
  let baseUrl: string | undefined;
  let database: Database | undefined;
  let clipRescan: ClipRescan | undefined;

  const initialized = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) throw new Error(`${name} is not initialized`);
    return value;
  };

  // Give each suite a real HTTP server backed by an isolated catalog.
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tagger-app-'));
    vi.stubEnv('TAGGER_DATA_DIR', dataDir);
    vi.stubEnv('DATABASE_PATH', join(dataDir, 'program.db'));

    // Import database singletons only after redirecting their environment-based paths.
    database = await import('../src/db');
    clipRescan = await import('../src/rescan');
    const { createApp } = await import('../src/app');

    database.initializeDatabase();
    // Seed shared file records, then assign their operator-managed tags.
    database.syncClips([
      {
        id: 'clp_bw',
        title: 'bw',
        url: '/clips/bw.mp4',
        path: 'bw.mp4',
        library: 'visualizer',
        durationSec: 0,
      },
      {
        id: 'clp_in',
        title: 'in',
        url: '/clips/in.mp4',
        path: 'in.mp4',
        library: 'visualizer',
        durationSec: 0,
      },
      {
        id: 'clp_kbin',
        title: 'kbin',
        url: '/clips/kbin.mp4',
        path: 'kbin.mp4',
        library: 'visualizer',
        durationSec: 0,
      },
      {
        id: 'clp_tv',
        title: 'tv',
        url: '/clips/wbru-youtube/tv.mp4',
        path: 'wbru-youtube/tv.mp4',
        library: 'wbru-youtube',
        durationSec: 0,
      },
    ]);
    database.setClipTagsBatch([
      { id: 'clp_bw', tags: ['black and white'] },
      { id: 'clp_in', tags: ['indie'] },
      { id: 'clp_kbin', tags: ['ken burns', 'indie'] },
      { id: 'clp_tv', tags: ['indie'] },
    ]);

    const appServer = createApp().listen(0);
    server = appServer;
    await new Promise<void>((resolve) => appServer.once('listening', resolve));
    const address = appServer.address();
    if (typeof address === 'string' || !address) throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  // Release network and database resources before restoring the process environment.
  afterAll(async () => {
    const runningServer = server;
    if (runningServer) {
      await new Promise<void>((resolve) => runningServer.close(() => resolve()));
    }
    database?.closeDatabase();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });

    vi.unstubAllEnvs();
  });

  const request = (path: string, init?: RequestInit) =>
    fetch(`${initialized(baseUrl, 'base URL')}${path}`, init);

  return {
    get database() {
      return initialized(database, 'database');
    },
    get clipRescan() {
      return initialized(clipRescan, 'clip rescan');
    },
    request,
  };
}
