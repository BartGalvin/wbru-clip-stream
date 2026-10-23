// Cheap change signal for tagger clients. The catalog itself is large, so clients poll
// this token and fetch /clips only when a write or filesystem reconciliation changed it.
const epoch = Date.now().toString(36);
let revision = 0;

// Combine a process epoch with the in-process revision to survive restarts.
export function catalogRevision(): string {
  return `${epoch}:${revision}`;
}

// Every successful catalog or metadata write advances the polling token.
export function markCatalogChanged(): string {
  revision++;
  return catalogRevision();
}
