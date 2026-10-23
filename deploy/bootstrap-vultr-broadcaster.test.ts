import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const renderer = join(process.cwd(), 'deploy/broadcaster/render-template.sh');
const templates = join(process.cwd(), 'deploy/broadcaster/templates');
const installRoots: string[] = [];

afterEach(() => {
  for (const root of installRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function installTemplate(
  name: string,
  destination: string,
  mode: string,
  replacements: Record<string, string> = {},
) {
  mkdirSync(dirname(destination), { recursive: true });
  const replacementArgs = Object.entries(replacements).flat();

  execFileSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; shift; install_broadcaster_template "$@"',
      'broadcaster-template-test',
      renderer,
      join(templates, name),
      destination,
      mode,
      '',
      '',
      ...replacementArgs,
    ],
    { stdio: 'pipe' },
  );
}

describe('Vultr broadcaster templates', () => {
  it('installs static files byte-for-byte with their expected modes', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbru-broadcaster-static-'));
    installRoots.push(root);

    const files = [
      ['obs-disable-blanking', 'usr/local/bin/obs-disable-blanking', '755'],
      ['obs-disable-blanking.desktop', 'home/obs/.config/autostart/blanking.desktop', '644'],
      ['disabled-autostart.desktop', 'home/obs/.config/autostart/light-locker.desktop', '644'],
      ['obs-gpu', 'usr/local/bin/obs-gpu', '755'],
      ['obs-gpu.desktop', 'home/obs/.local/share/applications/obs-gpu.desktop', '644'],
      ['obs-gpu-autostart.desktop', 'home/obs/.config/autostart/obs-gpu.desktop', '644'],
    ] as const;

    for (const [template, relativeDestination, mode] of files) {
      const destination = join(root, relativeDestination);
      installTemplate(template, destination, mode);

      expect(readFileSync(destination, 'utf8')).toBe(
        readFileSync(join(templates, template), 'utf8'),
      );
      expect(statSync(destination).mode & 0o777).toBe(Number.parseInt(mode, 8));
    }
  });

  it('resolves every dynamic placeholder into the installed content', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbru-broadcaster-dynamic-'));
    const lightdm = join(root, 'etc/lightdm/lightdm.conf.d/50-obs-autologin.conf');
    const vnc = join(root, 'etc/systemd/system/x0tigervnc.service');
    const obsHome = '/srv/obs&relay';
    installRoots.push(root);

    installTemplate('50-obs-autologin.conf', lightdm, '644', {
      OBS_USER: 'broadcaster',
    });
    installTemplate('x0tigervnc.service', vnc, '644', {
      OBS_USER: 'broadcaster',
      OBS_HOME: obsHome,
      VNC_PORT: '5999',
    });

    const lightdmContent = readFileSync(lightdm, 'utf8');
    const vncContent = readFileSync(vnc, 'utf8');
    expect(lightdmContent).toContain('autologin-user=broadcaster\n');
    expect(vncContent).toContain('User=broadcaster\n');
    expect(vncContent).toContain(`Environment=XAUTHORITY=${obsHome}/.Xauthority\n`);
    expect(vncContent).toContain(`-rfbport 5999 -localhost`);
    expect(vncContent).toContain(`-PasswordFile ${obsHome}/.vnc/passwd`);
    expect(lightdmContent + vncContent).not.toMatch(/{{[A-Z][A-Z0-9_]*}}/);
    expect(statSync(lightdm).mode & 0o777).toBe(0o644);
    expect(statSync(vnc).mode & 0o777).toBe(0o644);
  });

  it('rejects a template when required placeholders are omitted', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbru-broadcaster-unresolved-'));
    installRoots.push(root);

    expect(() =>
      installTemplate(
        'x0tigervnc.service',
        join(root, 'etc/systemd/system/x0tigervnc.service'),
        '644',
      ),
    ).toThrow();
  });
});
