// @vitest-environment happy-dom

import { expect, it } from 'vitest';
import { renderTitleOverlay } from './titleOverlay';

it.each([
  { publishedYear: undefined, expectedTitle: 'Studio Session' },
  { publishedYear: null, expectedTitle: 'Studio Session' },
  { publishedYear: 2014, expectedTitle: 'Studio Session (2014)' },
])('shows $expectedTitle and clears it when stopped', ({ publishedYear, expectedTitle }) => {
  const overlay = document.createElement('div');
  const title = document.createElement('div');

  renderTitleOverlay(overlay, title, { title: 'Studio Session', publishedYear });

  expect(title.textContent).toBe(expectedTitle);
  expect(overlay.classList.contains('visible')).toBe(true);
  expect(overlay.getAttribute('aria-hidden')).toBe('false');

  renderTitleOverlay(overlay, title, null);
  expect(title.textContent).toBe('');
  expect(overlay.classList.contains('visible')).toBe(false);
  expect(overlay.getAttribute('aria-hidden')).toBe('true');
});
