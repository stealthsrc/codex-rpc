import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export type ForcedState = 'cli' | 'app' | 'both' | 'idle' | null;

export interface RpcButtonConfig {
  label: string;
  url: string;
}

export type RpcActivityMode = 'playing' | 'watching' | 'listening' | 'competing';

const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = path.join(LOCAL_APP_DATA, 'codex-rich-presence');
const RPC_BUTTONS_PATH = path.join(APP_DATA_DIR, 'rpc-buttons.json');

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

export function rpcButtonsFilePath(): string {
  return RPC_BUTTONS_PATH;
}

export function resolveRpcButtons(
  env: NodeJS.ProcessEnv = process.env,
  filePath: string = RPC_BUTTONS_PATH,
): RpcButtonConfig[] {
  const fileButtons = readRpcButtonsFile(filePath);
  const buttons: RpcButtonConfig[] = [...fileButtons];
  for (const index of [1, 2]) {
    const label = sanitizeButtonLabel(env[`RPC_BUTTON_${index}_LABEL`]);
    const url = sanitizeButtonUrl(env[`RPC_BUTTON_${index}_URL`]);
    if (label && url) buttons[index - 1] = { label, url };
  }
  return buttons.filter(Boolean).slice(0, 2);
}

export function resolveRpcActivityMode(
  env: NodeJS.ProcessEnv = process.env,
  filePath: string = RPC_BUTTONS_PATH,
): RpcActivityMode {
  const envMode = parseRpcActivityMode(env.RPC_ACTIVITY_MODE);
  if (envMode) return envMode;
  return readRpcActivityModeFile(filePath);
}

function parseRpcActivityMode(value: string | undefined): RpcActivityMode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'tv' || v === 'watching') return 'watching';
  if (v === 'playing' || v === 'play') return 'playing';
  if (v === 'listening' || v === 'listen') return 'listening';
  if (v === 'competing' || v === 'compete') return 'competing';
  return null;
}

function readRpcActivityModeFile(filePath: string): RpcActivityMode {
  try {
    const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parseRpcActivityMode(typeof parsed.mode === 'string' ? parsed.mode : undefined) ?? 'playing';
  } catch {
    return 'playing';
  }
}

function readRpcButtonsFile(filePath: string): RpcButtonConfig[] {
  try {
    const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
    const parsed = JSON.parse(raw) as { buttons?: Array<{ label?: unknown; url?: unknown }> };
    if (!Array.isArray(parsed.buttons)) return [];
    return parsed.buttons
      .map((button) => {
        const label = sanitizeButtonLabel(typeof button.label === 'string' ? button.label : undefined);
        const url = sanitizeButtonUrl(typeof button.url === 'string' ? button.url : undefined);
        return label && url ? { label, url } : null;
      })
      .filter((button): button is RpcButtonConfig => Boolean(button))
      .slice(0, 2);
  } catch {
    return [];
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function sanitizeButtonLabel(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > 32 ? cleaned.slice(0, 32) : cleaned;
}

function sanitizeButtonUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
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
  rpcButtons: RpcButtonConfig[];
  rpcActivityMode: RpcActivityMode;
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
    rpcButtons: resolveRpcButtons(),
    rpcActivityMode: resolveRpcActivityMode(),
  };
}
