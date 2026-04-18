import { describe, expect, it } from 'vitest';
import {
  deriveState,
  StateMachine,
  type ClassifiedProcess,
  type DetectionResult,
} from '../src/detector/state';

function baseCounts(state: DetectionResult['state']) {
  return {
    cli: state === 'cli' || state === 'both' ? 1 : 0,
    app: state === 'app' || state === 'both' ? 1 : 0,
    unknown: 0,
  };
}

function mk(kind: 'cli' | 'app' | 'unknown', pid: number, iso: string): ClassifiedProcess {
  return {
    snapshot: {
      processId: pid,
      parentProcessId: 0,
      parentName: null,
      executablePath: null,
      commandLine: null,
      creationDate: new Date(iso),
    },
    classification: { kind, rule: kind === 'cli' ? 1 : kind === 'app' ? 4 : 0 },
  };
}

describe('deriveState', () => {
  it('idle when nothing', () => {
    expect(deriveState([]).state).toBe('idle');
  });

  it('cli only', () => {
    const r = deriveState([mk('cli', 1, '2026-04-18T10:00:00Z')]);
    expect(r.state).toBe('cli');
    expect(r.processCounts.cli).toBe(1);
  });

  it('app only', () => {
    const r = deriveState([mk('app', 1, '2026-04-18T10:00:00Z')]);
    expect(r.state).toBe('app');
  });

  it('both when cli + app', () => {
    const r = deriveState([
      mk('cli', 1, '2026-04-18T10:01:00Z'),
      mk('app', 2, '2026-04-18T10:00:00Z'),
    ]);
    expect(r.state).toBe('both');
    expect(r.startedAt?.toISOString()).toBe('2026-04-18T10:00:00.000Z');
  });

  it('oldest CreationDate wins for startedAt', () => {
    const r = deriveState([
      mk('cli', 1, '2026-04-18T11:00:00Z'),
      mk('cli', 2, '2026-04-18T09:00:00Z'),
      mk('cli', 3, '2026-04-18T10:00:00Z'),
    ]);
    expect(r.startedAt?.toISOString()).toBe('2026-04-18T09:00:00.000Z');
  });

  it('unknowns are counted but do not trigger state', () => {
    const r = deriveState([mk('unknown', 1, '2026-04-18T10:00:00Z')]);
    expect(r.state).toBe('idle');
    expect(r.processCounts.unknown).toBe(1);
  });
});

describe('StateMachine', () => {
  const result = (
    state: DetectionResult['state'],
    startedAt: Date | null,
  ): DetectionResult => ({
    state,
    startedAt,
    processCounts: baseCounts(state),
    codex: null,
  });

  it('emits non-idle directly', () => {
    const sm = new StateMachine({ idleGraceMs: 10_000, now: () => 0 });
    const r = sm.step(result('cli', new Date('2026-04-18T10:00:00Z')));
    expect(r.state).toBe('cli');
  });

  it('holds last state during grace window', () => {
    let now = 0;
    const sm = new StateMachine({ idleGraceMs: 10_000, now: () => now });
    sm.step(result('cli', new Date('2026-04-18T10:00:00Z')));
    now = 5_000;
    const held = sm.step(result('idle', null));
    expect(held.state).toBe('cli');
  });

  it('falls to idle after grace expires', () => {
    let now = 0;
    const sm = new StateMachine({ idleGraceMs: 10_000, now: () => now });
    sm.step(result('cli', new Date('2026-04-18T10:00:00Z')));
    now = 11_000;
    const out = sm.step(result('idle', null));
    expect(out.state).toBe('idle');
  });

  it('preserves anchor start when transitioning cli → both', () => {
    let now = 0;
    const sm = new StateMachine({ idleGraceMs: 10_000, now: () => now });
    const cliStart = new Date('2026-04-18T10:00:00Z');
    sm.step(result('cli', cliStart));
    now = 2_000;
    const bothStart = new Date('2026-04-18T10:05:00Z');
    const out = sm.step(result('both', bothStart));
    expect(out.state).toBe('both');
    expect(out.startedAt?.getTime()).toBe(cliStart.getTime());
  });

  it('resets anchor when coming back from idle', () => {
    let now = 0;
    const sm = new StateMachine({ idleGraceMs: 1_000, now: () => now });
    sm.step(result('cli', new Date('2026-04-18T10:00:00Z')));
    now = 5_000; // grace expired
    sm.step(result('idle', null));
    now = 6_000;
    const next = new Date('2026-04-18T11:00:00Z');
    const out = sm.step(result('app', next));
    expect(out.state).toBe('app');
    expect(out.startedAt?.getTime()).toBe(next.getTime());
  });
});
