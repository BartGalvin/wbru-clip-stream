import { describe, expect, it } from 'vitest';
import { resolvePageAlias } from './vite.config';

describe('resolvePageAlias', () => {
  it.each([
    ['/?channel=indie', '/stream.html?channel=indie'],
    ['/tag?include=black%20and%20white', '/tag.html?include=black%20and%20white'],
    ['/stream?channel=360', '/stream.html?channel=360'],
    ['/builder?include=indie', '/builder.html?include=indie'],
    ['/playout?channel=wbru-tv', '/playout.html?channel=wbru-tv'],
  ])('matches %s by pathname and preserves its query string', (requestUrl, target) => {
    expect(resolvePageAlias(requestUrl)).toBe(target);
  });

  it.each(['/missing?channel=indie', '/title'])('does not redirect %s', (requestUrl) => {
    expect(resolvePageAlias(requestUrl)).toBeUndefined();
  });
});
