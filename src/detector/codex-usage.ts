import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface CodexLimitSnapshot {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
  observedAtMs: number;
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
const ACCOUNT_USAGE_CACHE_MS = 30 * 1000;
const LOCAL_USAGE_REFRESH_MS = 60 * 1000;
let accountUsageCache: { checkedAt: number; usage: CodexUsageSnapshot | null } | null = null;
let lastLocalUsageRefreshMs = 0;

export function readLatestCodexUsage(
  root: string = SESSIONS_ROOT,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): CodexUsageSnapshot | null {
  if (root === SESSIONS_ROOT) {
    const accountUsage = readCodexAccountUsage();
    if (accountUsage) return accountUsage;
    refreshLocalCodexUsage();
  }

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

function refreshLocalCodexUsage(): void {
  const now = Date.now();
  if (now - lastLocalUsageRefreshMs < LOCAL_USAGE_REFRESH_MS) return;
  lastLocalUsageRefreshMs = now;

  for (const command of codexCommandCandidates()) {
    const result = spawnSync(command, ['login', 'status'], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    if (result.status === 0) return;
  }
}

function readCodexAccountUsage(): CodexUsageSnapshot | null {
  const now = Date.now();
  if (accountUsageCache && now - accountUsageCache.checkedAt < ACCOUNT_USAGE_CACHE_MS) {
    return accountUsageCache.usage;
  }

  const usage = readCodexAccountUsageUncached(now);
  accountUsageCache = { checkedAt: now, usage };
  return usage;
}

function readCodexAccountUsageUncached(observedAtMs: number): CodexUsageSnapshot | null {
  for (const command of codexCommandCandidates()) {
    const result = spawnSync(command, ['app-server', 'proxy'], {
      input: '{"id":1,"method":"account/rateLimits/read","params":null}\n',
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout.trim()) continue;

    const usage = parseAccountUsageResponse(result.stdout, observedAtMs);
    if (usage) return usage;
  }
  return null;
}

function codexCommandCandidates(): string[] {
  let candidates: string[];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const programFiles = process.env.ProgramFiles;
    candidates = [
      appData ? path.join(appData, 'npm', 'codex.cmd') : null,
      programFiles ? path.join(programFiles, 'nodejs', 'codex.cmd') : null,
    ].filter((value): value is string => Boolean(value));
  } else {
    const home = process.env.HOME;
    candidates = [
      home ? path.join(home, '.local', 'bin', 'codex') : null,
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    ].filter((value): value is string => Boolean(value));
  }
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export function parseAccountUsageResponse(
  raw: string,
  observedAtMs: number,
): CodexUsageSnapshot | null {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if ((msg?.id !== 1 && msg?.id !== '1') || !msg.result) continue;
      return parseAccountUsagePayload(msg.result, observedAtMs);
    } catch {
      continue;
    }
  }
  return null;
}

function parseAccountUsagePayload(
  payload: Record<string, unknown>,
  observedAtMs: number,
): CodexUsageSnapshot | null {
  const byLimitId = payload.rateLimitsByLimitId;
  const limits =
    byLimitId && typeof byLimitId === 'object'
      ? ((byLimitId as Record<string, unknown>).codex ?? payload.rateLimits)
      : payload.rateLimits;
  if (!limits || typeof limits !== 'object') return null;

  const record = limits as Record<string, unknown>;
  return {
    limitId: typeof record.limitId === 'string' ? record.limitId : null,
    primary: parseAccountLimit(record.primary, observedAtMs),
    secondary: parseAccountLimit(record.secondary, observedAtMs),
    creditsRemaining: parseCredits(record.credits),
    planType: typeof record.planType === 'string' ? record.planType : null,
    lastActivityMs: observedAtMs,
  };
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
      primary: parseLimit(limits.primary, lastActivityMs),
      secondary: parseLimit(limits.secondary, lastActivityMs),
      creditsRemaining: parseCredits(limits.credits),
      planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      lastActivityMs,
    };
  } catch {
    return null;
  }
}

function parseLimit(value: unknown, observedAtMs: number): CodexLimitSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const usedPercent = typeof record.used_percent === 'number' ? record.used_percent : null;
  if (usedPercent === null) return null;
  const windowMinutes =
    typeof record.window_minutes === 'number' ? record.window_minutes : null;
  const resetsAt =
    typeof record.resets_at === 'number' ? new Date(record.resets_at * 1000) : null;
  return { usedPercent, windowMinutes, resetsAt, observedAtMs };
}

function parseAccountLimit(value: unknown, observedAtMs: number): CodexLimitSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const usedPercent = typeof record.usedPercent === 'number' ? record.usedPercent : null;
  if (usedPercent === null) return null;
  const windowMinutes =
    typeof record.windowDurationMins === 'number' ? record.windowDurationMins : null;
  const resetsAt =
    typeof record.resetsAt === 'number' ? new Date(record.resetsAt * 1000) : null;
  return { usedPercent, windowMinutes, resetsAt, observedAtMs };
}

function parseCredits(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.balance === 'string') {
    const parsed = Number(record.balance);
    if (Number.isFinite(parsed)) return parsed;
  }
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
  if (
    limit.resetsAt &&
    limit.resetsAt.getTime() <= Date.now() &&
    limit.observedAtMs < limit.resetsAt.getTime()
  ) {
    return 100;
  }
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
