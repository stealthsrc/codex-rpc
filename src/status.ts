import { formatEffort, formatModel, readCodexConfig } from './detector/codex-config';
import { classify } from './detector/classifier';
import { scanCodexProcesses } from './detector/process-scanner';

const STATE_LABELS = {
  off: 'Codex: Off',
  cli: 'Codex: CLI',
  app: 'Codex: Desktop',
  both: 'Codex: CLI/Desktop',
} as const;

/**
 * One-shot status check: scans running codex.exe processes, classifies each,
 * and prints a minimal two-line summary before exiting.
 *
 *   Codex: CLI/Desktop
 *   GPT-5.4 · Extra High
 *
 * When nothing is detected, only line 1 (`Codex: Off`) is printed.
 */
export async function runStatus(): Promise<void> {
  const snapshots = await scanCodexProcesses();
  let cli = 0;
  let app = 0;
  for (const snap of snapshots) {
    const kind = classify({ process: snap }).kind;
    if (kind === 'cli') cli++;
    else if (kind === 'app') app++;
  }

  let stateKey: keyof typeof STATE_LABELS = 'off';
  if (cli > 0 && app > 0) stateKey = 'both';
  else if (cli > 0) stateKey = 'cli';
  else if (app > 0) stateKey = 'app';

  process.stdout.write(STATE_LABELS[stateKey] + '\n');

  if (stateKey === 'off') return;

  const codex = readCodexConfig();
  const model = formatModel(codex?.model ?? null);
  const effort = formatEffort(codex?.effort ?? null);
  const parts = [model, effort].filter((p): p is string => Boolean(p));
  if (parts.length > 0) {
    process.stdout.write(parts.join(' · ') + '\n');
  }
}
