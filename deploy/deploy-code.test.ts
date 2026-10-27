import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture({ deployed = false, inAppData = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wbru-code-deploy-'));
  fixtureRoots.push(root);
  const repo = join(root, 'repo');
  const destination = join(root, 'app');
  const bin = join(root, 'bin');
  const sshLog = join(root, 'ssh.log');
  const archiveRef = join(root, 'archive-ref');
  const dataDir = inAppData ? join(destination, 'server') : join(root, 'data');
  const databasePath = join(dataDir, 'program.db');
  const serviceEnv = join(root, 'service.env');
  const rollbacks = join(root, 'rollbacks');
  const operationsLog = join(root, 'operations.log');
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const rsync = execFileSync('which', ['rsync'], { encoding: 'utf8' }).trim();

  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(destination, { mode: 0o755 });
  mkdirSync(dataDir);
  mkdirSync(bin);
  for (const name of ['deploy-code.sh', 'env.sh', 'rsync-exclude.txt']) {
    copyFileSync(join('deploy', name), join(repo, 'deploy', name));
  }
  for (const name of ['check-node.mjs', 'backup-data.mjs']) {
    copyFileSync(join('scripts', name), join(repo, 'scripts', name));
  }
  copyFileSync('.nvmrc', join(repo, '.nvmrc'));
  writeFileSync(join(repo, 'package.json'), '{"type":"module","version":"new"}\n');
  writeFileSync(
    serviceEnv,
    inAppData ? '' : `TAGGER_DATA_DIR='${dataDir}'\nBACKUP_DIR='${join(root, 'backups')}'\n`,
  );
  const database = new Database(databasePath);
  database.exec("CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('operator data')");
  database.close();
  const originalDatabase = readFileSync(databasePath);
  execFileSync(git, ['init', '-q', repo]);
  execFileSync(git, ['add', '.'], { cwd: repo });
  execFileSync(
    git,
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Fixture'],
    { cwd: repo },
  );
  const commit = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  if (deployed) {
    execFileSync(rsync, ['-a', '--exclude=.git', `${repo}/`, `${destination}/`]);
    writeFileSync(join(destination, 'REVISION'), 'outgoing\n');
    writeFileSync(join(destination, 'package.json'), '{"type":"module","version":"old"}\n');
    writeFileSync(join(destination, 'old-only.js'), 'old code\n');
    mkdirSync(join(destination, 'dist'));
    writeFileSync(join(destination, 'dist/index.html'), 'old assets\n');
    mkdirSync(join(destination, 'node_modules'));
    writeFileSync(join(destination, 'node_modules/version'), 'old dependencies\n');
    symlinkSync(
      join(process.cwd(), 'node_modules/better-sqlite3'),
      join(destination, 'node_modules/better-sqlite3'),
    );
  }

  // Execute remote script bodies locally; replace only host commands and filesystem locations.
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
if [[ "$PWD" == "$DESTINATION" ]]; then
  printf 'npm %s\\n' "$*" >> "$OPERATIONS_LOG"
  if [[ "$1" == ci ]]; then
    if [[ "$NODE_ENV" == production && "$*" != *--include=dev* ]]; then exit 127; fi
    printf 'new dependencies\\n' > node_modules/version
  fi
  if [[ "$*" == 'run build' ]]; then printf 'new assets\\n' > dist/index.html; fi
  [[ "$1" != "$FAIL_PHASE" && "$*" != "$FAIL_PHASE" ]] || exit 23
fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'ssh'),
    `#!${process.execPath}
const { readFileSync, appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const [host, ...command] = process.argv.slice(2);
if (host !== process.env.WBRU_SSH_USER + '@fixture') process.exit(1);
appendFileSync(process.env.SSH_LOG, 'ssh\\n');
const script = readFileSync(0, 'utf8');
const result = spawnSync('bash', ['-c', command.join(' ')], { input: script, stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'id'), '#!/bin/sh\necho "${FAKE_UID:-0}"\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$OPERATIONS_LOG"
if [ "$1" = --user ]; then shift; fi
if [ "$FAIL_PHASE" = restart ] && [ "$1" = restart ]; then exit 23; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
if [ "$FAIL_PHASE" = health ] && grep -q 'new assets' "$DESTINATION/dist/index.html"; then exit 22; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env bash
if [[ "$1" == archive ]]; then printf '%s\\n' "$2" > "$ARCHIVE_REF"; fi
exec "${git}" "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'rsync'),
    `#!/usr/bin/env bash
args=()
for arg in "$@"; do
  args+=("\${arg#*@fixture:}")
done
if [[ "$FAIL_PHASE" == upload && "$*" == *@fixture:* && "$*" != *--dry-run* ]]; then
  "${rsync}" "\${args[@]}"
  exit 23
fi
exec "${rsync}" "\${args[@]}"
`,
    { mode: 0o755 },
  );

  function deploy(mode = '--initial', extraArgs: string[] = [], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(
      'bash',
      ['deploy/deploy-code.sh', 'visualizer', ...(mode ? [mode] : []), ...extraArgs],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          WBRU_ENV_FILE: join(root, 'unused.env'),
          WBRU_VISUALIZER_HOST: 'fixture',
          WBRU_SSH_USER: 'root',
          WBRU_APP_DIR: destination,
          WBRU_CLIPS_DIR: join(root, 'clips'),
          WBRU_SERVICE_SCOPE: 'system',
          WBRU_REMOTE_ENV_FILE: serviceEnv,
          WBRU_ROLLBACK_DIR: rollbacks,
          DATABASE_PATH: undefined,
          TAGGER_DATA_DIR: undefined,
          BACKUP_DIR: undefined,
          CLIPS_DIR: undefined,
          SSH_LOG: sshLog,
          ARCHIVE_REF: archiveRef,
          OPERATIONS_LOG: operationsLog,
          DESTINATION: destination,
          FAIL_PHASE: '',
          ...env,
        },
      },
    );
  }

  return {
    repo,
    destination,
    bin,
    sshLog,
    archiveRef,
    commit,
    deploy,
    dataDir,
    databasePath,
    originalDatabase,
    serviceEnv,
    rollbacks,
    operationsLog,
  };
}

it('deploys the captured commit as readable code without changing runtime files', () => {
  const { destination, databasePath, originalDatabase, archiveRef, commit, deploy } =
    createFixture();
  const result = deploy();

  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(archiveRef, 'utf8').trim()).toBe(commit);
  expect(statSync(destination).mode & 0o777).toBe(0o755);
  expect(statSync(join(destination, 'package.json')).mode & 0o777).toBe(0o644);
  expect(readFileSync(join(destination, 'REVISION'), 'utf8').trim()).toBe(commit);
  expect(readFileSync(databasePath)).toEqual(originalDatabase);
});

it('defaults to a dry run without writing code or runtime files', () => {
  const { destination, databasePath, originalDatabase, deploy } = createFixture({ deployed: true });
  const result = deploy('');

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Dry run only.');
  expect(readFileSync(join(destination, 'REVISION'), 'utf8')).toBe('outgoing\n');
  expect(readFileSync(databasePath)).toEqual(originalDatabase);
});

it('preserves default in-application runtime files through deploy and rollback', () => {
  const fixture = createFixture({ deployed: true, inAppData: true });
  const caches = ['clips-cache.json', 'clips.json'].map((name) => join(fixture.dataDir, name));
  const backup = join(fixture.destination, 'backups', 'existing.db');
  const clip = join(fixture.destination, 'public/clips', 'session.mp4');
  const thumbnail = join(fixture.dataDir, 'thumbnails', 'clp_session.jpg');
  mkdirSync(join(fixture.destination, 'backups'));
  mkdirSync(join(fixture.destination, 'public/clips'), { recursive: true });
  mkdirSync(join(fixture.dataDir, 'thumbnails'));
  for (const cache of caches) writeFileSync(cache, '[]\n');
  writeFileSync(backup, fixture.originalDatabase);
  writeFileSync(clip, 'existing video');
  writeFileSync(thumbnail, 'existing image');
  writeFileSync(fixture.serviceEnv, `CLIPS_DIR='${join(fixture.destination, 'public/clips')}'\n`);

  const applied = fixture.deploy('--apply');
  expect(applied.status, applied.stderr).toBe(0);
  for (const cache of caches) expect(readFileSync(cache, 'utf8')).toBe('[]\n');
  expect(readFileSync(fixture.databasePath)).toEqual(fixture.originalDatabase);
  expect(readFileSync(thumbnail, 'utf8')).toBe('existing image');

  const database = new Database(fixture.databasePath);
  database.prepare('INSERT INTO notes VALUES (?)').run('new operator data');
  database.close();
  const updatedDatabase = readFileSync(fixture.databasePath);
  const rollback = join(fixture.rollbacks, readdirSync(fixture.rollbacks)[0]);
  const restored = fixture.deploy('--rollback', [rollback]);

  expect(restored.status, restored.stderr).toBe(0);
  expect(readFileSync(fixture.databasePath)).toEqual(updatedDatabase);
  for (const cache of caches) expect(readFileSync(cache, 'utf8')).toBe('[]\n');
  expect(readFileSync(backup)).toEqual(fixture.originalDatabase);
  expect(readFileSync(clip, 'utf8')).toBe('existing video');
  expect(readFileSync(thumbnail, 'utf8')).toBe('existing image');
});

it('rejects a nonempty initial destination before deleting any files', () => {
  const { destination, deploy } = createFixture();
  const media = join(destination, 'unrelated-media.mp4');
  writeFileSync(media, 'existing media');

  const result = deploy();

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Initial deployment requires an empty directory');
  expect(readFileSync(media, 'utf8')).toBe('existing media');
  expect(existsSync(join(destination, 'package.json'))).toBe(false);
});

it.each(['TAGGER_DATA_DIR', 'DATABASE_PATH', 'CLIPS_DIR', 'BACKUP_DIR'])(
  'rejects %s inside the deployed application',
  (variable) => {
    const fixture = createFixture({ deployed: true });
    const nested = join(fixture.destination, 'data');
    mkdirSync(nested);
    const database = join(nested, 'program.db');
    writeFileSync(database, 'existing data');
    const value = variable === 'DATABASE_PATH' ? database : nested;
    writeFileSync(
      fixture.serviceEnv,
      readFileSync(fixture.serviceEnv, 'utf8') + `${variable}='${value}'\n`,
    );
    const result = fixture.deploy('--apply');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Runtime path overlaps unprotected application files');
    expect(readFileSync(database, 'utf8')).toBe('existing data');
    expect(readFileSync(join(fixture.destination, 'REVISION'), 'utf8')).toBe('outgoing\n');
    expect(existsSync(fixture.rollbacks)).toBe(false);
  },
);

it('rejects a symlink that places runtime data inside the application', () => {
  const fixture = createFixture({ deployed: true });
  const nested = join(fixture.destination, 'data');
  mkdirSync(nested);
  const link = join(fixture.dataDir, 'linked');
  symlinkSync(nested, link);
  const result = fixture.deploy('--apply', [], { DATABASE_PATH: join(link, 'program.db') });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Runtime path overlaps unprotected application files');
  expect(existsSync(fixture.rollbacks)).toBe(false);
});

it('rejects the filesystem root as a runtime directory', () => {
  const fixture = createFixture({ deployed: true });
  const result = fixture.deploy('--apply', [], { CLIPS_DIR: '/' });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Runtime path overlaps unprotected application files');
  expect(existsSync(fixture.rollbacks)).toBe(false);
});

it('rejects a runtime symlink inside the application even when its target is outside', () => {
  const fixture = createFixture({ deployed: true });
  const link = join(fixture.destination, 'external-data');
  symlinkSync(fixture.dataDir, link);
  const result = fixture.deploy('--apply', [], { DATABASE_PATH: join(link, 'program.db') });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Runtime path overlaps unprotected application files');
  expect(readFileSync(fixture.databasePath)).toEqual(fixture.originalDatabase);
});

it('rejects a protected default path that links to application code', () => {
  const fixture = createFixture({ deployed: true, inAppData: true });
  rmSync(fixture.databasePath);
  symlinkSync(join(fixture.destination, 'package.json'), fixture.databasePath);
  const result = fixture.deploy('--apply');

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Runtime path overlaps unprotected application files');
  expect(readFileSync(join(fixture.destination, 'package.json'), 'utf8')).toContain('"old"');
  expect(existsSync(fixture.rollbacks)).toBe(false);
});

it('checks the host Node version before replacing code', () => {
  const fixture = createFixture({ deployed: true });
  writeFileSync(join(fixture.bin, 'node'), '#!/bin/sh\necho 20\n', { mode: 0o755 });
  const result = fixture.deploy('--apply');

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('required on the deployment host');
  expect(readFileSync(join(fixture.destination, 'REVISION'), 'utf8')).toBe('outgoing\n');
  expect(existsSync(fixture.rollbacks)).toBe(false);
});

it.each(['upload', 'ci', 'run build', 'restart', 'health'])(
  'restores code and dependencies without restoring SQLite after %s fails',
  (phase) => {
    const fixture = createFixture({ deployed: true });
    const result = fixture.deploy('--apply', [], { FAIL_PHASE: phase });

    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toContain('Previous code restored');
    expect(readFileSync(join(fixture.destination, 'REVISION'), 'utf8')).toBe('outgoing\n');
    expect(readFileSync(join(fixture.destination, 'old-only.js'), 'utf8')).toBe('old code\n');
    expect(readFileSync(join(fixture.destination, 'node_modules/version'), 'utf8')).toBe(
      'old dependencies\n',
    );
    expect(readFileSync(join(fixture.destination, 'dist/index.html'), 'utf8')).toBe('old assets\n');
    expect(readFileSync(fixture.databasePath)).toEqual(fixture.originalDatabase);

    const rollback = join(fixture.rollbacks, readdirSync(fixture.rollbacks)[0]);
    const snapshots = join(rollback, 'database');
    const snapshot = new Database(join(snapshots, readdirSync(snapshots)[0], 'program.db'), {
      readonly: true,
    });
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.prepare('SELECT value FROM notes').pluck().get()).toBe('operator data');
    } finally {
      snapshot.close();
    }
    const operations = readFileSync(fixture.operationsLog, 'utf8');
    expect(operations).toContain('systemctl stop wbru-visualizer');
    expect(operations).toContain('systemctl start wbru-visualizer');
    expect(operations.match(/^npm ci(?: |$)/gm) ?? []).toHaveLength(phase === 'upload' ? 0 : 1);
  },
);

it('supports manual code rollback while retaining newer operator data', () => {
  const fixture = createFixture({ deployed: true });
  const applied = fixture.deploy('--apply');
  expect(applied.status, applied.stderr).toBe(0);
  expect(readFileSync(join(fixture.destination, 'REVISION'), 'utf8').trim()).toBe(fixture.commit);

  const database = new Database(fixture.databasePath);
  database.prepare('INSERT INTO notes VALUES (?)').run('new operator data');
  database.close();
  const updatedDatabase = readFileSync(fixture.databasePath);
  writeFileSync(join(fixture.repo, 'uncommitted.txt'), 'local work');
  const rollback = join(fixture.rollbacks, readdirSync(fixture.rollbacks)[0]);
  const restored = fixture.deploy('--rollback', [rollback], { FAIL_PHASE: 'ci' });

  expect(restored.status, restored.stderr).toBe(0);
  expect(readFileSync(join(fixture.destination, 'REVISION'), 'utf8')).toBe('outgoing\n');
  expect(readFileSync(fixture.databasePath)).toEqual(updatedDatabase);
  expect(restored.stdout).toContain('production database was not restored');
});

it.each(['', 'restart'])('deploys and recovers a non-root user service (failure=%s)', (phase) => {
  const fixture = createFixture({ deployed: true });
  const runtimeBin = join(fixture.dataDir, 'runtime-bin');
  mkdirSync(runtimeBin);
  writeFileSync(join(fixture.bin, 'node'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  writeFileSync(join(runtimeBin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    fixture.serviceEnv,
    readFileSync(fixture.serviceEnv, 'utf8') +
      `NODE_ENV=production\nPATH='${runtimeBin}':"$PATH"\n`,
  );
  const result = fixture.deploy('--apply', [], {
    WBRU_SSH_USER: 'operator',
    WBRU_SERVICE_SCOPE: 'user',
    FAKE_UID: '1000',
    FAIL_PHASE: phase,
  });

  expect(result.status === 0, result.stderr).toBe(!phase);
  const operations = readFileSync(fixture.operationsLog, 'utf8');
  expect(operations).toContain('npm ci --include=dev');
  expect(operations).toContain('systemctl --user restart wbru-visualizer');
  expect(operations).toContain('systemctl --user is-active --quiet wbru-backup.timer');
  expect(operations).not.toMatch(/^systemctl (?!--user)/m);
  if (phase) {
    expect(result.stderr).toContain('Previous code restored');
    expect(operations).toContain('systemctl --user start wbru-visualizer');
  }
  expect(readFileSync(fixture.databasePath)).toEqual(fixture.originalDatabase);
  const rollback = join(fixture.rollbacks, readdirSync(fixture.rollbacks)[0]);
  expect(statSync(rollback).mode & 0o777).toBe(0o700);
  expect(statSync(fixture.destination).mode & 0o777).toBe(0o755);
});

it('rejects rollback storage inside application files', () => {
  const fixture = createFixture({ deployed: true });
  const result = fixture.deploy('--apply', [], {
    WBRU_ROLLBACK_DIR: join(fixture.destination, 'rollbacks'),
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Runtime path overlaps unprotected application files');
  expect(readFileSync(fixture.databasePath)).toEqual(fixture.originalDatabase);
});

it.each(['test', 'run lint', 'run build'])('rejects HEAD changing during npm %s', (step) => {
  const { repo, bin, sshLog, archiveRef, commit, deploy } = createFixture();
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
set -e
if [[ "$*" == "${step}" ]]; then
  printf '{"version":"next"}\\n' > package.json
  git add package.json
  git -c user.name=Test -c user.email=test@example.com commit -qm 'Next fixture revision'
fi
`,
  );
  const result = deploy();

  expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
  expect(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  ).not.toBe(commit);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('HEAD no longer matches');
  expect(existsSync(sshLog)).toBe(false);
  expect(existsSync(archiveRef)).toBe(false);
});

