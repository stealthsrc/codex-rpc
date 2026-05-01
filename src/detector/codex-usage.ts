import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexLimitSnapshot {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
}

export interface CodexUsageSnapshot {
  limitId: string | null;
  primary: CodexLimitSnapshot | null;
  secondary: CodexLimitSnapshot | null;
  creditsRemaining: number | null;
  planType: string | null;
  lastActivityMs: number;
}

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const READ_TAIL_BYTES = 256 * 1024;

export function readLatestCodexUsage(
  root: string = SESSIONS_ROOT,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): CodexUsageSnapshot | null {
  const files = findRecentRolloutFiles(root, maxAgeMs);
  let fallback: CodexUsageSnapshot | null = null;
  for (const file of files) {
    const lines = readTailLines(file.path);
    if (!lines) continue;

    for (let i = lines.length - 1; i >= 0; i--) {
      const usage = parseUsageLine(lines[i], file.mtimeMs);
      if (!usage) continue;
      if (usage.limitId === 'codex') return usage;
      fallback ??= usage;
    }
  }
  return fallback;
}

export function formatCodexUsage(usage: CodexUsageSnapshot | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  const primary = formatLimit('5h', usage.primary);
  const secondary = formatLimit('week', usage.secondary);
  if (primary) parts.push(primary);
  if (secondary) parts.push(secondary);
  if (usage.creditsRemaining !== null) parts.push(`credits ${usage.creditsRemaining}`);
  if (parts.length === 0) return null;
  return `Usage: ${parts.join(' / ')}`;
}

function parseUsageLine(line: string, lastActivityMs: number): CodexUsageSnapshot | null {
  try {
    const obj = JSON.parse(line);
    if (obj?.type !== 'event_msg' || obj.payload?.type !== 'token_count') return null;
    const limits = obj.payload.rate_limits;
    if (!limits || typeof limits !== 'object') return null;
    return {
      limitId: typeof limits.limit_id === 'string' ? limits.limit_id : null,
      primary: parseLimit(limits.primary),
      secondary: parseLimit(limits.secondary),
      creditsRemaining: parseCredits(limits.credits),
      planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      lastActivityMs,
    };
  } catch {
    return null;
  }
}

function parseLimit(value: unknown): CodexLimitSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const usedPercent = typeof record.used_percent === 'number' ? record.used_percent : null;
  if (usedPercent === null) return null;
  const windowMinutes =
    typeof record.window_minutes === 'number' ? record.window_minutes : null;
  const resetsAt =
    typeof record.resets_at === 'number' ? new Date(record.resets_at * 1000) : null;
  return { usedPercent, windowMinutes, resetsAt };
}

function parseCredits(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.remaining === 'number') return record.remaining;
  if (typeof record.balance === 'number') return record.balance;
  return null;
}

function formatLimit(label: string, limit: CodexLimitSnapshot | null): string | null {
  if (!limit) return null;
  const remaining = remainingPercent(limit);
  return `${label} ${remaining}% left`;
}

export function remainingPercent(limit: CodexLimitSnapshot): number {
  if (limit.resetsAt && limit.resetsAt.getTime() <= Date.now()) return 100;
  return Math.max(0, Math.round(100 - limit.usedPercent));
}

function findRecentRolloutFiles(
  root: string,
  maxAgeMs: number,
): { path: string; mtimeMs: number }[] {
  const files: { path: string; mtimeMs: number }[] = [];
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
      files.push({ path: full, mtimeMs });
    }
  };

  walk(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readTailLines(filePath: string): string[] | null {
  try {
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, READ_TAIL_BYTES);
    const offset = stat.size - length;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
      return offset > 0 ? lines.slice(1) : lines;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
