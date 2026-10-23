import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, extname, basename, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprintId } from './lib/clip-id.mjs';

// The reserved wbru-youtube folder selects its own library.
const cliArgs = process.argv.slice(2);
const positionalArgs = cliArgs.filter((argument) => !argument.startsWith('-'));
const clipsDir = process.env.CLIPS_DIR ?? positionalArgs[0] ?? 'public/clips';
const urlPrefix = (process.env.CLIPS_URL_PREFIX ?? positionalArgs[1] ?? '/clips/').replace(
  /\/?$/,
  '/',
);
// CLIPS_FORCE=1 and --force bypass the local scan cache.
const forceReindex = process.env.CLIPS_FORCE === '1' || cliArgs.includes('--force');
// Generated local scan cache, imported into SQLite after indexing.
const manifestPath = join(process.env.TAGGER_DATA_DIR ?? 'server', 'clips-cache.json');
const videoExtensions = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const ignoredNames = new Set(['lost+found']);
const DEFAULT_LIBRARY = 'visualizer';
const LIBRARY_FOLDERS = new Map([['wbru-youtube', 'wbru-youtube']]);
const youtubeArchive =
  process.env.YOUTUBE_ARCHIVE ?? join(clipsDir, '.wbru-youtube-download-archive');
const YOUTUBE_ID_PATTERN = /\[([A-Za-z0-9_-]{11})\](?:\.f\d+)?\.[^.]+$/;
const ffprobeBin = process.env.FFPROBE_BIN ?? 'ffprobe';
let ffprobeUnavailable = false;
let durationProbeFailures = 0;
let firstDurationProbeFailure = null;

const titleFromFilename = (filename) => filename.replace(/[-_]+/g, ' ').trim();

// Read title, upload year, and duration from yt-dlp sidecars when available.
function readVideoMetadata(absolutePath) {
  const metadataPath = absolutePath.replace(/\.[^.]+$/, '.info.json');
  if (!existsSync(metadataPath)) return null;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
    const durationSeconds = Number(metadata.duration);
    const uploadDate = metadata.upload_date;
    return {
      title: title || null,
      durationSec: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
      publishedYear:
        typeof uploadDate === 'string' && /^\d{8}$/.test(uploadDate)
          ? Number(uploadDate.slice(0, 4))
          : null,
    };
  } catch {
    console.warn(`Ignoring invalid video metadata at ${metadataPath}.`);
    return null;
  }
}

const positiveDuration = (value) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

// Probe only uncached media, one file at a time to limit I/O during live operation.
function probeDuration(absolutePath) {
  if (ffprobeUnavailable) {
    durationProbeFailures++;
    return null;
  }
  try {
    const output = execFileSync(
      ffprobeBin,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        absolutePath,
      ],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const duration = positiveDuration(output.trim());
    if (duration !== null) return duration;
  } catch (error) {
    if (error?.code === 'ENOENT') ffprobeUnavailable = true;
  }
  durationProbeFailures++;
  firstDurationProbeFailure ??= absolutePath;
  return null;
}

// Encode each path segment without encoding path separators.
const encodeRelativePath = (relativePath) =>
  relativePath.split(sep).map(encodeURIComponent).join('/');

const completedYoutubeIds = existsSync(youtubeArchive)
  ? new Set(
      readFileSync(youtubeArchive, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).at(-1))
        .filter(Boolean),
    )
  : new Set();

// Admit YouTube outputs only after yt-dlp has recorded their video id as complete.
function isReadyForIndexing(relativePath) {
  const pathParts = relativePath.split(sep);
  if (pathParts[0] !== 'wbru-youtube') return true;
  const youtubeId = basename(relativePath).match(YOUTUBE_ID_PATTERN)?.[1];
  return !youtubeId || completedYoutubeIds.has(youtubeId);
}

// Walk the clip tree recursively while skipping hidden and reserved entries.
function collectVideoPaths(rootDir, currentDir = rootDir) {
  const videoPaths = [];
  for (const entryName of readdirSync(currentDir)) {
    if (entryName.startsWith('.') || ignoredNames.has(entryName)) continue;
    const absolutePath = join(currentDir, entryName);
    let fileStats;
    try {
      fileStats = statSync(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (fileStats.isDirectory()) {
      videoPaths.push(...collectVideoPaths(rootDir, absolutePath));
    } else if (fileStats.isFile() && videoExtensions.has(extname(entryName).toLowerCase())) {
      videoPaths.push(relative(rootDir, absolutePath));
    }
  }
  return videoPaths;
}

// Paths identify untouched files; content IDs let moved files reuse their duration.
const previousByPath = new Map();
const previousDurationById = new Map();
if (!forceReindex && existsSync(manifestPath)) {
  try {
    for (const clip of JSON.parse(readFileSync(manifestPath, 'utf8'))) {
      if (clip.path != null && clip.size != null && clip.mtimeMs != null)
        previousByPath.set(clip.path, clip);
      previousDurationById.set(clip.id, clip.durationSec);
    }
  } catch {
    console.warn(`Ignoring invalid previous manifest at ${manifestPath}.`);
  }
}

// Build manifest records from current files, reusing cached identity and duration when safe.
const clips = collectVideoPaths(clipsDir)
  .filter(isReadyForIndexing)
  .map((relativePath) => {
    const absolutePath = join(clipsDir, relativePath);
    const fileStats = statSync(absolutePath);
    const cachedClip = previousByPath.get(relativePath);
    const unchangedClip =
      cachedClip && cachedClip.size === fileStats.size && cachedClip.mtimeMs === fileStats.mtimeMs
        ? cachedClip
        : null;
    const id = unchangedClip?.id ?? fingerprintId(absolutePath);
    const pathParts = relativePath.split(sep);
    const library = LIBRARY_FOLDERS.get(pathParts[0]) ?? DEFAULT_LIBRARY;
    const metadata = readVideoMetadata(absolutePath);
    const durationSec =
      metadata?.durationSec ??
      positiveDuration(previousDurationById.get(id)) ??
      probeDuration(absolutePath) ??
      0;
    return {
      id,
      title: metadata?.title ?? titleFromFilename(basename(relativePath, extname(relativePath))),
      publishedYear: metadata?.publishedYear ?? null,
      path: relativePath,
      library,
      url: `${urlPrefix}${encodeRelativePath(relativePath)}?v=${encodeURIComponent(id)}`,
      size: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
      durationSec,
    };
  });

// Replace the manifest atomically after the complete scan succeeds.
const temporaryManifestPath = `${manifestPath}.tmp-${process.pid}`;
try {
  writeFileSync(temporaryManifestPath, JSON.stringify(clips, null, 2) + '\n');
  renameSync(temporaryManifestPath, manifestPath);
} finally {
  rmSync(temporaryManifestPath, { force: true });
}
console.log(
  `Wrote ${manifestPath}: ${clips.length} clip(s) from ${clipsDir} (url prefix "${urlPrefix}").`,
);
if (clips.length === 0) console.warn('No video files found - wrote an empty manifest.');
if (durationProbeFailures > 0) {
  const firstFailure = firstDurationProbeFailure
    ? ` First failure: ${firstDurationProbeFailure}.`
    : '';
  console.warn(
    `Could not determine duration for ${durationProbeFailures} clip(s); ` +
      `durationSec remains 0.${firstFailure}`,
  );
}
