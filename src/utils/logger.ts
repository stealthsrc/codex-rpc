import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

let rootLogger: Logger | null = null;

export interface LoggerOptions {
  level: string;
  logFile: string | null;
}

export function initLogger(options: LoggerOptions): Logger {
  const streams: pino.StreamEntry[] = [];

  // Only attach stdout when we actually have a console. Otherwise pino-pretty
  // workers attempt to write to a closed handle and crash the process —
  // this happens when the EXE is built as Windows GUI subsystem (tray mode).
  if (hasUsableStdout()) {
    streams.push({
      level: options.level as pino.Level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      }),
    });
  }

  if (options.logFile) {
    try {
      fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
      streams.push({
        level: options.level as pino.Level,
        stream: pino.destination({ dest: options.logFile, mkdir: true, sync: false }),
      });
    } catch (err) {
      // Silent fallback to stdout. The file logger is a nice-to-have, not a
      // hard requirement — startup must not crash on a bad LOG_FILE path.
      process.stderr.write(
        `logger: unable to open log file '${options.logFile}' (${(err as Error).message}); falling back to stdout.\n`,
      );
    }
  }

  rootLogger = pino(
    { level: options.level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams),
  );
  return rootLogger;
}

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: 'info' });
  }
  return rootLogger;
}

/**
 * A "usable" stdout is one attached to a console/pipe where writes won't
 * fault. Under Windows GUI subsystem, process.stdout has no valid handle
 * (fd -1) and pino-pretty crashes on write.
 */
function hasUsableStdout(): boolean {
  const stdout = process.stdout as NodeJS.WriteStream & { fd?: number };
  if (!stdout || typeof stdout.write !== 'function') return false;
  if (typeof stdout.fd === 'number' && stdout.fd < 0) return false;
  return true;
}
