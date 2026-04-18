import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

export type ForcedState = 'cli' | 'app' | 'both' | 'idle' | null;

function parseInt10(value: string | undefined, fallback: number, min: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

function expandEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '');
}

/**
 * Log files must live under %LOCALAPPDATA%\codex-rich-presence\logs so an
 * attacker-controlled `LOG_FILE` env var can't redirect writes to UNC shares,
 * device paths (\\.\pipe\, \\?\), or system locations.
 */
export function resolveLogFile(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const expanded = expandEnvVars(raw.trim());

  // Reject anything that isn't a plain local absolute path.
  if (/^\\\\/.test(expanded)) return null; // UNC or \\.\ / \\?\ device paths
  if (/^[a-z]+:[/\\]{2}/i.test(expanded)) return null; // URI-ish scheme

  const normalized = path.normalize(expanded);
  if (!path.isAbsolute(normalized)) return null;

  const logRoot = path.normalize(
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'codex-rich-presence',
      'logs',
    ),
  );
  const rel = path.relative(logRoot, normalized);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  return normalized;
}

function parseForcedState(value: string | undefined): ForcedState {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  if (v === 'cli' || v === 'app' || v === 'both' || v === 'idle') return v;
  return null;
}

/**
 * Default Discord Application ID shipped with this build.
 * Application IDs are public identifiers, not secrets — every Rich Presence
 * payload sent to a Discord client already contains it.
 * Override at runtime with the DISCORD_CLIENT_ID env var for development.
 */
export const DEFAULT_DISCORD_CLIENT_ID = '1494452015504293908';

export interface AppConfig {
  discordClientId: string;
  scanIntervalMs: number;
  idleGraceMs: number;
  logLevel: string;
  logFile: string | null;
  forceState: ForcedState;
}

export function loadConfig(): AppConfig {
  const discordClientId =
    process.env.DISCORD_CLIENT_ID?.trim() || DEFAULT_DISCORD_CLIENT_ID;

  const logFile = resolveLogFile(process.env.LOG_FILE);

  return {
    discordClientId,
    scanIntervalMs: parseInt10(process.env.SCAN_INTERVAL_MS, 5000, 2000),
    idleGraceMs: parseInt10(process.env.IDLE_GRACE_MS, 10_000, 0),
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    logFile,
    forceState: parseForcedState(process.env.FORCE_STATE),
  };
}
