import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type ForcedState } from './config';
import { Detector, type DetectionResult, type PresenceState } from './detector';
import { formatEffort, formatModel, readCodexConfig } from './detector/codex-config';
import { readLatestCodexSession } from './detector/codex-session';
import { RpcClient } from './rpc/client';
import { buildPresence } from './rpc/presence-builder';
import { runStatus } from './status';
import { startTray } from './tray';
import { getLogger, initLogger } from './utils/logger';
import { acquireSingleInstanceLock } from './utils/single-instance';
import { clearStatus, writeStatus } from './utils/status-file';

async function main(): Promise<void> {
  // --status mode: no RPC, no lock, no env requirements. Prints summary + exits.
  if (process.argv.includes('--status')) {
    await runStatus();
    process.exit(0);
  }

  const noTray = process.argv.includes('--no-tray') || process.platform !== 'win32';

  const cfg = loadConfig();
  initLogger({ level: cfg.logLevel, logFile: cfg.logFile });
  const log = getLogger();

  const lock = acquireSingleInstanceLock();
  if (!lock.acquired) {
    log.error(
      { existingPid: lock.existingPid },
      'another codex-rich-presence instance is already running — exiting',
    );
    process.exit(2);
  }
  log.info(
    {
      scanIntervalMs: cfg.scanIntervalMs,
      idleGraceMs: cfg.idleGraceMs,
      logLevel: cfg.logLevel,
      logFile: cfg.logFile,
      forceState: cfg.forceState,
    },
    'codex-rich-presence starting',
  );

  let rpcFatal = false;
  const rpc = new RpcClient({
    clientId: cfg.discordClientId,
    onFatal: (reason) => {
      rpcFatal = true;
      log.error({ reason }, 'rpc: fatal — exiting with code 3');
      lock.release();
      process.exit(3);
    },
  });
  await rpc.connect();
  if (rpcFatal) return;

  const detector = new Detector({ idleGraceMs: cfg.idleGraceMs });

  let lastState: PresenceState = 'idle';
  let lastStart: number | null = null;
  let lastCodexKey = '';
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    let result: DetectionResult;
    if (cfg.forceState) {
      result = forcedResult(cfg.forceState);
      result.codex = readCodexConfig();
      result.session = result.state === 'idle' ? null : readLatestCodexSession();
    } else {
      try {
        result = await detector.tick();
      } catch (err) {
        log.error({ err: (err as Error).message }, 'detector tick failed');
        return;
      }
    }

    const startMs = result.startedAt?.getTime() ?? null;
    const codexKey =
      `${result.codex?.model ?? ''}|${result.codex?.effort ?? ''}|` +
      `${result.codex?.serviceTier ?? ''}|${result.session?.repoName ?? ''}`;
    if (result.state === lastState && startMs === lastStart && codexKey === lastCodexKey) {
      return;
    }
    log.info(
      {
        state: result.state,
        processCounts: result.processCounts,
        startedAt: result.startedAt?.toISOString() ?? null,
        codex: result.codex,
      },
      'state: transition',
    );
    lastState = result.state;
    lastStart = startMs;
    lastCodexKey = codexKey;

    const payload = buildPresence(result);
    if (payload) {
      rpc.setActivity(payload);
    } else {
      rpc.clearActivity();
    }

    writeStatus(formatStatusLine(result, rpc.isReady()));
  };

  await runOnce();
  const interval = setInterval(() => {
    if (stopped) return;
    void runOnce();
  }, cfg.scanIntervalMs);

  let tray: ReturnType<typeof startTray> | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    log.info({ signal }, 'shutting down');
    try {
      await rpc.destroy();
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'rpc destroy error (ignored)');
    }
    tray?.stop();
    clearStatus();
    lock.release();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  if (!noTray) {
    tray = startTray({
      iconPath: resolveTrayIcon(),
      startupCommand: resolveStartupCommand(),
      onQuit: () => void shutdown('tray-quit'),
    });
  }
}

/**
 * Command string written into HKCU Run when "Start with Windows" is enabled.
 * Packaged → just the EXE path. Dev → node.exe + dist/index.js.
 */
function resolveStartupCommand(): string {
  const exe = process.execPath;
  const isPackaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
  if (isPackaged) return `"${exe}"`;
  const entry = path.resolve(__dirname, 'index.js');
  return `"${exe}" "${entry}"`;
}

/**
 * Pipe-separated tray status line:
 *   "{Codex state}|{Model · Effort}|{Discord state}"
 * The trailing field is optional for older tray scripts — appended last so
 * unaware readers can still parse the first two.
 */
function formatStatusLine(result: DetectionResult, rpcReady: boolean): string {
  const stateLabel =
    result.state === 'both'
      ? 'Codex: CLI/Desktop'
      : result.state === 'cli'
        ? 'Codex: CLI'
        : result.state === 'app'
          ? 'Codex: Desktop'
          : 'Codex: Off';
  const model = formatModel(result.codex?.model ?? null);
  const effort = formatEffort(result.codex?.effort ?? null);
  const modelLine = [model, effort].filter((p): p is string => Boolean(p)).join(' · ');
  const discordLine = rpcReady ? 'Discord: Connected' : 'Discord: RPC Disabled';
  return `${stateLabel}|${modelLine}|${discordLine}`;
}

function resolveTrayIcon(): string | undefined {
  // When bundled by pkg, the asset lives inside the virtual snapshot FS
  // (`/snapshot/.../assets/app.ico`). PowerShell can't read that path, so we
  // extract it once to %LOCALAPPDATA% and hand PowerShell the real path.
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const extractedPath = path.join(localAppData, 'codex-rich-presence', 'tray.ico');

  const embedded = path.resolve(__dirname, '..', 'assets', 'app.ico');
  const candidates = [
    embedded,
    path.join(path.dirname(process.execPath), 'app.ico'),
    path.join(path.dirname(process.execPath), 'codex.ico'),
    path.resolve(__dirname, '..', 'codex.ico'),
  ];

  for (const candidate of candidates) {
    try {
      const data = fs.readFileSync(candidate);
      fs.mkdirSync(path.dirname(extractedPath), { recursive: true });
      fs.writeFileSync(extractedPath, data);
      return extractedPath;
    } catch {
      continue;
    }
  }
  return undefined;
}

function forcedResult(forced: Exclude<ForcedState, null>): DetectionResult {
  if (forced === 'idle') {
    return {
      state: 'idle',
      startedAt: null,
      processCounts: { cli: 0, app: 0, unknown: 0 },
      codex: null,
      session: null,
    };
  }
  const now = new Date();
  const counts = {
    cli: forced === 'cli' || forced === 'both' ? 1 : 0,
    app: forced === 'app' || forced === 'both' ? 1 : 0,
    unknown: 0,
  };
  return { state: forced, startedAt: now, processCounts: counts, codex: null, session: null };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
