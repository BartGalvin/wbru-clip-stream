import { Router, static as serveStatic, type NextFunction, type Response } from 'express';
import { join } from 'node:path';
import type {
  AddVocabTagRequest,
  CatalogRefreshResponse,
  CatalogRevisionResponse,
  ClipTagUpdate,
  ClipSourcesResponse,
  SetClipSourcesRequest,
  SetClipTagsRequest,
  VocabularyDeleteResponse,
  VocabularyUpdateResponse,
} from '../../../shared/contract';
import { routes } from '../../../shared/routes';
import {
  addVocabTag,
  getRecentPlayouts,
  InvalidTagNameError,
  listTaggableClips,
  listTagVocabulary,
  removeVocabTag,
  setClipSources,
  setClipTagsBatch,
  setClipTag,
  UnknownClipError,
} from '../db';
import {
  isRequestBody,
  parseBoundedIntegerQuery,
  parseOptionalIntegerQuery,
  parseScalarQuery,
} from '../httpValidation';
import { markTaggerActivity, rescan } from '../rescan';
import { catalogRevision } from '../tagRevision';
import { getDataDir } from '../db/connection';

function isAddVocabTagRequest(value: unknown): value is AddVocabTagRequest {
  return isRequestBody(value) && typeof value.tag === 'string' && value.tag.trim().length > 0;
}

