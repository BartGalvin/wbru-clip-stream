import type {
  CatalogRefreshResponse,
  CatalogRevisionResponse,
  ClipTagUpdate,
  ClipSourcesResponse,
  TaggableClip,
  VocabularyDeleteResponse,
  VocabularyUpdateResponse,
} from '../../shared/contract';
import { routes } from '../../shared/routes';

async function requireSuccessfulResponse(response: Response): Promise<void> {
  if (!response.ok) throw new Error(await response.text().catch(() => String(response.status)));
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  await requireSuccessfulResponse(response);
  return (await response.json()) as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const fetchTagVocabulary = (): Promise<string[]> =>
  fetch(routes.tagsVocab).then((response) => readJsonResponse<string[]>(response));

export const fetchClipCatalog = (): Promise<{ clips: TaggableClip[]; revision: string }> =>
  fetch(routes.tagsClips).then(async (response) => ({
    clips: await readJsonResponse<TaggableClip[]>(response),
    revision: response.headers.get('X-Catalog-Revision') ?? '',
  }));

export const fetchCatalogRevision = (): Promise<string> =>
  fetch(routes.tagsRevision)
    .then((response) => readJsonResponse<CatalogRevisionResponse>(response))
    .then(({ revision }) => revision);

export const saveClipTags = (clips: ClipTagUpdate[]): Promise<void> =>
  fetch(routes.tagsClips, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ clips }),
  }).then(requireSuccessfulResponse);

export const saveClipSources = (
  ids: string[],
  source: string | null,
): Promise<ClipSourcesResponse> =>
  fetch(routes.tagsClipSource, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids, source }),
  }).then((response) => readJsonResponse<ClipSourcesResponse>(response));

// Vocabulary changes are server-owned because deletion can affect every clip.
export const addTagToVocabulary = (tag: string): Promise<VocabularyUpdateResponse> =>
  fetch(routes.tagsVocab, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ tag }),
  }).then((response) => readJsonResponse<VocabularyUpdateResponse>(response));

export const deleteTagFromVocabulary = (tag: string): Promise<VocabularyDeleteResponse> =>
  fetch(`${routes.tagsVocab}/${encodeURIComponent(tag)}`, { method: 'DELETE' }).then((response) =>
    readJsonResponse<VocabularyDeleteResponse>(response),
  );

export const refreshClipCatalog = (): Promise<CatalogRefreshResponse> =>
  fetch(routes.tagsRefresh, { method: 'POST' }).then((response) =>
    readJsonResponse<CatalogRefreshResponse>(response),
  );
