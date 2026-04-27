#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const releaseDir = path.join(ROOT, 'src-tauri', 'target', 'release');

function fail(message) {
  console.error(`[export-tauri] ${message}`);
  process.exit(1);
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function copyExecutable(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (process.platform !== 'win32') {
    fs.chmodSync(target, 0o755);
  }
  console.log(`[export-tauri] ${path.relative(ROOT, target)}`);
}

if (process.platform === 'win32') {
  const source = firstExisting([
    path.join(releaseDir, 'codex-rich-presence.exe'),
    path.join(releaseDir, 'codex_rich_presence_tray.exe'),
  ]);
  if (!source) fail('missing Tauri release exe');
  copyExecutable(source, path.join(ROOT, 'bin', 'codex-rich-presence.exe'));
} else if (process.platform === 'darwin') {
  const source = firstExisting([
    path.join(releaseDir, 'codex-rich-presence'),
    path.join(releaseDir, 'codex_rich_presence_tray'),
  ]);
  if (!source) fail('missing Tauri release binary');
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  copyExecutable(source, path.join(ROOT, 'bin', `codex-rich-presence-macos-${arch}`));
} else {
  const source = firstExisting([
    path.join(releaseDir, 'codex-rich-presence'),
    path.join(releaseDir, 'codex_rich_presence_tray'),
  ]);
  if (!source) fail(`unsupported platform ${process.platform}: missing Tauri release binary`);
  copyExecutable(source, path.join(ROOT, 'bin', `codex-rich-presence-${process.platform}-${os.arch()}`));
}
