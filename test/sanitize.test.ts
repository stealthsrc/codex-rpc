import { describe, expect, it } from 'vitest';
import { buildPresence } from '../src/rpc/presence-builder';
import type { DetectionResult } from '../src/detector/state';

function mk(
  state: DetectionResult['state'],
  codex: DetectionResult['codex'] = null,
  session: DetectionResult['session'] = null,
): DetectionResult {
  return {
    state,
    startedAt: new Date('2026-04-18T10:00:00Z'),
    processCounts: { cli: 1, app: 0, unknown: 0 },
    codex,
    session,
  };
}

describe('presence-builder sanitation', () => {
  it('strips control characters from repoName', () => {
    const p = buildPresence(
      mk('cli', null, {
        cwd: 'D:\\evil',
        originator: 'codex-tui',
        repoName: 'repo\u0000\u0007malicious',
        lastActivityMs: Date.now(),
      }),
    );
    expect(p?.details).toBe('Coding with Codex CLI · repomalicious');
  });

  it('removes RTL override / bidi characters', () => {
    const p = buildPresence(
      mk('cli', null, {
        cwd: 'x',
        originator: null,
        repoName: 'good\u202Ebad',
        lastActivityMs: Date.now(),
      }),
    );
    expect(p?.details).toBe('Coding with Codex CLI · goodbad');
  });

  it('truncates oversize repo with ellipsis', () => {
    const p = buildPresence(
      mk('cli', null, {
        cwd: 'x',
        originator: null,
        repoName: 'a'.repeat(50),
        lastActivityMs: Date.now(),
      }),
    );
    const repo = p?.details.split(' · ')[1] ?? '';
    expect(repo.length).toBeLessThanOrEqual(32);
    expect(repo.endsWith('…')).toBe(true);
  });

  it('model with control chars is scrubbed', () => {
    const p = buildPresence(
      mk('cli', { model: 'gpt-5.4\u0008', effort: 'xhigh', serviceTier: null }),
    );
    expect(p?.state).toBe('GPT-5.4 · Extra High');
  });
});
