import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// BACKUP_DIR selects the snapshot destination; KEEP controls how many are retained.

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const dataDir = process.env.TAGGER_DATA_DIR ?? join(projectRoot, 'server');
const backupRoot = process.env.BACKUP_DIR ?? join(projectRoot, 'backups');
const retentionCount = Math.max(1, Number(process.env.KEEP) || 30);
const databasePath = process.env.DATABASE_PATH ?? join(dataDir, 'program.db');

if (!existsSync(databasePath)) {
  console.error(`Cannot back up - database not found at ${databasePath}`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshotDir = join(backupRoot, timestamp);
mkdirSync(snapshotDir, { recursive: true });

try {
  // Use SQLite's backup API so the snapshot is consistent while the server is running.
  const snapshotPath = join(snapshotDir, 'program.db');
  const sourceDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await sourceDatabase.backup(snapshotPath);
  } finally {
    sourceDatabase.close();
  }
} catch (error) {
  rmSync(snapshotDir, { recursive: true, force: true });
  throw error;
}

const snapshotNamePattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const snapshotDirectories = readdirSync(backupRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && snapshotNamePattern.test(entry.name))
  .map((entry) => join(backupRoot, entry.name))
  .sort();
const oldestSnapshots = snapshotDirectories.slice(
  0,
  Math.max(0, snapshotDirectories.length - retentionCount),
);
// Prune only timestamp-named snapshots so manual recovery directories are never touched.
for (const path of oldestSnapshots) rmSync(path, { recursive: true, force: true });

console.log(
  `Backed up program.db to ${snapshotDir}` +
    (oldestSnapshots.length ? `; pruned ${oldestSnapshots.length} old snapshot(s).` : '.'),
);
