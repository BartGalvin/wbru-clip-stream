import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Manifest fields inspected by the indexer integration tests.
interface ManifestClip {
  id: string;
  title: string;
  path: string;
  url: string;
  library: string;
  durationSec: number;
  publishedYear: number | null;
}

let clipsDir: string;
let dataDir: string;
let fixtureProbe: string;
const indexScript = join(process.cwd(), 'scripts/index-clips.mjs');

const manifestPath = () => join(dataDir, 'clips-cache.json');
const readManifest = (): ManifestClip[] => JSON.parse(readFileSync(manifestPath(), 'utf8'));

const writeVideoFixture = (relativePath: string, seed: string) => {
  const absolutePath = join(clipsDir, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, seed.repeat(2048));
};

function runIndexer(extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ['scripts/index-clips.mjs'], {
    env: {
      ...process.env,
      CLIPS_DIR: clipsDir,
      CLIPS_URL_PREFIX: '/clips/',
      TAGGER_DATA_DIR: dataDir,
      FFPROBE_BIN: fixtureProbe,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

beforeAll(() => {
  clipsDir = mkdtempSync(join(tmpdir(), 'clips-fixture-'));
  dataDir = mkdtempSync(join(tmpdir(), 'clips-out-'));
  fixtureProbe = join(dataDir, 'fake-ffprobe');
  writeFileSync(fixtureProbe, "#!/bin/sh\nprintf '12.5\\n'\n");
  chmodSync(fixtureProbe, 0o755);
  writeVideoFixture('plain.mp4', 'aa');
  writeVideoFixture('360/spin around.mp4', 'bb');
  writeVideoFixture('360/nested/deep.mp4', 'cc');
  writeVideoFixture('pjlvideo/org.mp4', 'dd');
  writeVideoFixture('wbru-youtube/session.mp4', 'ee');
  writeVideoFixture('wbru-youtube/Ready [abcdefghijk].mp4', 'hh');
  writeVideoFixture('wbru-youtube/Pending [lmnopqrstuv].mp4', 'ii');
  writeVideoFixture('wbru-youtube/Pending [lmnopqrstuv].f137.mp4', 'jj');
  writeVideoFixture('.rejected/removed.mp4', 'ff');
  writeVideoFixture('lost+found/volume-internal.mp4', 'gg');
  writeFileSync(
    join(clipsDir, 'wbru-youtube/session.info.json'),
    JSON.stringify({ title: 'WBRU Studio Session', duration: 83.25, upload_date: '20140728' }),
  );
  writeFileSync(join(clipsDir, 'notes.txt'), 'not a video');
  writeFileSync(join(clipsDir, '.wbru-youtube-download-archive'), 'youtube abcdefghijk\n');
  runIndexer();
});

afterAll(() => {
  rmSync(clipsDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('index-clips', () => {
  it('writes the manifest into TAGGER_DATA_DIR and indexes only video files', () => {
    const paths = readManifest()
      .map((clip) => clip.path)
      .sort();
    expect(paths).toEqual([
      '360/nested/deep.mp4',
      '360/spin around.mp4',
      'pjlvideo/org.mp4',
      'plain.mp4',
      'wbru-youtube/Ready [abcdefghijk].mp4',
      'wbru-youtube/session.mp4',
    ]);
  });

  it('assigns the reserved YouTube folder to its own library', () => {
    const byPath = new Map(readManifest().map((clip) => [clip.path, clip]));
    expect(byPath.get('plain.mp4')?.library).toBe('visualizer');
    expect(byPath.get('360/spin around.mp4')?.library).toBe('visualizer');
    expect(byPath.get('wbru-youtube/session.mp4')?.library).toBe('wbru-youtube');
  });

  it('indexes only completed yt-dlp outputs', () => {
    const paths = readManifest().map((clip) => clip.path);
    expect(paths).toContain('wbru-youtube/Ready [abcdefghijk].mp4');
    expect(paths).not.toContain('wbru-youtube/Pending [lmnopqrstuv].mp4');
    expect(paths).not.toContain('wbru-youtube/Pending [lmnopqrstuv].f137.mp4');
  });

  it('treats a missing YouTube archive as having no completed downloads', () => {
    const missingArchiveRoot = mkdtempSync(join(tmpdir(), 'clips-missing-youtube-archive-'));
    const missingArchiveOut = mkdtempSync(join(tmpdir(), 'clips-missing-youtube-archive-out-'));
    const youtubeDir = join(missingArchiveRoot, 'wbru-youtube');
    mkdirSync(youtubeDir);
    writeFileSync(join(missingArchiveRoot, 'ordinary.mp4'), 'ordinary clip');
    writeFileSync(join(youtubeDir, 'Ready [abcdefghijk].mp4'), 'recognizable YouTube clip');
    writeFileSync(
      join(youtubeDir, 'Pending [lmnopqrstuv].f137.mp4'),
      'recognizable format fragment',
    );

    try {
      const result = spawnSync(process.execPath, [indexScript], {
        env: {
          ...process.env,
          CLIPS_DIR: missingArchiveRoot,
          TAGGER_DATA_DIR: missingArchiveOut,
          YOUTUBE_ARCHIVE: join(missingArchiveRoot, 'missing-archive'),
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(missingArchiveOut, 'clips-cache.json'), 'utf8'))).toEqual(
        [expect.objectContaining({ path: 'ordinary.mp4', library: 'visualizer' })],
      );
    } finally {
      rmSync(missingArchiveRoot, { recursive: true, force: true });
      rmSync(missingArchiveOut, { recursive: true, force: true });
    }
  });

  it('reads YouTube titles, upload years, and durations from yt-dlp sidecars', () => {
    const session = readManifest().find((clip) => clip.path === 'wbru-youtube/session.mp4');
    expect(session).toMatchObject({
      title: 'WBRU Studio Session',
      durationSec: 83.25,
      publishedYear: 2014,
    });
    expect(readManifest().find((clip) => clip.path === 'plain.mp4')?.publishedYear).toBeNull();
  });

  it('rereads upload dates even when the video is unchanged', () => {
    const sidecarPath = join(clipsDir, 'wbru-youtube/session.info.json');
    const original = readFileSync(sidecarPath, 'utf8');
    const metadata = JSON.parse(original);
    const session = () => readManifest().find((clip) => clip.path === 'wbru-youtube/session.mp4');
    const id = session()?.id;

    try {
      writeFileSync(sidecarPath, JSON.stringify({ ...metadata, upload_date: '20150809' }));
      runIndexer();
      expect(session()).toMatchObject({ id, publishedYear: 2015 });

      writeFileSync(sidecarPath, JSON.stringify({ ...metadata, upload_date: null }));
      runIndexer();
      expect(session()).toMatchObject({ id, publishedYear: null });
    } finally {
      writeFileSync(sidecarPath, original);
      runIndexer();
    }
  });

  it('reuses durations after moves but probes changed files and explicit forced scans', () => {
    const probeRoot = mkdtempSync(join(tmpdir(), 'clips-duration-probe-'));
    const probeOut = mkdtempSync(join(tmpdir(), 'clips-duration-probe-out-'));
    const fakeProbe = join(probeRoot, 'fake-ffprobe');
    const probeLog = join(probeRoot, 'ffprobe.log');
    const videoPath = join(probeRoot, 'measured.mp4');
    writeFileSync(videoPath, 'first version');
    writeFileSync(
      fakeProbe,
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FFPROBE_LOG"
printf '17.75\n'
`,
    );
    chmodSync(fakeProbe, 0o755);
    const env = {
      ...process.env,
      CLIPS_DIR: probeRoot,
      CLIPS_URL_PREFIX: '/clips/',
      CLIPS_FORCE: '0',
      TAGGER_DATA_DIR: probeOut,
      FFPROBE_BIN: fakeProbe,
      FFPROBE_LOG: probeLog,
    };
    const readIndexedClip = (): ManifestClip =>
      JSON.parse(readFileSync(join(probeOut, 'clips-cache.json'), 'utf8'))[0];
    const probeCalls = () => readFileSync(probeLog, 'utf8').trim().split('\n');

    try {
      execFileSync(process.execPath, [indexScript], { env });
      const originalClip = readIndexedClip();
      expect(originalClip.durationSec).toBe(17.75);
      expect(probeCalls()).toHaveLength(1);

      execFileSync(process.execPath, [indexScript], { env });
      expect(probeCalls()).toHaveLength(1);

      mkdirSync(join(probeRoot, 'archive'));
      const movedPath = join(probeRoot, 'archive', 'renamed clip.mp4');
      renameSync(videoPath, movedPath);
      execFileSync(process.execPath, [indexScript], { env });
      expect(readIndexedClip()).toMatchObject({
        id: originalClip.id,
        path: 'archive/renamed clip.mp4',
        url: `/clips/archive/renamed%20clip.mp4?v=${originalClip.id}`,
        durationSec: 17.75,
      });
      expect(probeCalls()).toHaveLength(1);

      execFileSync(process.execPath, [indexScript, '--force'], { env });
      expect(probeCalls()).toHaveLength(2);
      expect(readIndexedClip().id).toBe(originalClip.id);

      execFileSync(process.execPath, [indexScript], { env: { ...env, CLIPS_FORCE: '1' } });
      expect(probeCalls()).toHaveLength(3);

      writeFileSync(movedPath, 'second version with a different size');
      execFileSync(process.execPath, [indexScript], { env });
      expect(readIndexedClip().id).not.toBe(originalClip.id);
      expect(probeCalls()).toHaveLength(4);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
      rmSync(probeOut, { recursive: true, force: true });
    }
  });

  it('builds prefixed, per-segment-encoded URLs', () => {
    const byPath = new Map(readManifest().map((clip) => [clip.path, clip]));
    const spin = byPath.get('360/spin around.mp4');
    expect(spin?.url).toBe(`/clips/360/spin%20around.mp4?v=${spin?.id}`);
  });

  it('assigns stable content ids across reruns (cache and forced)', () => {
    const initialIdsByPath = new Map(readManifest().map((clip) => [clip.path, clip.id]));
    for (const id of initialIdsByPath.values()) expect(id).toMatch(/^clp_[0-9a-f]{16}$/);
    runIndexer();
    const cachedIdsByPath = new Map(readManifest().map((clip) => [clip.path, clip.id]));
    runIndexer({ CLIPS_FORCE: '1' });
    const forcedIdsByPath = new Map(readManifest().map((clip) => [clip.path, clip.id]));
    expect(cachedIdsByPath).toEqual(initialIdsByPath);
    expect(forcedIdsByPath).toEqual(initialIdsByPath);
  });

  it('gives distinct content distinct ids', () => {
    const idSet = new Set(readManifest().map((clip) => clip.id));
    expect(idSet.size).toBe(6);
  });

  it('an empty scan writes an empty manifest and warns on stderr', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'clips-empty-'));
    const emptyOut = mkdtempSync(join(tmpdir(), 'clips-empty-out-'));
    try {
      const result = spawnSync(process.execPath, ['scripts/index-clips.mjs'], {
        env: { ...process.env, CLIPS_DIR: emptyRoot, TAGGER_DATA_DIR: emptyOut },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(emptyOut, 'clips-cache.json'), 'utf8'))).toEqual([]);
      expect(result.stdout).toContain('0 clip(s)');
      expect(result.stderr).toContain('No video files found');
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
      rmSync(emptyOut, { recursive: true, force: true });
    }
  });

  it('uses the default clip directory when --force is the only argument', () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'clips-force-default-'));
    const defaultClipsDir = join(workingDir, 'public', 'clips');
    const defaultDataDir = join(workingDir, 'data');
    mkdirSync(defaultClipsDir, { recursive: true });
    mkdirSync(defaultDataDir);
    writeFileSync(join(defaultClipsDir, 'default.mp4'), 'default clip');
    const env = { ...process.env, TAGGER_DATA_DIR: defaultDataDir };
    delete env.CLIPS_DIR;
    delete env.CLIPS_URL_PREFIX;

    try {
      const result = spawnSync(process.execPath, [indexScript, '--force'], {
        cwd: workingDir,
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(defaultDataDir, 'clips-cache.json'), 'utf8'))).toEqual([
        expect.objectContaining({ path: 'default.mp4', url: expect.stringMatching(/^\/clips\//) }),
      ]);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('warns when cached manifests or video metadata are invalid', () => {
    const invalidRoot = mkdtempSync(join(tmpdir(), 'clips-invalid-'));
    const invalidDataDir = mkdtempSync(join(tmpdir(), 'clips-invalid-data-'));
    writeFileSync(join(invalidRoot, 'broken.mp4'), 'broken metadata clip');
    writeFileSync(join(invalidRoot, 'broken.info.json'), '{not json');
    writeFileSync(join(invalidDataDir, 'clips-cache.json'), '{not json');

    try {
      const result = spawnSync(process.execPath, [indexScript], {
        env: {
          ...process.env,
          CLIPS_DIR: invalidRoot,
          TAGGER_DATA_DIR: invalidDataDir,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Ignoring invalid previous manifest');
      expect(result.stderr).toContain('Ignoring invalid video metadata');
      expect(result.stderr).toContain('Could not determine duration for 1 clip(s)');
      expect(
        JSON.parse(readFileSync(join(invalidDataDir, 'clips-cache.json'), 'utf8'))[0].durationSec,
      ).toBe(0);
    } finally {
      rmSync(invalidRoot, { recursive: true, force: true });
      rmSync(invalidDataDir, { recursive: true, force: true });
    }
  });
});
