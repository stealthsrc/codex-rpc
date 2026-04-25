import { getLogger } from '../utils/logger';
import { classify } from './classifier';
import { readCodexConfig } from './codex-config';
import { readLatestCodexSession } from './codex-session';
import { readLatestCodexUsage } from './codex-usage';
import { scanCodexProcesses } from './process-scanner';
import { deriveState, StateMachine, type DetectionResult } from './state';

export type { DetectionResult, PresenceState } from './state';

export interface DetectorOptions {
  idleGraceMs: number;
}

export class Detector {
  private readonly machine: StateMachine;

  constructor(options: DetectorOptions) {
    this.machine = new StateMachine({ idleGraceMs: options.idleGraceMs });
  }

  async tick(): Promise<DetectionResult> {
    const log = getLogger();
    const snapshots = await scanCodexProcesses();
    const classified = snapshots.map((snapshot) => ({
      snapshot,
      classification: classify({ process: snapshot }),
    }));

    for (const c of classified) {
      if (c.classification.kind === 'unknown') {
        log.warn(
          {
            pid: c.snapshot.processId,
            parent: c.snapshot.parentName,
            exe: c.snapshot.executablePath,
          },
          'classifier: unknown codex.exe — not surfaced to RPC',
        );
      } else {
        log.debug(
          {
            pid: c.snapshot.processId,
            kind: c.classification.kind,
            rule: c.classification.rule,
            parent: c.snapshot.parentName,
          },
          'classifier: matched',
        );
      }
    }

    const raw = deriveState(classified);
    raw.codex = readCodexConfig();
    raw.session = raw.state === 'idle' ? null : readLatestCodexSession();
    raw.usage = readLatestCodexUsage();
    const result = this.machine.step(raw);
    return result;
  }
}
