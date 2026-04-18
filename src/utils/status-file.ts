import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATUS_PATH = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'codex-rich-presence',
  'status.txt',
);

export function statusFilePath(): string {
  return STATUS_PATH;
}

/**
 * Writes a single-line status summary to a shared file that the tray polls.
 * Atomic-ish: write tmp then rename, so a reader never sees a partial line.
 */
export function writeStatus(line: string): void {
  try {
    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    const tmp = STATUS_PATH + '.tmp';
    fs.writeFileSync(tmp, line.replace(/[\r\n]+/g, ' ').slice(0, 256));
    fs.renameSync(tmp, STATUS_PATH);
  } catch {
    /* ignore — tray is non-critical */
  }
}

export function clearStatus(): void {
  try {
    fs.unlinkSync(STATUS_PATH);
  } catch {
    /* ignore */
  }
}
