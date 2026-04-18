import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexSessionSnapshot {
  cwd: string;
  originator: string | null;
  /** `path.basename(cwd)` normalized, falls back to the last non-empty segment. */
  repoName: string;
  /** Session file mtime (ms since epoch). Used as a recency proxy. */
  lastActivityMs: number;
}

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

/**
 * Finds the most recently modified rollout-*.jsonl file and extracts its
 * session_meta (first line). Returns null if the sessions directory is empty
 * or the file is unreadable.
 *
 * We intentionally avoid reading state_5.sqlite — no native deps, and the
 * rollout files are append-only so the first line is cheap to parse.
 */
export function readLatestCodexSession(
  root: string = SESSIONS_ROOT,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): CodexSessionSnapshot | null {
  const latest = findLatestRolloutFile(root, maxAgeMs);
  if (!latest) return null;

  const firstLine = readFirstLine(latest.path);
  if (!firstLine) return null;

  try {
    const obj = JSON.parse(firstLine);
    if (obj?.type !== 'session_meta') return null;
    const payload = obj.payload ?? {};
    const cwdRaw = typeof payload.cwd === 'string' ? payload.cwd : null;
    if (!cwdRaw) return null;
    const cwd = stripWindowsLongPrefix(cwdRaw);
    return {
      cwd,
      originator: typeof payload.originator === 'string' ? payload.originator : null,
      repoName: basenameSafe(cwd),
      lastActivityMs: latest.mtimeMs,
    };
  } catch {
    return null;
  }
}

function findLatestRolloutFile(
  root: string,
  maxAgeMs: number,
): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;
  const now = Date.now();

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > maxAgeMs) continue;
      if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
    }
  };

  walk(root);
  return best;
}

function readFirstLine(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytes).toString('utf8');
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(0, nl) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function stripWindowsLongPrefix(p: string): string {
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function basenameSafe(p: string): string {
  const normalized = p.replace(/[\\/]+$/, '');
  const sep = /[\\/]/;
  const segments = normalized.split(sep).filter((s) => s.length > 0);
  if (segments.length === 0) return normalized;
  // On Windows, `C:\foo\bar` → ['C:', 'foo', 'bar']. Skip the drive root.
  const last = segments[segments.length - 1];
  if (/^[A-Za-z]:$/.test(last) && segments.length === 1) return last;
  return last;
}
