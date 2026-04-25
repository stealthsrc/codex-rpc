import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLatestCodexSession } from '../src/detector/codex-session';

function tmpRoot(): string {
  return path.join(os.tmpdir(), `codex-session-test-${process.pid}-${Date.now()}`);
}

describe('readLatestCodexSession', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeRollout = (
    rel: string,
    payload: Record<string, unknown>,
    mtime?: Date,
  ): string => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const line = JSON.stringify({
      timestamp: '2026-04-18T10:00:00Z',
      type: 'session_meta',
      payload,
    });
    fs.writeFileSync(full, line + '\n{"type":"event_msg","payload":{}}\n');
    if (mtime) fs.utimesSync(full, mtime, mtime);
    return full;
  };

  it('returns null when root does not exist', () => {
    expect(readLatestCodexSession(path.join(root, 'missing'))).toBeNull();
  });

  it('returns null when no rollout files exist', () => {
    expect(readLatestCodexSession(root)).toBeNull();
  });

  it('picks the most recent rollout file', () => {
    const now = Date.now();
    writeRollout(
      '2026/04/17/rollout-2026-04-17T10-00-00-old.jsonl',
      { cwd: 'D:\\old', originator: 'codex-tui' },
      new Date(now - 2_000),
    );
    writeRollout(
      '2026/04/18/rollout-2026-04-18T09-00-00-new.jsonl',
      { cwd: 'D:\\new\\project', originator: 'codex-tui' },
      new Date(now - 1_000),
    );
    const session = readLatestCodexSession(root);
    expect(session?.cwd).toBe('D:\\new\\project');
    expect(session?.repoName).toBe('project');
    expect(session?.originator).toBe('codex-tui');
  });

  it('strips Windows \\\\?\\ long-path prefix', () => {
    writeRollout('2026/04/18/rollout-a.jsonl', { cwd: '\\\\?\\D:\\Users\\foo\\bar' });
    const session = readLatestCodexSession(root);
    expect(session?.cwd).toBe('D:\\Users\\foo\\bar');
    expect(session?.repoName).toBe('bar');
  });

  it('ignores rollouts older than the age window', () => {
    writeRollout(
      '2026/04/10/rollout-old.jsonl',
      { cwd: 'D:\\old' },
      new Date(Date.now() - 48 * 60 * 60 * 1000),
    );
    expect(readLatestCodexSession(root, 60 * 60 * 1000)).toBeNull();
  });

  it('returns null when first line is not session_meta', () => {
    const full = path.join(root, 'rollout-bad.jsonl');
    fs.writeFileSync(full, '{"type":"event_msg","payload":{}}\n');
    expect(readLatestCodexSession(root)).toBeNull();
  });
});
