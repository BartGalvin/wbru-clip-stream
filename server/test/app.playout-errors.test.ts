import { describe, expect, it, vi } from 'vitest';
import { useHttpApp } from './httpFixture';

const http = useHttpApp();

describe('query validation', () => {
  it('refuses manual scans when development uses remote media', async () => {
    vi.stubEnv('CLIPS_SCAN_ENABLED', '0');
    const scan = vi.spyOn(http.clipRescan, 'rescan');
    try {
      for (const query of ['', '?force=1']) {
        const response = await http.request(`/api/tags/refresh${query}`, { method: 'POST' });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: 'Catalog scans are disabled when using remote development media.',
        });
      }
      expect(scan).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { query: '', force: false, afterCurrent: false },
    { query: '?force=0', force: false, afterCurrent: false },
    { query: '?force=1', force: true, afterCurrent: false },
    { query: '?afterCurrent=1', force: false, afterCurrent: true },
    { query: '?force=0&afterCurrent=1', force: false, afterCurrent: true },
    { query: '?force=1&afterCurrent=1', force: true, afterCurrent: true },
  ])(
    'uses the requested scan options for refresh$query',
    async ({ query, force, afterCurrent }) => {
      const scan = vi
        .spyOn(http.clipRescan, 'rescan')
        .mockResolvedValue({ added: 0, removed: 0, total: 3 });
      try {
        const response = await http.request(`/api/tags/refresh${query}`, { method: 'POST' });
        expect(response.status).toBe(200);
        expect(scan).toHaveBeenCalledOnce();
        expect(scan).toHaveBeenCalledWith({ force, afterCurrent });
      } finally {
        scan.mockRestore();
      }
    },
  );

  it('rejects malformed bounded integers', async () => {
    const endpoints = ['/api/program/upcoming', '/api/tags/playout'];
    const values = ['', ' ', '1.5', 'NaN', 'Infinity', '-Infinity'];

    for (const endpoint of endpoints) {
      for (const value of values) {
        const response = await http.request(`${endpoint}?limit=${encodeURIComponent(value)}`);
        expect(response.status, `${endpoint} limit=${value}`).toBe(400);
        expect(await response.json()).toEqual({ error: 'limit must be a finite integer' });
      }
    }
  });

  it('clamps valid out-of-range integers', async () => {
    const below = await http.request('/api/program/upcoming?limit=0');
    expect(below.status).toBe(200);
    expect((await below.json()) as unknown[]).toHaveLength(1);

    const above = await http.request('/api/program/upcoming?limit=51');
    expect(above.status).toBe(200);
    expect((await above.json()) as unknown[]).toHaveLength(50);
  });

  it('rejects repeated values where one scalar is required', async () => {
    const paths = [
      '/api/channel?channel=all&channel=indie',
      '/api/program/upcoming?after=one&after=two',
      '/api/program/upcoming?limit=1&limit=2',
      '/api/program/upcoming?include=indie&include=360',
      '/api/program/upcoming?exclude=indie&exclude=360',
      '/api/program/upcoming?match=all&match=any',
      '/api/program/current?output=one&output=two',
      '/api/program/position?channel=indie&channel=360',
      '/api/tags/playout?limit=1&limit=2',
      '/api/tags/playout?output=one&output=two',
      '/api/tags/playout?channel=indie&channel=360',
      '/api/tags/playout?q=one&q=two',
      '/api/tags/playout?since=one&since=two',
      '/api/tags/playout?until=one&until=two',
      '/api/tags/playout?beforeId=1&beforeId=2',
      '/api/tags/playout?afterId=1&afterId=2',
    ];

    for (const path of paths) {
      expect((await http.request(path)).status, path).toBe(400);
    }

    for (const query of ['force=0&force=1', 'afterCurrent=0&afterCurrent=1']) {
      const refresh = await http.request(`/api/tags/refresh?${query}`, { method: 'POST' });
      expect(refresh.status).toBe(400);
    }
  });
});

