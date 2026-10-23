import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CATALOG_REFRESH_INTERVAL_MS = 2 * 60_000;
const CATALOG_REFRESH_TIMEOUT_MS = 10 * 60_000;

const channelUrl = process.env.YOUTUBE_CHANNEL_URL?.trim();
if (!channelUrl) throw new Error('Set YOUTUBE_CHANNEL_URL before downloading.');
const clipsRoot = process.env.CLIPS_DIR ?? '/srv/wbru/clips';
const outputDir = join(clipsRoot, 'wbru-youtube');
const archive = process.env.YOUTUBE_ARCHIVE ?? join(clipsRoot, '.wbru-youtube-download-archive');
const cacheDir = process.env.YOUTUBE_CACHE_DIR ?? join(clipsRoot, '.yt-dlp-cache');
const ytDlp = process.env.YT_DLP_BIN ?? 'yt-dlp';
const cookiesFile = process.env.YOUTUBE_COOKIES_FILE?.trim();
const refreshUrl =
  process.env.PROGRAM_REFRESH_URL === undefined
    ? 'http://127.0.0.1:3001/api/tags/refresh?force=0'
    : process.env.PROGRAM_REFRESH_URL;

mkdirSync(outputDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

// Stream child output live and return its exit status without treating nonzero exits as spawn failures.
function runCommand(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, commandArgs, { stdio: 'inherit', env: process.env });
    childProcess.on('error', reject);
    childProcess.on('exit', (code) => resolve(code ?? 1));
  });
}

// Ask the running server to update its catalog.
async function refreshCatalog(afterCurrent = false) {
  if (!refreshUrl) return true;
  try {
    const url = new globalThis.URL(refreshUrl);
    if (afterCurrent) url.searchParams.set('afterCurrent', '1');
    const response = await globalThis.fetch(url, {
      method: 'POST',
      signal: globalThis.AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`catalog refresh returned ${response.status}`);
    console.log('Catalog refreshed:', await response.text());
    return true;
  } catch (error) {
    console.warn(`Catalog refresh request failed: ${String(error)}`);
    return false;
  }
}

let refreshInFlight = null;
// Share a pending refresh request between periodic ticks.
function queueRefresh(afterCurrent = false) {
  if (!refreshInFlight) {
    refreshInFlight = refreshCatalog(afterCurrent).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Prefer 1080p H.264/M4A and retain the archive and sidecar metadata required by the indexer.
const downloadArgs = [
  '--newline',
  '--no-abort-on-error',
  '--continue',
  '--no-overwrites',
  '--js-runtimes',
  'node',
  '--sleep-interval',
  '5',
  '--max-sleep-interval',
  '10',
  '--cache-dir',
  cacheDir,
  '--download-archive',
  archive,
  '--write-info-json',
  '--clean-info-json',
  '--no-write-playlist-metafiles',
  '--concurrent-fragments',
  '4',
  '--format',
  'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080][ext=mp4]/best[height<=1080]/best',
  '--merge-output-format',
  'mp4',
  '--output',
  `${outputDir}/%(upload_date)s - %(title).150B [%(id)s].%(ext)s`,
];

if (cookiesFile) downloadArgs.push('--cookies', cookiesFile);
downloadArgs.push(channelUrl);

// Refresh before, during, and after the download so completed files enter the catalog promptly.
const downloadPromise = runCommand(ytDlp, downloadArgs);
await queueRefresh();
const refreshTimer = globalThis.setInterval(() => void queueRefresh(), CATALOG_REFRESH_INTERVAL_MS);
const downloadCode = await downloadPromise;
globalThis.clearInterval(refreshTimer);

if (downloadCode !== 0) {
  console.warn(`yt-dlp exited ${downloadCode}; indexing files that completed successfully.`);
}

// The final scan must start after the last download, including scans queued by other callers.
await refreshInFlight;
const refreshed = await queueRefresh(true);

if (downloadCode !== 0 || !refreshed) process.exitCode = downloadCode || 1;
