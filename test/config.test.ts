import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLogFile } from '../src/config';

describe('resolveLogFile', () => {
  const LOGS_ROOT = path.normalize(
    path.join(
      process.env.LOCALAPPDATA ?? 'C:\\Users\\stub\\AppData\\Local',
      'codex-rich-presence',
      'logs',
    ),
  );

  it('accepts a path inside the logs directory', () => {
    const accepted = path.join(LOGS_ROOT, 'app.log');
    expect(resolveLogFile(accepted)).toBe(accepted);
  });

  it('rejects UNC paths', () => {
    expect(resolveLogFile('\\\\attacker\\share\\app.log')).toBeNull();
  });

  it('rejects device namespace (\\\\.\\)', () => {
    expect(resolveLogFile('\\\\.\\pipe\\codex-hang')).toBeNull();
  });

  it('rejects long-path prefix (\\\\?\\)', () => {
    expect(resolveLogFile('\\\\?\\C:\\Windows\\System32\\app.log')).toBeNull();
  });

  it('rejects traversal out of logs directory', () => {
    expect(resolveLogFile(path.join(LOGS_ROOT, '..', '..', 'evil.log'))).toBeNull();
  });

  it('rejects relative paths', () => {
    expect(resolveLogFile('app.log')).toBeNull();
  });

  it('returns null on empty / undefined', () => {
    expect(resolveLogFile(undefined)).toBeNull();
    expect(resolveLogFile('')).toBeNull();
    expect(resolveLogFile('   ')).toBeNull();
  });

  it('expands %LOCALAPPDATA%', () => {
    const raw = '%LOCALAPPDATA%\\codex-rich-presence\\logs\\app.log';
    const resolved = resolveLogFile(raw);
    expect(resolved).toBe(path.join(LOGS_ROOT, 'app.log'));
  });
});
