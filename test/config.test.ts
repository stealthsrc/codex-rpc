import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveLogFile,
  resolveRpcActivityMode,
  resolveRpcButtons,
} from '../src/config';

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

describe('resolveRpcButtons', () => {
  const missingFile = path.join(os.tmpdir(), `rpc-buttons-missing-${process.pid}.json`);

  it('accepts up to two http(s) button pairs', () => {
    expect(
      resolveRpcButtons({
        RPC_BUTTON_1_LABEL: 'Open Codex',
        RPC_BUTTON_1_URL: 'https://chatgpt.com/codex',
        RPC_BUTTON_2_LABEL: 'Usage',
        RPC_BUTTON_2_URL: 'https://chatgpt.com/codex/settings/analytics',
      }, missingFile),
    ).toEqual([
      { label: 'Open Codex', url: 'https://chatgpt.com/codex' },
      { label: 'Usage', url: 'https://chatgpt.com/codex/settings/analytics' },
    ]);
  });

  it('drops incomplete or non-http button pairs', () => {
    expect(
      resolveRpcButtons({
        RPC_BUTTON_1_LABEL: 'Local',
        RPC_BUTTON_1_URL: 'file:///C:/tmp',
        RPC_BUTTON_2_LABEL: 'Missing URL',
      }, missingFile),
    ).toEqual([]);
  });

  it('loads persisted button pairs', () => {
    const file = path.join(os.tmpdir(), `rpc-buttons-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ buttons: [{ label: 'Open Codex', url: 'https://chatgpt.com/codex' }] }),
    );
    try {
      expect(resolveRpcButtons({}, file)).toEqual([
        { label: 'Open Codex', url: 'https://chatgpt.com/codex' },
      ]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('loads persisted button pairs with UTF-8 BOM', () => {
    const file = path.join(os.tmpdir(), `rpc-buttons-bom-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      '\ufeff' + JSON.stringify({ mode: 'watching', buttons: [{ label: 'Usage', url: 'https://chatgpt.com/codex/settings/analytics' }] }),
    );
    try {
      expect(resolveRpcActivityMode({}, file)).toBe('watching');
      expect(resolveRpcButtons({}, file)).toEqual([
        { label: 'Usage', url: 'https://chatgpt.com/codex/settings/analytics' },
      ]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('loads persisted RPC activity mode', () => {
    const file = path.join(os.tmpdir(), `rpc-mode-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ mode: 'watching', buttons: [] }));
    try {
      expect(resolveRpcActivityMode({}, file)).toBe('watching');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('lets env override persisted RPC activity mode', () => {
    const file = path.join(os.tmpdir(), `rpc-mode-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ mode: 'watching', buttons: [] }));
    try {
      expect(resolveRpcActivityMode({ RPC_ACTIVITY_MODE: 'playing' }, file)).toBe('playing');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('accepts listening and competing RPC activity modes', () => {
    expect(resolveRpcActivityMode({ RPC_ACTIVITY_MODE: 'listening' }, missingFile)).toBe('listening');
    expect(resolveRpcActivityMode({ RPC_ACTIVITY_MODE: 'competing' }, missingFile)).toBe('competing');
  });
});
