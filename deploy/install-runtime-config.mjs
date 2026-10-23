#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const installRoot = process.env.WBRU_INSTALL_ROOT ?? '';
const mode = process.argv[2];

// Group runtime templates by the subsystem an operator is installing.
const fileSets = {
  web: [['nginx.conf', '/etc/nginx/sites-available/wbru']],
  core: [
    ['wbru-visualizer.service', '/etc/systemd/system/wbru-visualizer.service'],
    ['wbru-backup.service', '/etc/systemd/system/wbru-backup.service'],
    ['wbru-backup.timer', '/etc/systemd/system/wbru-backup.timer'],
  ],
  youtube: [
    ['wbru-youtube-sync.service', '/etc/systemd/system/wbru-youtube-sync.service'],
    ['wbru-youtube-sync.timer', '/etc/systemd/system/wbru-youtube-sync.timer'],
  ],
};

if (!['web', 'core', 'youtube', 'all'].includes(mode)) {
  console.error('Usage: deploy/install-runtime-config.mjs <web|core|youtube|all>');
  process.exit(2);
}

// Accept only absolute deployment paths that are safe to substitute into templates.
function deploymentPath(name, fallback) {
  const value = (process.env[name] || fallback).replace(/\/+$/, '');
  if (!value.startsWith('/') || value === '' || /[\r\n"]/.test(value)) {
    throw new Error(`${name} must be an absolute path without quotes or newlines.`);
  }
  return value;
}

const replacements = new Map([
  ['{{WBRU_APP_DIR}}', deploymentPath('WBRU_APP_DIR', '/srv/wbru/app')],
  ['{{WBRU_CLIPS_DIR}}', deploymentPath('WBRU_CLIPS_DIR', '/srv/wbru/clips')],
]);
const selectedFiles =
  mode === 'all' ? [...fileSets.web, ...fileSets.core, ...fileSets.youtube] : fileSets[mode];

// Prefix installation paths with WBRU_INSTALL_ROOT when set.
function installedPath(path) {
  return installRoot ? join(installRoot, path.slice(1)) : path;
}

// Render and atomically install each selected systemd or nginx configuration file.
for (const [templateName, destination] of selectedFiles) {
  let rendered = readFileSync(join(here, templateName), 'utf8');
  for (const [placeholder, value] of replacements) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/{{WBRU_[A-Z_]+}}/.test(rendered)) {
    throw new Error(`Unresolved deployment placeholder in ${templateName}.`);
  }

  const target = installedPath(destination);
  const temporary = `${target}.tmp-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(temporary, rendered, { mode: 0o644 });
    renameSync(temporary, target);
    chmodSync(target, 0o644);
  } finally {
    rmSync(temporary, { force: true });
  }
}
