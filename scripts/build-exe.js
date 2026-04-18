#!/usr/bin/env node
/*
 * Windows EXE build with icon + version stamping (pkg-overlay-safe).
 *
 * pkg appends a bytecode payload at a fixed offset computed against the base
 * Node binary's PE layout. Stamping resources *after* pkg shifts the PE end
 * and corrupts the payload offset. Solution: stamp the base binary *before*
 * pkg runs. To bypass pkg-fetch's integrity check, we:
 *
 *   1. Ensure the base Node binary is cached (run a throwaway pkg if not).
 *   2. rcedit the cached binary with the icon + version info.
 *   3. Re-hash the modified binary and patch pkg-fetch's expected-shas.json.
 *   4. Run pkg → hash check passes → base used as-is → payload offsets line up.
 *   5. Restore the original binary + hash table so we don't pollute other
 *      projects that share this pkg cache / node_modules.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE_TARGET = 'node22-win-x64';
const NODE_VERSION_KEY = 'node-v22.22.2-win-x64';
const CACHE_FILENAME = 'fetched-v22.22.2-win-x64';
const PKG_CACHE_DIR = path.join(os.homedir(), '.pkg-cache', 'v3.5');
const EXPECTED_SHAS = path.join(
  ROOT,
  'node_modules',
  '@yao-pkg',
  'pkg-fetch',
  'lib-es5',
  'expected-shas.json',
);

const exePath = path.join(ROOT, 'bin', 'codex-rich-presence.exe');
const iconPath = path.join(ROOT, 'assets', 'app.ico');
const pkgJson = require(path.join(ROOT, 'package.json'));

function log(msg) {
  process.stdout.write(`[build-exe] ${msg}\n`);
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function runPkg() {
  const bin = process.platform === 'win32' ? 'pkg.cmd' : 'pkg';
  const args = [
    '.',
    '--targets',
    NODE_TARGET,
    '--compress',
    'Brotli',
    '--output',
    path.join('bin', 'codex-rich-presence.exe'),
  ];
  const res = spawnSync(bin, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) throw new Error(`pkg exited with code ${res.status}`);
}

// UPX is intentionally NOT invoked here: pkg's loader `fs.openSync`s its own
// EXE on disk and seeks to a fixed payload offset. UPX unpacks the PE in
// memory at startup, so the on-disk file pkg reads is still the compressed
// form — the payload offsets don't match and the loader crashes with
// "Pkg: Error reading from file."
//
// Brotli payload compression via pkg itself (see runPkg) is the safe path
// and shrinks the EXE ~11%. Further gains would require swapping pkg for
// Node SEA + a wrapper that handles decompression before the Node runtime
// starts.

async function stampBase(basePath) {
  const rcedit = require('rcedit');
  await rcedit(basePath, {
    icon: iconPath,
    'version-string': {
      ProductName: 'Codex Rich Presence',
      FileDescription: pkgJson.description || 'Codex Rich Presence',
      CompanyName: pkgJson.author || '',
      LegalCopyright: `(C) ${new Date().getFullYear()} ${pkgJson.author || ''}`,
      OriginalFilename: 'codex-rich-presence.exe',
    },
    'file-version': pkgJson.version || '0.0.0',
    'product-version': pkgJson.version || '0.0.0',
  });
}

async function main() {
  const cachedBase = path.join(PKG_CACHE_DIR, CACHE_FILENAME);

  if (!fs.existsSync(cachedBase)) {
    log('base Node binary not cached yet — running pkg once to fetch it.');
    runPkg();
    if (!fs.existsSync(cachedBase)) {
      throw new Error(`pkg did not populate ${cachedBase}`);
    }
  }

  if (!fs.existsSync(iconPath)) {
    log(`no icon at ${iconPath} — building unstamped EXE.`);
    runPkg();
    log(`done: ${path.relative(ROOT, exePath)}`);
    return;
  }

  log('snapshotting original base binary + expected-shas.json');
  const originalBase = fs.readFileSync(cachedBase);
  const originalShas = fs.readFileSync(EXPECTED_SHAS, 'utf8');
  let shasObj;
  try {
    shasObj = JSON.parse(originalShas);
  } catch (e) {
    throw new Error(`cannot parse ${EXPECTED_SHAS}: ${e.message}`);
  }
  if (!shasObj[NODE_VERSION_KEY]) {
    throw new Error(`no expected-shas entry for ${NODE_VERSION_KEY}`);
  }

  try {
    log(`stamping ${path.basename(cachedBase)} with icon + version info`);
    await stampBase(cachedBase);

    log('patching PE subsystem to Windows GUI (suppresses console on double-click)');
    patchPeSubsystem(cachedBase, 2);

    const newHash = sha256(cachedBase);
    log(`new SHA256: ${newHash}`);
    shasObj[NODE_VERSION_KEY] = newHash;
    fs.writeFileSync(EXPECTED_SHAS, JSON.stringify(shasObj, null, 4) + '\n');

    log('running pkg against stamped base binary');
    runPkg();
  } finally {
    log('restoring original base binary + expected-shas.json');
    fs.writeFileSync(cachedBase, originalBase);
    fs.writeFileSync(EXPECTED_SHAS, originalShas);
  }

  const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  log(`built ${path.relative(ROOT, exePath)} (${sizeMb} MB)`);
}

/**
 * Flip the PE Optional Header "Subsystem" field. 2 = Windows GUI (no console),
 * 3 = Windows CUI (console). Offset from PE signature:
 *   PE sig (4) + COFF header (20) + Magic (2) → field is at +68 in the
 *   Optional Header for both PE32 and PE32+. Easier: seek PE sig then +4+20
 *   (= start of Optional Header) then +68.
 */
function patchPeSubsystem(filePath, value) {
  const fd = fs.openSync(filePath, 'r+');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0x3c);
    const eLfanew = buf.readUInt32LE(0);
    const optionalHeaderStart = eLfanew + 4 + 20;
    const subsystemOffset = optionalHeaderStart + 68;
    const ss = Buffer.alloc(2);
    ss.writeUInt16LE(value, 0);
    fs.writeSync(fd, ss, 0, 2, subsystemOffset);
  } finally {
    fs.closeSync(fd);
  }
}

main().catch((err) => {
  console.error('[build-exe] failed:', err.message);
  process.exit(1);
});
