export const VISUALIZER_LIBRARY = {
  id: 'visualizer',
  name: 'Visualizer',
} as const;

export const WBRU_YOUTUBE_LIBRARY = {
  id: 'wbru-youtube',
  name: 'WBRU YouTube',
} as const;

export const CLIP_LIBRARIES = [VISUALIZER_LIBRARY, WBRU_YOUTUBE_LIBRARY] as const;

// Inactive clips and untagged visualizer clips remain editable but do not enter rotation.
export function isClipEligibleForRotation(clip: {
  library: string;
  tags: readonly string[];
}): boolean {
  return (
    !clip.tags.includes('inactive') &&
    (clip.library !== VISUALIZER_LIBRARY.id || clip.tags.length > 0)
  );
}

const LIBRARY_NAMES: Readonly<Record<string, string>> = {
  [VISUALIZER_LIBRARY.id]: VISUALIZER_LIBRARY.name,
  [WBRU_YOUTUBE_LIBRARY.id]: WBRU_YOUTUBE_LIBRARY.name,
};

// Preserve unknown library ids while presenting known ones with friendly names.
export function libraryName(id: string): string {
  return LIBRARY_NAMES[id] ?? id;
}
