#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = path.join(ROOT, 'src-tauri', 'target', 'release', 'codex-rich-presence.exe');
const fallback = path.join(ROOT, 'src-tauri', 'target', 'release', 'codex_rich_presence_tray.exe');
const target = path.join(ROOT, 'bin', 'codex-rich-presence.exe');
const selected = fs.existsSync(source) ? source : fallback;

if (!fs.existsSync(selected)) {
  console.error('[export-tauri] missing Tauri release exe');
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(selected, target);
console.log(`[export-tauri] ${path.relative(ROOT, target)}`);
