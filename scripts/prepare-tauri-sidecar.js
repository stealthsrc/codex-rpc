#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = path.join(ROOT, 'bin', 'codex-rpc-daemon.exe');
const outDir = path.join(ROOT, 'src-tauri', 'binaries');
const target = path.join(outDir, `codex-rpc-daemon-${targetTriple()}.exe`);

if (!fs.existsSync(source)) {
  console.error(`[tauri-sidecar] missing ${path.relative(ROOT, source)}; run npm run dist first`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(source, target);
console.log(`[tauri-sidecar] ${path.relative(ROOT, target)}`);

function targetTriple() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  throw new Error(`unsupported Tauri sidecar target: ${process.platform}/${process.arch}`);
}
