// These algorithms define the order addressed by persisted program cursors.
// Keep them private so scheduling code depends only on stable shuffled indices.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function orderFingerprint(input: string): number {
  return fnv1a(input);
}

// A pool fingerprint and lap number always produce the same Fisher-Yates shuffle.
export function shuffledIndices(
  itemCount: number,
  poolFingerprint: number,
  lapNumber: number,
): number[] {
  const random = mulberry32((poolFingerprint ^ fnv1a(String(lapNumber))) >>> 0);
  const indices = Array.from({ length: itemCount }, (_, index) => index);
  for (let index = itemCount - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]];
  }
  return indices;
}
