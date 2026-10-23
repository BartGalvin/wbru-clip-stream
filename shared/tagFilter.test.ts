import { describe, it, expect } from 'vitest';
import {
  encodeTagFilter,
  parseTagFilter,
  matchesTagFilter,
  effectiveFilter,
  isEmptyTagFilter,
  sameTagFilter,
  type TagFilter,
} from './tagFilter';

const createFilter = (overrides: Partial<TagFilter> = {}): TagFilter => ({
  includeTags: overrides.includeTags ?? new Set(),
  excludeTags: overrides.excludeTags ?? new Set(),
  matchAll: overrides.matchAll ?? false,
});

const parseQueryFilter = (queryString: string) => {
  const params = new URLSearchParams(queryString);
  return parseTagFilter((key) => params.get(key));
};

describe('sameTagFilter', () => {
  it('compares tag membership regardless of order', () => {
    expect(
      sameTagFilter(
        parseQueryFilter('include=a,b&exclude=c,d'),
        parseQueryFilter('include=b,a&exclude=d,c'),
      ),
    ).toBe(true);
    expect(sameTagFilter(parseQueryFilter('include=a'), parseQueryFilter('include=b'))).toBe(false);
    expect(sameTagFilter(parseQueryFilter('exclude=a'), parseQueryFilter('exclude=b'))).toBe(false);
  });

  it('compares match mode only when multiple tags are included', () => {
    expect(sameTagFilter(parseQueryFilter(''), parseQueryFilter('match=all'))).toBe(true);
    expect(
      sameTagFilter(parseQueryFilter('include=a'), parseQueryFilter('include=a&match=all')),
    ).toBe(true);
    expect(
      sameTagFilter(parseQueryFilter('include=a,b'), parseQueryFilter('include=a,b&match=all')),
    ).toBe(false);
  });
});

describe('encode/parse round-trip', () => {
  it('round-trips an empty filter through an empty query', () => {
    const params = encodeTagFilter(createFilter());
    expect(params.toString()).toBe('');
    const parsed = parseTagFilter((key) => params.get(key));
    expect(isEmptyTagFilter(parsed)).toBe(true);
    expect(parsed.matchAll).toBe(false);
  });

  it('preserves includes, excludes, and matchAll', () => {
    const original = createFilter({
      includeTags: new Set(['a', 'b']),
      excludeTags: new Set(['c']),
      matchAll: true,
    });
    const parsed = parseTagFilter((key) => encodeTagFilter(original).get(key));
    expect([...parsed.includeTags]).toEqual(['a', 'b']);
    expect([...parsed.excludeTags]).toEqual(['c']);
    expect(parsed.matchAll).toBe(true);
  });

  it('omits defaults from the query string', () => {
    const tagFilter = createFilter({ includeTags: new Set(['x']) });
    expect(encodeTagFilter(tagFilter).toString()).toBe('include=x');
  });
});

describe('parseTagFilter tolerance', () => {
  it('trims whitespace and drops blanks', () => {
    const tagFilter = parseQueryFilter('include=a,%20b%20,,c');
    expect([...tagFilter.includeTags]).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing match parameter as match-any', () => {
    expect(parseQueryFilter('include=a,b').matchAll).toBe(false);
    expect(parseQueryFilter('include=a,b&match=all').matchAll).toBe(true);
    expect(parseQueryFilter('include=a,b&match=any').matchAll).toBe(false);
  });
});

describe('parsed filter drives matching', () => {
  it('matches either or all included tags according to the mode', () => {
    const matchAny = parseQueryFilter('include=ken burns,indie');
    const matchAll = parseQueryFilter('include=ken burns,indie&match=all');
    expect(matchesTagFilter(['ken burns'], matchAny)).toBe(true);
    expect(matchesTagFilter(['ken burns'], matchAll)).toBe(false);
    expect(matchesTagFilter(['ken burns', 'indie'], matchAll)).toBe(true);
  });

  it('lets exclusions override inclusions', () => {
    const tagFilter = parseQueryFilter('include=indie&exclude=360');
    expect(matchesTagFilter(['indie'], tagFilter)).toBe(true);
    expect(matchesTagFilter(['indie', '360'], tagFilter)).toBe(false);
  });
});

describe('effectiveFilter', () => {
  it('uses the channel default when the request filter is empty', () => {
    const channel = parseQueryFilter('include=indie');
    expect(effectiveFilter(channel, parseQueryFilter(''))).toBe(channel);
  });

  it('replaces the channel default with a non-empty request filter', () => {
    const channel = parseQueryFilter('include=indie');
    const request = parseQueryFilter('include=cartoon,indie');
    const effective = effectiveFilter(channel, request);
    expect(effective).toBe(request);
    expect(matchesTagFilter(['cartoon'], effective)).toBe(true);
    expect(matchesTagFilter(['indie'], effective)).toBe(true);
  });
});