function isClipTagUpdate(value: unknown): value is ClipTagUpdate {
  return (
    isRequestBody(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string')
  );
}

function isSetClipTagsRequest(value: unknown): value is SetClipTagsRequest {
  return (
    isRequestBody(value) &&
    Array.isArray(value.clips) &&
    value.clips.length > 0 &&
    value.clips.every(isClipTagUpdate)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isSetClipSourcesRequest(value: unknown): value is SetClipSourcesRequest {
  return (
    isRequestBody(value) &&
    Array.isArray(value.ids) &&
    value.ids.length > 0 &&
    value.ids.every((id) => typeof id === 'string' && id.length > 0) &&
    isNullableString(value.source)
  );
}

// Translate expected metadata failures while forwarding unexpected errors.
function handleMetadataError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof UnknownClipError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof InvalidTagNameError) {
    res.status(400).json({ error: error.message });
  } else {
    next(error);
  }
}

// Nginx basic auth is the production security boundary for /api/tags/*.
export function createTagsRouter(): Router {
  const router = Router();

  // Serve cached clip images through the operator authentication boundary.
  router.use(
    routes.tagsThumbnails,
    serveStatic(join(getDataDir(), 'thumbnails'), {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      },
    }),
  );

  // Read and extend the ordered tag vocabulary.
  router.get(routes.tagsVocab, (_req, res) => {
    res.json(listTagVocabulary());
  });

  router.post(routes.tagsVocab, (req, res, next) => {
    if (!isAddVocabTagRequest(req.body)) {
      res.status(400).json({ error: 'body must be { tag: string }' });
      return;
    }
    try {
      const vocab = addVocabTag(req.body.tag);
      const response = { vocab } satisfies VocabularyUpdateResponse;
      res.json(response);
    } catch (error) {
      handleMetadataError(error, res, next);
    }
  });

  // Removing vocabulary also removes that tag from every clip.
  router.delete(`${routes.tagsVocab}/:tag`, (req, res) => {
    const response = removeVocabTag(req.params.tag) satisfies VocabularyDeleteResponse;
    res.json(response);
  });

  // The lightweight revision endpoint drives tagger catalog polling.
  router.get(routes.tagsRevision, (_req, res) => {
    markTaggerActivity();
    const response = { revision: catalogRevision() } satisfies CatalogRevisionResponse;
    res.json(response);
  });

  // Return the full operator catalog with its matching revision header.
  router.get(routes.tagsClips, (_req, res) => {
    markTaggerActivity();
    res.set('X-Catalog-Revision', catalogRevision());
    res.json(listTaggableClips());
  });

  // Read scheduled playout history, optionally filtered by output.
  router.get(routes.tagsPlayout, (req, res) => {
    const limit = parseBoundedIntegerQuery(req.query.limit, 100, 1, 1000);
    if (limit === null) {
      res.status(400).json({ error: 'limit must be a finite integer' });
      return;
    }
    const outputId = parseScalarQuery(req.query.output);
    if (outputId === null) {
      res.status(400).json({ error: 'output must be a scalar value' });
      return;
    }
    const channelId = parseScalarQuery(req.query.channel);
    const since = parseScalarQuery(req.query.since);
    const until = parseScalarQuery(req.query.until);
    const search = parseScalarQuery(req.query.q);
    if (channelId === null || since === null || until === null || search === null) {
      res.status(400).json({ error: 'playout filters must be scalar values' });
      return;
    }
    if (
      [since, until].some((value) => value !== undefined && !Number.isFinite(Date.parse(value)))
    ) {
      res.status(400).json({ error: 'playout timestamps must be valid dates' });
      return;
    }
    const beforeId = parseOptionalIntegerQuery(req.query.beforeId);
    if (beforeId === null) {
      res.status(400).json({ error: 'beforeId must be a positive integer' });
      return;
    }
    const afterId = parseOptionalIntegerQuery(req.query.afterId, 0);
    if (afterId === null) {
      res.status(400).json({ error: 'afterId must be a non-negative integer' });
      return;
    }
    res.json(
      getRecentPlayouts({
        limit,
        outputId,
        channelId,
        beforeId,
        afterId,
        // Date filters use UTC regardless of the request's date format.
        since: since === undefined ? undefined : new Date(since).toISOString(),
        until: until === undefined ? undefined : new Date(until).toISOString(),
        search,
      }),
    );
  });

  // Replace complete tag sets in one atomic batch.
  router.post(routes.tagsClips, (req, res, next) => {
    if (!isSetClipTagsRequest(req.body)) {
      res.status(400).json({ error: 'body must be { clips: { id, tags }[] }' });
      return;
    }
    try {
      setClipTagsBatch(req.body.clips);
      res.status(204).end();
    } catch (error) {
      handleMetadataError(error, res, next);
    }
  });

  // Add or remove one tag using the clip's current tag set.
  router.patch(`${routes.tagsClips}/:id/tags`, (req, res, next) => {
    if (
      !isRequestBody(req.body) ||
      typeof req.body.tag !== 'string' ||
      !req.body.tag.trim() ||
      typeof req.body.enabled !== 'boolean'
    ) {
      res.status(400).json({ error: 'body must be { tag: string, enabled: boolean }' });
      return;
    }
    try {
      res.json(setClipTag(req.params.id, req.body.tag, req.body.enabled));
    } catch (error) {
      handleMetadataError(error, res, next);
    }
  });

  // Apply one source label to a validated batch of clips.
  router.post(routes.tagsClipSource, (req, res, next) => {
    if (!isSetClipSourcesRequest(req.body)) {
      res.status(400).json({ error: 'body must be { ids: string[], source: string | null }' });
      return;
    }
    try {
      const response = setClipSources(req.body.ids, req.body.source) satisfies ClipSourcesResponse;
      res.json(response);
    } catch (error) {
      handleMetadataError(error, res, next);
    }
  });

  // Run a foreground filesystem scan and reconcile the resulting manifest.
  router.post(routes.tagsRefresh, async (req, res) => {
    if (process.env.CLIPS_SCAN_ENABLED === '0') {
      res
        .status(409)
        .json({ error: 'Catalog scans are disabled when using remote development media.' });
      return;
    }
    const force = parseScalarQuery(req.query.force);
    const afterCurrent = parseScalarQuery(req.query.afterCurrent);
    if (force === null || afterCurrent === null) {
      res.status(400).json({ error: 'force and afterCurrent must be scalar values' });
      return;
    }
    markTaggerActivity();
    try {
      const response = (await rescan({
        force: force === '1',
        afterCurrent: afterCurrent === '1',
      })) satisfies CatalogRefreshResponse;
      res.json(response);
    } catch (error) {
      console.error('Clip catalog refresh failed', error);
      res.status(500).json({ error: 'clip catalog refresh failed; check server logs' });
    }
  });

  return router;
}
