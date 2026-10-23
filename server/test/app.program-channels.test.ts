import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useHttpApp } from './httpFixture';

beforeAll(() => {
  vi.stubEnv('RADIO_INDIE_URL', 'https://radio.example.com/indie');
  vi.stubEnv('RADIO_360_URL', 'https://radio.example.com/360');
});
const http = useHttpApp();

const fetchUpcoming = async (
  queryString: string,
): Promise<{ clipId: string; tags: string[] }[]> => {
  const response = await http.request('/api/program/upcoming?' + queryString);
  expect(response.status).toBe(200);
  return (await response.json()) as { clipId: string; tags: string[] }[];
};
const clipIds = (items: { clipId: string }[]) => items.map((item) => item.clipId);

describe('GET /api/program/upcoming', () => {
  it('plays the full catalog once per lap with no filter', async () => {
    expect(clipIds(await fetchUpcoming('limit=3')).sort()).toEqual([
      'clp_bw',
      'clp_in',
      'clp_kbin',
    ]);
  });

  it('sequences only clips matching include=, once per lap', async () => {
    const ids = clipIds(await fetchUpcoming('include=indie&limit=4'));
    expect([...ids.slice(0, 2)].sort()).toEqual(['clp_in', 'clp_kbin']);
    expect([...ids.slice(2, 4)].sort()).toEqual(['clp_in', 'clp_kbin']);
  });

  it('honors match=all and exclude=', async () => {
    const all = await fetchUpcoming(
      `include=${encodeURIComponent('ken burns,indie')}&match=all&limit=2`,
    );
    expect(clipIds(all)).toEqual(['clp_kbin', 'clp_kbin']);
    const withoutKenBurns = await fetchUpcoming(
      `include=indie&exclude=${encodeURIComponent('ken burns')}&limit=2`,
    );
    expect(clipIds(withoutKenBurns)).toEqual(['clp_in', 'clp_in']);
  });

  it("uses the channel's exclusions as a default that an explicit URL filter replaces", async () => {
    const indie = clipIds(await fetchUpcoming('channel=indie&limit=3'));
    expect(indie.sort()).toEqual(['clp_bw', 'clp_in', 'clp_kbin']);
    const withoutKenBurns = clipIds(
      await fetchUpcoming(`channel=indie&exclude=${encodeURIComponent('ken burns')}&limit=4`),
    );
    expect([...new Set(withoutKenBurns)].sort()).toEqual(['clp_bw', 'clp_in']);
  });

  it('keeps untagged visualizer clips out of rotation without affecting WBRU TV', async () => {
    http.database.setClipTagsBatch([
      { id: 'clp_bw', tags: [] },
      { id: 'clp_tv', tags: [] },
    ]);
    try {
      const visualizer = await fetchUpcoming('limit=4');
      expect([...new Set(clipIds(visualizer))].sort()).toEqual(['clp_in', 'clp_kbin']);
      expect(visualizer.every((clip) => clip.tags.length > 0)).toBe(true);
      const catalog = await http.request('/api/tags/clips').then((response) => response.json());
      expect(catalog).toContainEqual(expect.objectContaining({ id: 'clp_bw', tags: [] }));
      expect(clipIds(await fetchUpcoming('channel=wbru-tv&limit=2'))).toEqual(['clp_tv', 'clp_tv']);
    } finally {
      http.database.setClipTagsBatch([
        { id: 'clp_bw', tags: ['black and white'] },
        { id: 'clp_tv', tags: ['indie'] },
      ]);
    }
  });

  it('keeps inactive clips out of every rotation', async () => {
    http.database.setClipTagsBatch([
      { id: 'clp_bw', tags: ['inactive'] },
      { id: 'clp_tv', tags: ['inactive'] },
    ]);
    try {
      expect(clipIds(await fetchUpcoming('channel=all&limit=2')).sort()).toEqual([
        'clp_in',
        'clp_kbin',
      ]);
      expect(clipIds(await fetchUpcoming('channel=indie&limit=2')).sort()).toEqual([
        'clp_in',
        'clp_kbin',
      ]);
      expect(clipIds(await fetchUpcoming('channel=360&limit=2')).sort()).toEqual([
        'clp_in',
        'clp_kbin',
      ]);
      expect(await fetchUpcoming('channel=wbru-tv&limit=2')).toEqual([]);
      expect(await fetchUpcoming('channel=all&include=inactive&limit=2')).toEqual([]);
      expect(await fetchUpcoming('channel=wbru-tv&include=inactive&limit=2')).toEqual([]);
      const catalog = await http.request('/api/tags/clips').then((response) => response.json());
      expect(catalog).toContainEqual(expect.objectContaining({ id: 'clp_bw', tags: ['inactive'] }));
      expect(catalog).toContainEqual(expect.objectContaining({ id: 'clp_tv', tags: ['inactive'] }));
    } finally {
      http.database.setClipTagsBatch([
        { id: 'clp_bw', tags: ['black and white'] },
        { id: 'clp_tv', tags: ['indie'] },
      ]);
    }
  });

  it('enforces the channel library independently of replaceable tag filters', async () => {
    expect(clipIds(await fetchUpcoming('channel=wbru-tv&limit=2'))).toEqual(['clp_tv', 'clp_tv']);
    expect(clipIds(await fetchUpcoming('channel=wbru-tv&include=indie&limit=2'))).toEqual([
      'clp_tv',
      'clp_tv',
    ]);
    expect(await fetchUpcoming('channel=wbru-tv&include=360&limit=2')).toEqual([]);
  });

  it('returns an empty program for an impossible filter', async () => {
    expect(await fetchUpcoming('include=indie&exclude=indie&limit=4')).toEqual([]);
  });

  it('pages the filtered sequence with the returned cursor', async () => {
    const [first] = await fetchUpcoming('include=indie&limit=1');
    const next = await http
      .request(
        `/api/program/upcoming?include=indie&limit=1&after=${encodeURIComponent(
          (first as { cursor?: string }).cursor ?? '',
        )}`,
      )
      .then((response) => response.json() as Promise<{ clipId: string }[]>);
    const pair = [clipIds([first])[0], clipIds(next)[0]];
    expect([...pair].sort()).toEqual(['clp_in', 'clp_kbin']);
  });
});

