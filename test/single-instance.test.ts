import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireSingleInstanceLock } from '../src/utils/single-instance';

const APP_NAME = `codex-rich-presence-test-${process.pid}-${Date.now()}`;

function lockDir(): string {
  return path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    APP_NAME,
  );
}

describe('acquireSingleInstanceLock', () => {
  beforeEach(() => {
    try {
      fs.rmSync(lockDir(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  afterEach(() => {
    try {
      fs.rmSync(lockDir(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('first call acquires, second is blocked by our PID', () => {
    const a = acquireSingleInstanceLock(APP_NAME);
    expect(a.acquired).toBe(true);

    const b = acquireSingleInstanceLock(APP_NAME);
    expect(b.acquired).toBe(false);
    expect(b.existingPid).toBe(process.pid);

    a.release();
  });

  it('reclaims a stale lock whose owner PID is dead', () => {
    fs.mkdirSync(lockDir(), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), 'instance.lock'), '999999999');

    const a = acquireSingleInstanceLock(APP_NAME);
    expect(a.acquired).toBe(true);
    a.release();
  });

  it('release removes the lock file', () => {
    const a = acquireSingleInstanceLock(APP_NAME);
    expect(a.acquired).toBe(true);
    a.release();
    expect(fs.existsSync(path.join(lockDir(), 'instance.lock'))).toBe(false);
  });
});
