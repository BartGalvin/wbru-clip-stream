import { describe, expect, it } from 'vitest';
import type { ChannelInfo } from '../../shared/contract';
import { routes } from '../../shared/routes';
import { fetchBuilderData } from './api';

describe('builder API', () => {
  it('fetches the default channel separately from the viewer-facing channels', async () => {
    const defaultChannel: ChannelInfo = {
      id: 'all',
      name: 'All',
      program: {
        video: {
          kind: 'clips',
          library: 'visualizer',
          filter: { includeTags: [], excludeTags: [], matchAll: false },
        },
        audio: { kind: 'icecast', url: 'https://audio.example/listen' },
      },
    };
    const requested: string[] = [];
    const payloads = new Map<string, unknown>([
      [routes.tagsVocab, ['indie']],
      [
        routes.tagsClips,
        [
          {
            id: 'one',
            title: 'One',
            url: '/clips/one.mp4',
            path: 'one.mp4',
            library: 'visualizer',
            tags: ['indie'],
            source: null,
          },
        ],
      ],
      [
        routes.channels,
        [
          {
            id: 'indie',
            name: 'WBRU Indie',
            program: {
              video: {
                kind: 'clips',
                library: 'visualizer',
                filter: { includeTags: [], excludeTags: [], matchAll: false },
              },
              audio: { kind: 'none' },
            },
          },
        ],
      ],
      [routes.channel, defaultChannel],
    ]);
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return Response.json(payloads.get(url));
    }) as typeof fetch;

    const data = await fetchBuilderData(fetcher);

    expect(requested).toEqual([
      routes.tagsVocab,
      routes.tagsClips,
      routes.channels,
      routes.channel,
    ]);
    expect(data.vocab).toEqual(['indie']);
    expect(data.clips[0]?.library).toBe('visualizer');
    expect(data.channels[0]?.id).toBe('indie');
    expect(data.channels.map((channel) => channel.id)).not.toContain('all');
    expect(data.defaultChannel).toEqual(defaultChannel);
  });

  it.each([routes.tagsClips, routes.channel])('reports an HTTP failure from %s', async (route) => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return url === route ? new Response(null, { status: 503 }) : Response.json([]);
    }) as typeof fetch;

    await expect(fetchBuilderData(fetcher)).rejects.toThrow(`${route} -> 503`);
  });
});
