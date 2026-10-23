import { describe, it, expect } from 'vitest';
import { getUpcomingFromRows, type ProgramClip } from './program';
import { matchesTagFilter, parseTagFilter } from '../../shared/tagFilter';

const programClip = (id: string, tags: string[] = []): ProgramClip => ({
  id,
  title: id,
  url: `/${id}.mp4`,
  durationSec: 0,
  library: 'visualizer',
  tags,
});

const clips = [programClip('a'), programClip('b'), programClip('c')];
const upcomingClipIds = (after: string | null, limit: number) =>
  getUpcomingFromRows(clips, after, limit).map((clip) => clip.clipId);
const cursorWithPayload = (payload: string) => Buffer.from(payload).toString('base64url');

describe('getUpcomingFromRows', () => {
  it('returns nothing when there are no clips', () => {
    expect(getUpcomingFromRows([], null, 3)).toEqual([]);
  });

  it('respects the limit and is deterministic across calls', () => {
    expect(upcomingClipIds(null, 2)).toHaveLength(2);
    expect(upcomingClipIds(null, 6)).toEqual(upcomingClipIds(null, 6));
  });

  it('plays every clip exactly once per lap, lap after lap', () => {
    const twoLaps = upcomingClipIds(null, 6);
    expect([...twoLaps.slice(0, 3)].sort()).toEqual(['a', 'b', 'c']);
    expect([...twoLaps.slice(3, 6)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('pages forward from a returned cursor', () => {
    const full = getUpcomingFromRows(clips, null, 2);
    const next = getUpcomingFromRows(clips, full[0].cursor, 1)[0];
    expect(next.clipId).toBe(full[1].clipId);
    expect(next.cursor).toBe(full[1].cursor);
  });

  it('restarts at the first slot when the catalog changes', () => {
    const [first] = getUpcomingFromRows(clips, null, 1);
    const changedClips = [...clips, programClip('d')];

    expect(getUpcomingFromRows(changedClips, first.cursor, 1)).toEqual(
      getUpcomingFromRows(changedClips, null, 1),
    );
  });

  it('restarts from the top on a malformed cursor', () => {
    expect(upcomingClipIds('not a real cursor!!', 1)).toEqual(upcomingClipIds(null, 1));
    expect(upcomingClipIds('', 1)).toEqual(upcomingClipIds(null, 1));
  });

  it.each([
    ['infinite', 'Infinity'],
    ['unsafe', String(Number.MAX_SAFE_INTEGER + 1)],
    ['legacy', '0'],
    ['negative', '-1'],
    ['non-integer', '1.5'],
    ['malformed', 'not-a-position'],
  ])('restarts from the top for a %s cursor position', (_label, payload) => {
    expect(upcomingClipIds(cursorWithPayload(payload), 1)).toEqual(upcomingClipIds(null, 1));
  });

  it('carries the row tags through to the refs', () => {
    const [item] = getUpcomingFromRows([programClip('a', ['x', 'y'])], null, 1);
    expect(item.tags).toEqual(['x', 'y']);
  });
});

describe('filtered program', () => {
  const catalog = [
    programClip('bw1', ['black and white']),
    programClip('indie1', ['indie']),
    programClip('kb-indie', ['ken burns', 'indie']),
    programClip('kb1', ['ken burns']),
  ];
  const filteredCatalog = (queryString: string) => {
    const params = new URLSearchParams(queryString);
    const filter = parseTagFilter((key) => params.get(key));
    return catalog.filter((clip) => matchesTagFilter(clip.tags, filter));
  };
  const upcomingIds = (queryString: string, limit: number) =>
    getUpcomingFromRows(filteredCatalog(queryString), null, limit).map((clip) => clip.clipId);

  it('sequences only clips that match an include filter, once per lap', () => {
    const ids = upcomingIds('include=indie', 4);
    expect([...ids.slice(0, 2)].sort()).toEqual(['indie1', 'kb-indie']);
    expect([...ids.slice(2, 4)].sort()).toEqual(['indie1', 'kb-indie']);
  });

  it('honors match=all across includes', () => {
    expect(upcomingIds('include=ken burns,indie&match=all', 3)).toEqual([
      'kb-indie',
      'kb-indie',
      'kb-indie',
    ]);
  });

  it('drops excluded clips from the sequence', () => {
    expect(upcomingIds('include=indie&exclude=ken burns', 2)).toEqual(['indie1', 'indie1']);
  });

  it('an over-narrow filter yields an empty program', () => {
    expect(
      getUpcomingFromRows(
        filteredCatalog('include=black and white&exclude=black and white'),
        null,
        4,
      ),
    ).toEqual([]);
  });
});