it.each(['package.json', 'untracked.txt'])('rejects validation changes to %s', (file) => {
  const { bin, sshLog, archiveRef, deploy } = createFixture();
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
if [[ "$*" == 'run build' ]]; then printf 'changed\\n' > '${file}'; fi
`,
  );
  const result = deploy();

  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('dirty working tree');
  expect(existsSync(sshLog)).toBe(false);
  expect(existsSync(archiveRef)).toBe(false);
});

it('rejects an initially dirty working tree before validation', () => {
  const { repo, bin, sshLog, deploy } = createFixture();
  writeFileSync(join(repo, 'package.json'), '{"changed":true}\n');
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\necho unexpected-validation >&2\nexit 42\n');
  const result = deploy();

  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('dirty working tree');
  expect(result.stderr).not.toContain('unexpected-validation');
  expect(existsSync(sshLog)).toBe(false);
});

it.each(['test', 'run lint', 'run build'])('stops before SSH when npm %s fails', (step) => {
  const { bin, sshLog, archiveRef, deploy } = createFixture();
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash\nif [[ "$*" == "${step}" ]]; then exit 42; fi\n`,
  );
  const result = deploy();

  expect(result.status, result.stderr).toBe(42);
  expect(existsSync(sshLog)).toBe(false);
  expect(existsSync(archiveRef)).toBe(false);
});

it.each(['system', 'user'])('recommends Refresh after clip upload (%s)', (scope) => {
  const root = mkdtempSync(join(tmpdir(), 'wbru-clip-upload-'));
  fixtureRoots.push(root);
  const bin = join(root, 'bin');
  const clips = join(root, 'clips');
  mkdirSync(bin);
  mkdirSync(clips);
  writeFileSync(join(bin, 'rsync'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const result = spawnSync('bash', ['deploy/sync-clips.sh', 'operator@fixture', clips], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WBRU_ENV_FILE: join(root, 'unused.env'),
      WBRU_APP_DIR: '/home/operator/app',
      WBRU_CLIPS_DIR: '/home/operator/clips',
      WBRU_SERVICE_SCOPE: scope,
    },
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    'Done. Use Refresh in the production tagger to scan clips and update the catalog.',
  );
  expect(result.stdout).not.toMatch(/www-data|\/srv\/wbru\/data|sudo|systemctl|index-clips/);
});