describe('GET /api/channels', () => {
  it('lists only viewer-facing channels with their normal program', async () => {
    const response = await http.request('/api/channels');
    expect(response.status).toBe(200);
    const channels = (await response.json()) as {
      id: string;
      timeline?: string;
      titleOutputId?: string;
      program: {
        video: { kind: string; library?: string; filter?: { includeTags: string[] } };
        audio: { url?: string; kind: string };
      };
      live?: unknown;
    }[];
    expect(channels.map((channel) => channel.id)).not.toContain('all');
    expect(channels.map((channel) => channel.id)).toEqual(
      expect.arrayContaining(['indie', '360', 'wbru-tv']),
    );
    for (const channel of channels) {
      expect(channel.program.video.kind).toBe('clips');
      expect(channel.program.video.library).toBeTruthy();
      expect(channel.live).toBeUndefined();
      expect(channel.timeline).toBe('server');
    }
    const tvChannel = channels.find((channel) => channel.id === 'wbru-tv');
    expect(tvChannel?.titleOutputId).toBe('wbru-tv');
    expect(
      channels
        .filter((channel) => channel.id !== 'wbru-tv')
        .every((channel) => channel.titleOutputId === undefined),
    ).toBe(true);
    expect(tvChannel?.program.video).toMatchObject({
      library: 'wbru-youtube',
      filter: { includeTags: [], excludeTags: [] },
    });
    expect(tvChannel?.program.audio.kind).toBe('embedded');
    expect(channels.find((channel) => channel.id === 'indie')?.program.audio).toEqual({
      kind: 'icecast',
      url: 'https://radio.example.com/indie',
    });
    expect(channels.find((channel) => channel.id === '360')?.program.audio).toEqual({
      kind: 'icecast',
      url: 'https://radio.example.com/360',
    });
  });

  it('leaves radio disabled when endpoints are missing or blank, without changing TV audio', () => {
    const result = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { listChannels } from './server/src/config/channels.ts';
      console.log(JSON.stringify(listChannels().map(channel => channel.program.audio)));
    `,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, RADIO_INDIE_URL: undefined, RADIO_360_URL: '' },
      },
    );
    expect(JSON.parse(result)).toEqual([{ kind: 'none' }, { kind: 'none' }, { kind: 'embedded' }]);
  });

  it('resolves one channel for playback and rejects unknown ids', async () => {
    const indie = await http.request('/api/channel?channel=indie');
    expect(indie.status).toBe(200);
    expect((await indie.json()) as { id: string }).toMatchObject({ id: 'indie' });

    expect((await http.request('/api/channel?channel=typo')).status).toBe(404);
    expect((await http.request('/api/program/upcoming?channel=typo')).status).toBe(404);
  });

  it('exposes the default program and its audio through the channel endpoint', async () => {
    const defaultChannel = await http.request('/api/channel');
    const all = await http.request('/api/channel?channel=all');
    expect(defaultChannel.status).toBe(200);
    const definition = await defaultChannel.json();
    expect(definition).toEqual(await all.json());
    expect(definition).toMatchObject({
      id: 'all',
      program: { video: { kind: 'clips' }, audio: { kind: 'icecast' } },
    });
  });

  it('returns the current position of a named server timeline', async () => {
    expect(http.database.recordPlayout('indie-server', 'indie', 'clp_in', 'indie-slot')).toBe(true);
    const response = await http.request('/api/program/position?channel=indie');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      clip: {
        clipId: 'clp_in',
        title: 'in',
        url: '/clips/in.mp4',
        durationSec: 0,
        cursor: 'indie-slot',
        tags: ['indie'],
      },
      timeSec: expect.any(Number),
    });
    expect((await http.request('/api/program/position?channel=all')).status).toBe(400);
    expect((await http.request('/api/program/position?channel=typo')).status).toBe(404);
  });

  it('serves the operator-only channel through program requests', async () => {
    expect(clipIds(await fetchUpcoming('channel=all&limit=3')).sort()).toEqual([
      'clp_bw',
      'clp_in',
      'clp_kbin',
    ]);
  });
});
