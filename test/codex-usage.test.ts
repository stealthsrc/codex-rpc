import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatCodexUsage, readLatestCodexUsage } from '../src/detector/codex-usage';

function tmpRoot(): string {
  return path.join(os.tmpdir(), `codex-usage-test-${process.pid}-${Date.now()}`);
}

describe('readLatestCodexUsage', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeRollout(rel: string, lines: unknown[], mtime = new Date()): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    fs.utimesSync(full, mtime, mtime);
  }

  it('extracts latest token_count rate limits', () => {
    writeRollout('2026/04/25/rollout-a.jsonl', [
      { type: 'session_meta', payload: { cwd: 'D:\\repo' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 5, window_minutes: 300, resets_at: 1777162140 },
            secondary: { used_percent: 19, window_minutes: 10080, resets_at: 1777477620 },
            credits: { remaining: 0 },
            plan_type: 'pro',
          },
        },
      },
    ]);

    const usage = readLatestCodexUsage(root);
    expect(usage?.limitId).toBe('codex');
    expect(usage?.primary?.usedPercent).toBe(5);
    expect(usage?.secondary?.usedPercent).toBe(19);
    expect(usage?.creditsRemaining).toBe(0);
    expect(formatCodexUsage(usage)).toBe('Usage: 5h 95% left / week 81% left / credits 0');
  });

  it('returns null when no token_count exists', () => {
    writeRollout('rollout-empty.jsonl', [{ type: 'session_meta', payload: {} }]);
    expect(readLatestCodexUsage(root)).toBeNull();
  });

  it('falls back to older recent rollouts when latest has no rate limits', () => {
    writeRollout(
      'rollout-with-usage.jsonl',
      [
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              primary: { used_percent: 21, window_minutes: 300 },
              secondary: { used_percent: 24, window_minutes: 10080 },
            },
          },
        },
      ],
      new Date(Date.now() - 1000),
    );
    writeRollout('rollout-empty.jsonl', [{ type: 'session_meta', payload: {} }]);

    expect(formatCodexUsage(readLatestCodexUsage(root))).toBe(
      'Usage: 5h 79% left / week 76% left',
    );
  });
});
