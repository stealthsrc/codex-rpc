import type { Classification } from './classifier';
import type { CodexConfig } from './codex-config';
import type { CodexSessionSnapshot } from './codex-session';
import type { CodexUsageSnapshot } from './codex-usage';
import type { ProcessSnapshot } from './process-scanner';

export type PresenceState = 'idle' | 'cli' | 'app' | 'both';

export interface ClassifiedProcess {
  snapshot: ProcessSnapshot;
  classification: Classification;
}

export interface DetectionResult {
  state: PresenceState;
  startedAt: Date | null;
  processCounts: { cli: number; app: number; unknown: number };
  codex: CodexConfig | null;
  session: CodexSessionSnapshot | null;
  usage: CodexUsageSnapshot | null;
}

export function deriveState(classified: ClassifiedProcess[]): DetectionResult {
  let cli = 0;
  let app = 0;
  let unknown = 0;
  let oldest: Date | null = null;

  for (const item of classified) {
    const kind = item.classification.kind;
    if (kind === 'cli') cli++;
    else if (kind === 'app') app++;
    else unknown++;

    if (kind === 'cli' || kind === 'app') {
      const created = item.snapshot.creationDate;
      if (created && (!oldest || created < oldest)) oldest = created;
    }
  }

  let state: PresenceState;
  if (cli > 0 && app > 0) state = 'both';
  else if (cli > 0) state = 'cli';
  else if (app > 0) state = 'app';
  else state = 'idle';

  return {
    state,
    startedAt: oldest,
    processCounts: { cli, app, unknown },
    codex: null,
    session: null,
    usage: null,
  };
}

export interface StateMachineOptions {
  idleGraceMs: number;
  now?: () => number;
}

/**
 * Holds onto the last non-idle detection until the grace period elapses.
 * Prevents IDLE flicker when a CLI one-shot exits and is relaunched (e.g. `codex --help`).
 */
export class StateMachine {
  private lastNonIdle: DetectionResult | null = null;
  private lastNonIdleAt = 0;
  private lastEmitted: DetectionResult = {
    state: 'idle',
    startedAt: null,
    processCounts: { cli: 0, app: 0, unknown: 0 },
    codex: null,
    session: null,
    usage: null,
  };
  private anchorStart: Date | null = null;

  constructor(private readonly options: StateMachineOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  step(result: DetectionResult): DetectionResult {
    const now = this.now();

    if (result.state !== 'idle') {
      // When transitioning between non-idle states, keep the oldest anchor so Discord timers don't reset.
      if (!this.anchorStart || this.lastEmitted.state === 'idle') {
        this.anchorStart = result.startedAt;
      } else if (result.startedAt && (!this.anchorStart || result.startedAt < this.anchorStart)) {
        this.anchorStart = result.startedAt;
      }

      const merged: DetectionResult = { ...result, startedAt: this.anchorStart };
      this.lastNonIdle = merged;
      this.lastNonIdleAt = now;
      this.lastEmitted = merged;
      return merged;
    }

    // result.state === 'idle'. Hold previous state within grace window.
    if (this.lastNonIdle && now - this.lastNonIdleAt < this.options.idleGraceMs) {
      return this.lastEmitted;
    }

    this.lastNonIdle = null;
    this.anchorStart = null;
    this.lastEmitted = result;
    return result;
  }
}
