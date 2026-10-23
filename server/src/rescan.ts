import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refreshClips } from './db';

// Counts returned after the indexed manifest is reconciled with SQLite.
type ScanResult = { added: number; removed: number; total: number };

// force rereads file metadata; afterCurrent waits for a scan started after this request.
type ScanOptions = { force?: boolean; afterCurrent?: boolean };
type Scan = { promise: Promise<ScanResult>; force: boolean };

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const indexScript = join(repoRoot, 'scripts', 'index-clips.mjs');

const TAGGER_ACTIVE_WINDOW_MS = 120_000;
const AUTO_RESCAN_INTERVAL_MS = 30_000;

// Run the standalone indexer in the same process environment as the server.
export function runClipIndexer(force: boolean): Promise<void> {
  const args = force ? [indexScript, '--force'] : [indexScript];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else if (signal) reject(new Error(`index-clips terminated by ${signal}`));
      else reject(new Error(`index-clips exited with code ${code ?? 'unknown'}`));
    });
  });
}

// Share active scans unless a caller needs a fresh or forced follow-up.
export function createScanQueue(
  runScan: (force: boolean) => Promise<ScanResult>,
): (options?: ScanOptions) => Promise<ScanResult> {
  let activeScan: Scan | null = null;
  let followUp: Scan | null = null;

  const startScan = (force: boolean): Promise<ScanResult> => {
    const promise = runScan(force).finally(() => {
      if (!followUp) activeScan = null;
    });
    activeScan = { promise, force };
    return promise;
  };

  return ({ force = false, afterCurrent = false } = {}): Promise<ScanResult> => {
    if (!activeScan) return startScan(force);
    if (!afterCurrent && (!force || activeScan.force)) return activeScan.promise;

    if (followUp) {
      followUp.force ||= force;
    } else {
      // A failed scan still releases the queue for the next request.
      const queued: Scan = {
        force,
        promise: activeScan.promise
          .catch(() => undefined)
          .then(() => {
            followUp = null;
            return startScan(queued.force);
          }),
      };
      followUp = queued;
    }
    return followUp.promise;
  };
}

const queuedRescan = createScanQueue(async (force) => {
  await runClipIndexer(force);
  return refreshClips();
});

export function rescan(options?: ScanOptions): Promise<ScanResult> {
  return queuedRescan(options);
}

let lastTaggerActivity: number | null = null;

export function markTaggerActivity(): void {
  lastTaggerActivity = Date.now();
}

// Scan periodically while an operator has recently used the tagger.
export function startAutoRescan(): () => void {
  if (process.env.CLIPS_SCAN_ENABLED === '0') return () => {};
  const timer = setInterval(() => {
    if (lastTaggerActivity === null || Date.now() - lastTaggerActivity >= TAGGER_ACTIVE_WINDOW_MS) {
      return;
    }
    void rescan().catch((error: unknown) => {
      console.error('Background clip catalog rescan failed', error);
    });
  }, AUTO_RESCAN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
