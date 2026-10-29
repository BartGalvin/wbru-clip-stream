import type { ClipRef } from '../../shared/contract';

// Display metadata from the playing clip, or clear it when playback stops.
export function renderTitleOverlay(
  overlay: HTMLElement,
  title: HTMLElement,
  clip: Pick<ClipRef, 'title' | 'publishedYear'> | null,
): void {
  const text = clip?.title ?? '';
  title.textContent = clip?.publishedYear ? `${text} (${clip.publishedYear})` : text;
  overlay.classList.toggle('visible', clip !== null);
  overlay.setAttribute('aria-hidden', String(clip === null));
}
