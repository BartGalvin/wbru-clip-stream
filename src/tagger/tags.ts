import type { TaggableClip } from '../../shared/contract';

// Display paths relative to their clip library while retaining the full stored path elsewhere.
const pathWithinLibrary = (clip: TaggableClip): string =>
  clip.path.startsWith(`${clip.library}/`) ? clip.path.slice(clip.library.length + 1) : clip.path;

export const getClipFolder = (clip: TaggableClip): string => {
  const path = pathWithinLibrary(clip);
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(root)';
};

export const getClipFilename = (clip: TaggableClip): string => {
  const path = pathWithinLibrary(clip);
  return path.slice(path.lastIndexOf('/') + 1);
};

export const isUntagged = (clip: TaggableClip): boolean => clip.tags.length === 0;
