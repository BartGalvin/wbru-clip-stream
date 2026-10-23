// Runtime filter with set semantics for repeated membership checks.
export interface TagFilter {
  includeTags: Set<string>;
  excludeTags: Set<string>;
  matchAll: boolean;
}

// JSON-safe API and configuration form of TagFilter.
export interface TagFilterJson {
  includeTags: string[];
  excludeTags: string[];
  matchAll: boolean;
}

// Restore set semantics after a filter crosses a JSON boundary.
export function fromTagFilterJson(filter: TagFilterJson): TagFilter {
  return {
    includeTags: new Set(filter.includeTags),
    excludeTags: new Set(filter.excludeTags),
    matchAll: filter.matchAll,
  };
}

// Exclusions win; includes then use either all-tag or any-tag matching.
export function matchesTagFilter(tags: string[], filter: TagFilter): boolean {
  for (const excludedTag of filter.excludeTags) {
    if (tags.includes(excludedTag)) return false;
  }
  if (!filter.includeTags.size) return true;
  return filter.matchAll
    ? [...filter.includeTags].every((tag) => tags.includes(tag))
    : [...filter.includeTags].some((tag) => tags.includes(tag));
}

// Empty request filters signal that the channel default should remain active.
export function isEmptyTagFilter(filter: TagFilter): boolean {
  return filter.includeTags.size === 0 && filter.excludeTags.size === 0;
}

// Tag order is irrelevant, and match-all matters only with multiple included tags.
export function sameTagFilter(left: TagFilter, right: TagFilter): boolean {
  return (
    left.includeTags.size === right.includeTags.size &&
    left.excludeTags.size === right.excludeTags.size &&
    [...left.includeTags].every((tag) => right.includeTags.has(tag)) &&
    [...left.excludeTags].every((tag) => right.excludeTags.has(tag)) &&
    (left.includeTags.size < 2 || left.matchAll === right.matchAll)
  );
}

// An explicit request filter replaces the channel default rather than narrowing it.
export function effectiveFilter(channelDefault: TagFilter, request: TagFilter): TagFilter {
  return isEmptyTagFilter(request) ? channelDefault : request;
}

// Query format: include=a,b&exclude=c&match=all. Default values are omitted.
export function encodeTagFilter(filter: TagFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.includeTags.size) params.set('include', [...filter.includeTags].join(','));
  if (filter.excludeTags.size) params.set('exclude', [...filter.excludeTags].join(','));
  if (filter.matchAll) params.set('match', 'all');
  return params;
}

// Read through a getter so browser parameters and validated server queries share one format.
export function parseTagFilter(get: (key: string) => string | null | undefined): TagFilter {
  const parseList = (value: string | null | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  return {
    includeTags: new Set(parseList(get('include'))),
    excludeTags: new Set(parseList(get('exclude'))),
    matchAll: get('match') === 'all',
  };
}
