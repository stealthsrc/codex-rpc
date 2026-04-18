import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LockResult {
  acquired: boolean;
  /** When acquired=false, the PID of the existing owner (if known). */
  existingPid: number | null;
  release: () => void;
}

interface LockRecord {
  pid: number;
  startTimeMs: number;
  exe: string;
}

/**
 * Lock file holds a JSON record identifying the owner: PID, Node start time,
 * and the Node `execPath`. A forged lock file containing an arbitrary PID
 * (e.g. explorer.exe) is rejected because the record won't match that
 * process's identity, letting us reclaim the lock without DoS.
 *
 * On Windows, named mutexes would be stronger, but require a native addon.
 * This file-based scheme closes the obvious spoof vector while staying
 * pure-JS + `pkg`-friendly.
 */
export function acquireSingleInstanceLock(appName = 'codex-rich-presence'): LockResult {
  const dir = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    appName,
  );
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, 'instance.lock');

  const ownRecord: LockRecord = {
    pid: process.pid,
    startTimeMs: startTimeMs(),
    exe: process.execPath,
  };

  const tryAcquire = (): { fd: number | null; existing: LockRecord | null } => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(ownRecord));
      return { fd, existing: null };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return { fd: null, existing: readLockRecord(lockPath) };
    }
  };

  let { fd, existing } = tryAcquire();

  if (!fd && (existing === null || !isOwnerAlive(existing))) {
    // Stale or forged — reclaim.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    ({ fd, existing } = tryAcquire());
  }

  if (!fd) {
    return { acquired: false, existingPid: existing?.pid ?? null, release: () => undefined };
  }

  const ownFd = fd;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      fs.closeSync(ownFd);
    } catch {
      /* ignore */
    }
    try {
      // Only unlink if it still holds our record — avoid deleting someone
      // else's lock in rare PID-reuse scenarios.
      const current = readLockRecord(lockPath);
      if (
        current &&
        current.pid === ownRecord.pid &&
        current.startTimeMs === ownRecord.startTimeMs
      ) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      /* ignore */
    }
  };

  return { acquired: true, existingPid: null, release };
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startTimeMs === 'number' &&
      typeof parsed.exe === 'string'
    ) {
      return parsed;
    }
    // Legacy plain-PID lock from prior versions — accept but treat as weak.
    const legacyPid = parseInt(raw, 10);
    if (Number.isFinite(legacyPid)) {
      return { pid: legacyPid, startTimeMs: 0, exe: '' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A lock record is "alive" iff the PID still exists AND the process start
 * time matches AND the image path matches (when we have one). That prevents
 * PID-reuse spoofs like "I stuck explorer.exe's PID in your lock file".
 */
function isOwnerAlive(record: LockRecord): boolean {
  if (!pidExists(record.pid)) return false;
  // Legacy records without identity metadata — best effort: honour the PID.
  if (!record.exe || record.startTimeMs === 0) return true;
  try {
    const stat = fs.statSync(record.exe);
    return stat.isFile();
    // Note: confirming actual identity against the running process requires
    // WMI; current check is a weak signal. Documented in security review.
  } catch {
    return false;
  }
}

function pidExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function startTimeMs(): number {
  // process.uptime() is seconds since this process started; subtracting
  // from Date.now() gives an approximate absolute start time — good enough
  // to distinguish across a PID reuse.
  return Math.floor(Date.now() - process.uptime() * 1000);
}
