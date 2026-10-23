import { Router, type Response } from 'express';
import { activeProgram, getClipFilter } from '../../../shared/contract';
import { routes } from '../../../shared/routes';
import { effectiveFilter, parseTagFilter, type TagFilter } from '../../../shared/tagFilter';
import { channelInfo, getChannel, listChannels } from '../config/channels';
import { getCurrentPlayout, getProgramPosition } from '../db';
import { parseBoundedIntegerQuery, parseScalarQuery } from '../httpValidation';
import { getUpcomingProgramClips } from '../programCatalog';

const DEFAULT_CHANNEL = 'all';
const OUTPUT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// All program endpoints share the same default channel and lookup errors.
function resolveRequestedChannel(value: unknown, res: Response) {
  const channelId = parseScalarQuery(value);
  if (channelId === null) {
    res.status(400).json({ error: 'unknown channel' });
    return;
  }
  const channel = getChannel(channelId ?? DEFAULT_CHANNEL);
  if (!channel) {
    res.status(channelId === undefined ? 503 : 404).json({ error: 'unknown channel' });
  }
  return channel;
}

function parseRequestedFilter(query: Record<string, unknown>): TagFilter | null {
  const include = parseScalarQuery(query.include);
  const exclude = parseScalarQuery(query.exclude);
  const match = parseScalarQuery(query.match);
  if (include === null || exclude === null || match === null) return null;

  const values: Record<string, string | undefined> = { include, exclude, match };
  return parseTagFilter((key) => values[key]);
}

export function createProgramRouter(): Router {
  const router = Router();

  // List channels intended for viewer-facing selection.
  router.get(routes.channels, (_req, res) => {
    res.json(listChannels());
  });

  // Resolve one channel, defaulting to the internal all-clips program.
  router.get(routes.channel, (req, res) => {
    const channel = resolveRequestedChannel(req.query.channel, res);
    if (!channel) return;
    res.json(channelInfo(channel));
  });

  // Apply channel and URL filters before deriving the next deterministic page.
  router.get(routes.programUpcoming, (req, res) => {
    const channel = resolveRequestedChannel(req.query.channel, res);
    if (!channel) return;
    const video = activeProgram(channel).video;
    const channelFilter = getClipFilter(video);
    if (!channelFilter || video.kind !== 'clips') {
      res.status(400).json({ error: `channel ${channel.id} has no clip program` });
      return;
    }
    const after = parseScalarQuery(req.query.after);
    if (after === null) {
      res.status(400).json({ error: 'after must be a scalar value' });
      return;
    }
    const limit = parseBoundedIntegerQuery(req.query.limit, 4, 1, 50);
    if (limit === null) {
      res.status(400).json({ error: 'limit must be a finite integer' });
      return;
    }
    const requestedFilter = parseRequestedFilter(req.query);
    if (!requestedFilter) {
      res.status(400).json({ error: 'filter values must be scalar' });
      return;
    }
    const filter = effectiveFilter(channelFilter, requestedFilter);
    res.json(getUpcomingProgramClips(video, filter, after ?? null, limit));
  });

  // Return the current media position for channels driven by the server clock.
  router.get(routes.programPosition, (req, res) => {
    const channel = resolveRequestedChannel(req.query.channel, res);
    if (!channel) return;
    if (!channel.serverTimelineOutputId) {
      res.status(400).json({ error: `channel ${channel.id} has no server timeline` });
      return;
    }
    const position = getProgramPosition(channel.serverTimelineOutputId);
    if (!position) {
      res.status(204).end();
      return;
    }
    res.json(position);
  });

  // Return the title while its scheduled playout record is current.
  router.get(routes.programCurrent, (req, res) => {
    const outputId = parseScalarQuery(req.query.output);
    if (typeof outputId !== 'string' || !OUTPUT_ID.test(outputId)) {
      res.status(400).json({ error: 'output must be a valid output id' });
      return;
    }
    const current = getCurrentPlayout(outputId);
    if (!current) {
      res.status(204).end();
      return;
    }
    res.json(current);
  });

  return router;
}