describe('playout log', () => {
  it('serves server-recorded clip starts as history and current titles', async () => {
    expect(http.database.recordPlayout('wbru-tv', 'wbru-tv', 'clp_tv', 'slot-1')).toBe(true);

    const log = await http.request('/api/tags/playout?limit=1');
    expect(log.status).toBe(200);
    expect(await log.json()).toEqual([
      {
        id: expect.any(Number),
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        outputId: 'wbru-tv',
        channelId: 'wbru-tv',
        clipId: 'clp_tv',
        cursor: 'slot-1',
        title: 'tv',
        path: 'wbru-youtube/tv.mp4',
        library: 'wbru-youtube',
        source: null,
        previewUrl: '/clips/wbru-youtube/tv.mp4',
        durationSec: 0,
      },
    ]);

    const current = await http.request('/api/program/current?output=wbru-tv');
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      outputId: 'wbru-tv',
      channelId: 'wbru-tv',
      clipId: 'clp_tv',
      title: 'tv',
      publishedYear: null,
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      durationSec: 0,
    });
  });

  it('does not accept browser reports, including keyed ones', async () => {
    const before = http.database.getRecentPlayouts();
    const report = await http.request('/api/program/playout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Playout-Key': 'test-playout-key' },
      body: JSON.stringify({
        outputId: 'wbru-tv',
        channelId: 'wbru-tv',
        clipId: 'clp_tv',
        cursor: 'slot-2',
      }),
    });
    expect(report.status).toBe(404);
    expect(http.database.getRecentPlayouts()).toEqual(before);
  });

  it('filters the operator log by output', async () => {
    const outputId = 'wbru-tv-filter-test';
    http.database.recordPlayout(outputId, 'wbru-tv', 'clp_tv', 'filter-test-slot');

    expect(
      await http
        .request('/api/tags/playout?output=visualizer-main')
        .then((response) => response.json()),
    ).toEqual([]);
    expect(
      await http
        .request(`/api/tags/playout?output=${outputId}`)
        .then((response) => response.json()),
    ).toEqual([expect.objectContaining({ outputId })]);
  });

  it('filters the operator log by channel, time, title, and path', async () => {
    const outputId = 'wbru-tv-search-test';
    http.database.recordPlayout(outputId, 'wbru-tv', 'clp_tv', 'search-test-slot');
    const query = new URLSearchParams({
      output: outputId,
      channel: 'wbru-tv',
      since: '2020-01-01T00:00:00.000Z',
      q: 'WBRU-YOUTUBE',
    });

    const matches = await http
      .request(`/api/tags/playout?${query}`)
      .then((response) => response.json());
    expect(matches).toEqual([expect.objectContaining({ cursor: 'search-test-slot' })]);

    query.set('q', 'not-present');
    expect(
      await http.request(`/api/tags/playout?${query}`).then((response) => response.json()),
    ).toEqual([]);

    query.set('q', 'tv');
    query.set('since', '2999-01-01T00:00:00.000Z');
    expect(
      await http.request(`/api/tags/playout?${query}`).then((response) => response.json()),
    ).toEqual([]);
  });

  it('pages backward from an earlier playout event id', async () => {
    const outputId = 'wbru-tv-pagination-test';
    http.database.recordPlayout(outputId, 'wbru-tv', 'clp_tv', 'pagination-older');
    http.database.recordPlayout(outputId, 'wbru-tv', 'clp_tv', 'pagination-newer');

    const newest = (await http
      .request(`/api/tags/playout?output=${outputId}&limit=1`)
      .then((response) => response.json())) as { id: number; cursor: string }[];
    expect(newest).toEqual([expect.objectContaining({ cursor: 'pagination-newer' })]);

    const older = (await http
      .request(`/api/tags/playout?output=${outputId}&limit=1&beforeId=${newest[0].id}`)
      .then((response) => response.json())) as { id: number; cursor: string }[];
    expect(older).toEqual([expect.objectContaining({ cursor: 'pagination-older' })]);

    const newer = await http
      .request(`/api/tags/playout?output=${outputId}&afterId=${older[0].id}`)
      .then((response) => response.json());
    expect(newer).toEqual([expect.objectContaining({ cursor: 'pagination-newer' })]);
  });

  it('includes time boundaries and pages within them', async () => {
    const outputId = 'history-window';
    const { getDatabase } = await import('../src/db/connection');
    const updateTime = getDatabase().prepare(
      'UPDATE playout_events SET started_at = datetime(?) WHERE output_id = ? AND cursor = ?',
    );
    const start = new Date(Date.now() - 86_400_000);
    start.setMilliseconds(0);
    const times = [0, 1, 2].map((seconds) =>
      new Date(start.getTime() + seconds * 1_000).toISOString(),
    );
    for (let index = 0; index < times.length; index++) {
      http.database.recordPlayout(outputId, 'wbru-tv', 'clp_tv', `window-${index}`);
      updateTime.run(times[index], outputId, `window-${index}`);
    }

    const query = new URLSearchParams({
      output: outputId,
      since: times[0],
      until: times[1],
      limit: '1',
    });
    const page = (await http
      .request(`/api/tags/playout?${query}`)
      .then((response) => response.json())) as { id: number; cursor: string }[];
    expect(page).toEqual([expect.objectContaining({ cursor: 'window-1' })]);
    query.set('beforeId', String(page[0].id));
    expect(
      await http.request(`/api/tags/playout?${query}`).then((response) => response.json()),
    ).toEqual([expect.objectContaining({ cursor: 'window-0' })]);
    query.set('since', times[2]);
    expect(
      await http.request(`/api/tags/playout?${query}`).then((response) => response.json()),
    ).toEqual([]);
  });

  it('accepts equivalent ISO and RFC date boundaries', async () => {
    const outputId = 'date-formats';
    http.database.recordPlayout(outputId, 'wbru-tv', 'clp_tv', 'date-formats-slot');
    const [{ startedAt }] = http.database.getRecentPlayouts({ outputId });
    const time = new Date(startedAt);

    for (const boundary of [time.toISOString(), time.toUTCString()]) {
      const query = new URLSearchParams({ output: outputId, since: boundary, until: boundary });
      const response = await http.request(`/api/tags/playout?${query}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({ cursor: 'date-formats-slot' }),
      ]);
    }
  });

  it('rejects invalid playout dates', async () => {
    for (const field of ['since', 'until']) {
      for (const value of ['', 'not-a-date']) {
        const response = await http.request(`/api/tags/playout?${field}=${value}`);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'playout timestamps must be valid dates' });
      }
    }
  });

  it('catches up in recording order across bounded pages, starting from an empty log', async () => {
    const outputId = 'catch-up-test';
    for (let index = 1; index <= 5; index++) {
      http.database.recordPlayout(outputId, 'wbru-tv', 'clp_tv', `catch-up-${index}`);
    }

    const cursors: string[] = [];
    let afterId = 0;
    for (let page = 0; page < 3; page++) {
      const events = (await http
        .request(`/api/tags/playout?output=${outputId}&afterId=${afterId}&limit=2`)
        .then((response) => response.json())) as { id: number; cursor: string }[];
      cursors.push(...events.map((event) => event.cursor));
      afterId = events.at(-1)!.id;
    }

    expect(cursors).toEqual(['catch-up-1', 'catch-up-2', 'catch-up-3', 'catch-up-4', 'catch-up-5']);
  });

  it('rejects malformed playout pagination cursors', async () => {
    for (const cursor of ['beforeId', 'afterId']) {
      for (const value of ['', '-1', '1.5', 'NaN', '9007199254740992']) {
        const response = await http.request(
          `/api/tags/playout?${cursor}=${encodeURIComponent(value)}`,
        );
        expect(response.status, `${cursor}=${value}`).toBe(400);
        expect(await response.json()).toEqual({
          error: `${cursor} must be a ${cursor === 'afterId' ? 'non-negative' : 'positive'} integer`,
        });
      }
    }
    expect((await http.request('/api/tags/playout?beforeId=0')).status).toBe(400);
  });

  it('returns no current title for an output with no scheduled clips', async () => {
    expect((await http.request('/api/program/current?output=unused-output')).status).toBe(204);
    expect((await http.request('/api/program/current?output=Not%20Valid')).status).toBe(400);
  });
});

describe('JSON request validation and failures', () => {
  it('rejects non-object and otherwise invalid request bodies', async () => {
    const requests: {
      path: string;
      body: unknown;
    }[] = [
      { path: '/api/tags/vocab', body: null },
      { path: '/api/tags/clips', body: 'tags' },
      { path: '/api/tags/clip-source', body: [] },
      { path: '/api/tags/clip-source', body: null },
      { path: '/api/tags/clips', body: { clips: [{ id: 'clp_bw', tags: ['valid', 42] }] } },
      { path: '/api/tags/clip-source', body: { ids: [], source: null } },
    ];

    for (const request of requests) {
      const response = await http.request(request.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      expect(response.status, request.path).toBe(400);
    }
  });

  it('returns stable JSON for malformed JSON', async () => {
    const response = await http.request('/api/tags/vocab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"tag":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid request body' });
  });

  it('logs internal failures without exposing their details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = vi.spyOn(http.database, 'listTagVocabulary').mockImplementationOnce(() => {
      throw new Error('/private/catalog/program.db failed');
    });
    try {
      const response = await http.request('/api/tags/vocab');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal server error' });
      expect(log).toHaveBeenCalledWith('Unhandled request error', expect.any(Error));
    } finally {
      failure.mockRestore();
      log.mockRestore();
    }
  });

  it('returns a stable operator-readable refresh failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = vi
      .spyOn(http.clipRescan, 'rescan')
      .mockRejectedValueOnce(new Error('/private/clips/index failed'));
    try {
      const response = await http.request('/api/tags/refresh?force=0', { method: 'POST' });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'clip catalog refresh failed; check server logs',
      });
      expect(log).toHaveBeenCalledWith('Clip catalog refresh failed', expect.any(Error));
    } finally {
      failure.mockRestore();
      log.mockRestore();
    }
  });
});
