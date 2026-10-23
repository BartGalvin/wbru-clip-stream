import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installRoots: string[] = [];

afterEach(() => {
  for (const root of installRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('install-runtime-config', () => {
  it('renders every runtime file with the configured app and clip paths', () => {
    const installRoot = mkdtempSync(join(tmpdir(), 'wbru-runtime-config-'));
    const appDir = '/opt/wbru/custom-app';
    const clipsDir = '/mnt/wbru-media';
    installRoots.push(installRoot);

    execFileSync(process.execPath, ['deploy/install-runtime-config.mjs', 'all'], {
      env: {
        ...process.env,
        WBRU_APP_DIR: appDir,
        WBRU_CLIPS_DIR: clipsDir,
        WBRU_INSTALL_ROOT: installRoot,
      },
    });

    const nginx = readFileSync(join(installRoot, 'etc/nginx/sites-available/wbru'), 'utf8');
    const visualizer = readFileSync(
      join(installRoot, 'etc/systemd/system/wbru-visualizer.service'),
      'utf8',
    );
    const backup = readFileSync(
      join(installRoot, 'etc/systemd/system/wbru-backup.service'),
      'utf8',
    );
    const youtube = readFileSync(
      join(installRoot, 'etc/systemd/system/wbru-youtube-sync.service'),
      'utf8',
    );
    const renderedFiles = [nginx, visualizer, backup, youtube];

    expect(nginx).toContain(`root "${appDir}/dist";`);
    expect(nginx).toContain(`alias "${clipsDir}/";`);
    for (const page of ['stream', 'tag', 'builder', 'playout']) {
      expect(nginx).toContain(
        `location = /${page} {\n        return 302 /${page}.html$is_args$args;\n    }`,
      );
    }
    expect(nginx).toContain('auth_basic_user_file /etc/nginx/wbru-htpasswd;');
    expect(nginx).toContain('location ~* ^/api/tags(?:/|$) {');
    expect(nginx).toContain(String.raw`location ~ ^/clips/(?:[^/]+/)*\. {`);
    expect(nginx).toContain(String.raw`location ~ ^/clips/.*\.info\.json$ {`);
    expect(visualizer).toContain(`WorkingDirectory="${appDir}"`);
    expect(visualizer).toContain(`Environment="CLIPS_DIR=${clipsDir}"`);
    expect(visualizer).toContain(`RequiresMountsFor="${clipsDir}"`);
    expect(visualizer).toContain(`ExecStart="${appDir}/node_modules/.bin/tsx"`);
    expect(backup).toContain(`WorkingDirectory="${appDir}"`);
    expect(youtube).toContain(`WorkingDirectory="${appDir}"`);
    expect(youtube).toContain(`Environment="CLIPS_DIR=${clipsDir}"`);
    expect(youtube).toContain(`RequiresMountsFor="${clipsDir}"`);
    for (const rendered of renderedFiles) {
      expect(rendered).not.toMatch(/{{WBRU_[A-Z_]+}}/);
    }

    expect(
      readFileSync(join(installRoot, 'etc/systemd/system/wbru-backup.timer'), 'utf8'),
    ).toContain('OnUnitActiveSec=15min');
    expect(
      readFileSync(join(installRoot, 'etc/systemd/system/wbru-youtube-sync.timer'), 'utf8'),
    ).toContain('OnUnitActiveSec=6h');
  });

  it('leaves an existing nginx site untouched in core mode', () => {
    const installRoot = mkdtempSync(join(tmpdir(), 'wbru-runtime-config-'));
    const siteDirectory = join(installRoot, 'etc/nginx/sites-available');
    const sitePath = join(siteDirectory, 'wbru');
    installRoots.push(installRoot);
    mkdirSync(siteDirectory, { recursive: true });
    writeFileSync(sitePath, 'managed by certbot\n');

    execFileSync(process.execPath, ['deploy/install-runtime-config.mjs', 'core'], {
      env: {
        ...process.env,
        WBRU_INSTALL_ROOT: installRoot,
      },
    });

    expect(readFileSync(sitePath, 'utf8')).toBe('managed by certbot\n');
    expect(
      readFileSync(join(installRoot, 'etc/systemd/system/wbru-visualizer.service'), 'utf8'),
    ).toContain('WBRU visualizer program server');
  });
});
