import Database from 'better-sqlite3';
import concurrently from 'concurrently';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const snapshotPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const sshOptions = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// The manifest describes exactly the available files in this database snapshot.
export function writeSnapshotManifest(directory) {
  const database = new Database(join(directory, 'program.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Database snapshot failed its integrity check');
    }
    const clips = database
      .prepare(
        `
      SELECT id, title, url, path, library, duration_sec AS durationSec,
             published_year AS publishedYear
      FROM clips WHERE available = 1 ORDER BY path
    `,
      )
      .all();
    writeFileSync(join(directory, 'clips-cache.json'), JSON.stringify(clips));
    return clips.length;
  } finally {
    database.close();
  }
}

export function latestSnapshot(root) {
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && snapshotPattern.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];
  if (!names.length) throw new Error('No development snapshot. Run npm run dev:pull first.');
  return join(root, names.at(-1));
}

// Transfer SQLite's consistent backup, not the database file that production has open.
export async function pullSnapshot(config, root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const name = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = join(root, `.incoming-${name}`);
  const destination = join(root, name);
  mkdirSync(staging, { mode: 0o700 });
  const command = ['bash', '-s', '--', config.DEV_REMOTE_APP_DIR, config.DEV_REMOTE_ENV_FILE]
    .map(quote)
    .join(' ');
  const child = spawn('ssh', [...sshOptions, config.DEV_SSH_HOST, command], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const closed = once(child, 'close');
  child.stdin.end(`set -euo pipefail
cd "$1"
set -a
source "$2"
set +a
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
BACKUP_DIR="$scratch" KEEP=1 node scripts/backup-data.mjs >&2
cat "$scratch"/*/program.db
`);
  try {
    const [[code]] = await Promise.all([
      closed,
      pipeline(child.stdout, createWriteStream(join(staging, 'program.db'), { flags: 'wx' })),
    ]);
    if (code !== 0) throw new Error(`Snapshot transfer failed (SSH exit ${code})`);
    const count = writeSnapshotManifest(staging);
    renameSync(staging, destination);
    console.log(`Local snapshot: ${destination} (${count} clips). Restart npm run dev to use it.`);
    return destination;
  } catch (error) {
    child.kill();
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// Only media crosses the tunnel. The API and all database writes run locally.
export function devCommands(config, directory) {
  const mediaPort = config.DEV_MEDIA_PORT ?? '8767';
  const env = {
    NODE_ENV: 'development',
    TAGGER_DATA_DIR: directory,
    DATABASE_PATH: join(directory, 'program.db'),
    CLIPS_SCAN_ENABLED: '0',
    DEV_MEDIA_ORIGIN: `http://127.0.0.1:${mediaPort}`,
    DEV_WEB_PORT: config.DEV_WEB_PORT ?? '5174',
  };
  const tunnel = [
    'ssh',
    ...sshOptions,
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `127.0.0.1:${mediaPort}:${config.DEV_MEDIA_REMOTE}`,
    config.DEV_SSH_HOST,
  ];
  return [
    { name: 'media', command: tunnel.map(quote).join(' ') },
    { name: 'web', command: 'npm:dev:web', env },
    { name: 'api', command: 'npm:dev:api', env },
  ];
}

async function main() {
  const file = join(projectRoot, '.env.development.local');
  if (!existsSync(file))
    throw new Error('Copy .env.development.example to .env.development.local first.');
  const config = parseEnv(readFileSync(file, 'utf8'));
  for (const key of [
    'DEV_SSH_HOST',
    'DEV_REMOTE_APP_DIR',
    'DEV_REMOTE_ENV_FILE',
    'DEV_MEDIA_REMOTE',
  ]) {
    if (!config[key]) throw new Error(`Set ${key} in .env.development.local`);
  }
  const root = join(projectRoot, '.dev');
  if (process.argv[2] === 'pull') return pullSnapshot(config, root);
  if (process.argv[2]) throw new Error('Usage: npm run dev or npm run dev:pull');
  const directory = latestSnapshot(root);
  // This session must own the API port used by the web proxy.
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(
        new Error('API port 3001 is already in use. Stop that API before starting development.'),
      ),
    );
    probe.listen(3001, '127.0.0.1', () => probe.close(resolve));
  });
  console.log(`Development database: ${join(directory, 'program.db')}`);
  console.log(`Local app: http://localhost:${config.DEV_WEB_PORT ?? '5174'}/tag`);
  const { result } = concurrently(devCommands(config, directory), {
    cwd: projectRoot,
    prefix: 'name',
    killOthersOn: ['failure', 'success'],
  });
  await result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof Error) console.error(error.message);
    process.exitCode = 1;
  });
}
