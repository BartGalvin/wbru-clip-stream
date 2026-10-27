const TAGS_ROUTE = '/api/tags';

export const routes = {
  channel: '/api/channel',
  channels: '/api/channels',
  programUpcoming: '/api/program/upcoming',
  programPosition: '/api/program/position',
  programCurrent: '/api/program/current',
  tagsVocab: `${TAGS_ROUTE}/vocab`,
  tagsClips: `${TAGS_ROUTE}/clips`,
  tagsRevision: `${TAGS_ROUTE}/revision`,
  tagsClipSource: `${TAGS_ROUTE}/clip-source`,
  tagsRefresh: `${TAGS_ROUTE}/refresh`,
  tagsPlayout: `${TAGS_ROUTE}/playout`,
  tagsThumbnails: `${TAGS_ROUTE}/thumbnails`,
} as const;
