import { fromTagFilterJson, type TagFilter, type TagFilterJson } from './tagFilter';

// Video inputs supported by channel configuration.
export type VideoSource =
  | { kind: 'clips'; library: string; filter: TagFilterJson }
  | { kind: 'hls'; url: string }
  | { kind: 'youtube'; playlistId: string };

// Clip filters exist only for catalog-backed video sources.
export function getClipFilter(video: VideoSource): TagFilter | null {
  return video.kind === 'clips' ? fromTagFilterJson(video.filter) : null;
}

// External station streams played separately from channel video.
export type StationAudio = { kind: 'icecast'; url: string } | { kind: 'hls'; url: string };

// Channel audio may be external, embedded in video, or intentionally silent.
export type AudioSource = StationAudio | { kind: 'embedded' } | { kind: 'none' };

// Narrow audio sources that require a separate station stream player.
export function isStationAudio(audio: AudioSource): audio is StationAudio {
  return audio.kind === 'icecast' || audio.kind === 'hls';
}

// The paired video and audio sources that make up one channel program.
export interface ChannelProgram {
  video: VideoSource;
  audio: AudioSource;
}

// Public channel configuration sent to the stream player and builder.
export interface ChannelInfo {
  id: string;
  name: string;
  program: ChannelProgram;
  // Server-timed channels join one shared program position.
  timeline?: 'server';
  // Output whose current title is rendered over this channel's video.
  titleOutputId?: string;
  // A live program overrides the normal program while present.
  live?: ChannelProgram;
}

// A configured live program takes precedence without changing the base lineup.
export function activeProgram(channel: ChannelInfo): ChannelProgram {
  return channel.live ?? channel.program;
}

// Operator-facing catalog record with file identity and editable metadata.
export interface TaggableClip {
  id: string;
  title: string;
  url: string;
  path: string; // decoded relative path under clips/, e.g. "black and white/foo.mp4"
  library: string; // catalog-assigned collection; not editable in the tagger
  tags: string[];
  source: string | null;
}

// A clip may repeat across laps, so its cursor identifies a specific program slot.
export interface ClipRef {
  clipId: string; // the clip's content id
  title: string;
  publishedYear?: number | null;
  url: string;
  durationSec: number;
  cursor: string; // pass as `after` to fetch the clips that follow this one
  tags: string[];
}

// Current clip and elapsed time on a server-owned program timeline.
export interface ProgramPosition {
  clip: ClipRef;
  timeSec: number;
}

// Request body for appending one tag to the operator vocabulary.
export interface AddVocabTagRequest {
  tag: string;
}

// One clip's complete tag set in a metadata update.
export interface ClipTagUpdate {
  id: string;
  tags: string[];
}

// Request body for replacing tags on one or more clips.
export interface SetClipTagsRequest {
  clips: ClipTagUpdate[];
}

// Request body for replacing or clearing the source on one or more clips.
export interface SetClipSourcesRequest {
  ids: string[];
  source: string | null;
}

// Current scheduled clip reported by the program API.
export interface CurrentPlayout {
  outputId: string;
  channelId: string;
  clipId: string;
  title: string;
  // YouTube upload year, when present in the clip metadata.
  publishedYear?: number | null;
  // UTC ISO 8601 timestamp with milliseconds.
  startedAt: string;
  durationSec: number;
}

// The log browser and database use the same history window.
export const PLAYOUT_RETENTION_DAYS = 7;

// Stored playout event with additional fields needed for audit history.
export interface RecentPlayout extends CurrentPlayout {
  id: number;
  cursor: string;
  path: string;
  library: string;
  source: string | null;
  // Current media location, or null when the clip is no longer available.
  previewUrl: string | null;
  // Current inactive tag, independent of the recorded play.
  inactive: boolean;
}

// Lightweight polling response used to detect catalog changes.
export interface CatalogRevisionResponse {
  revision: string;
}

// Persisted source state returned after editing a batch of clips.
export interface ClipSourcesResponse {
  ids: string[];
  source: string | null;
}

// Updated ordered vocabulary returned after an addition.
export interface VocabularyUpdateResponse {
  vocab: string[];
}

// Vocabulary deletion result, including how many clips were changed.
export interface VocabularyDeleteResponse extends VocabularyUpdateResponse {
  affected: number;
}

// Filesystem reconciliation counts returned after a foreground scan.
export interface CatalogRefreshResponse {
  added: number;
  removed: number;
  total: number;
}
