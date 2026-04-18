import { formatEffort, formatModel } from '../detector/codex-config';
import type { DetectionResult, PresenceState } from '../detector/state';

/**
 * `config.toml` and session rollouts are user-local but still considered
 * lower-trust. Before any string lands in Discord we strip control chars,
 * normalize Unicode, and cap length to prevent UX abuse (homoglyph spoofing,
 * RTL overrides, overly long banners).
 */
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const MAX_FIELD_LENGTH = 48;

function sanitizeField(raw: string | null | undefined, maxLen = MAX_FIELD_LENGTH): string | null {
  if (!raw) return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(CONTROL_CHAR_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + '…' : cleaned;
}

export interface PresencePayload {
  details: string;
  state: string;
  startTimestamp?: number;
  largeImageKey: string;
  largeImageText: string;
  instance?: boolean;
}

const LARGE_IMAGE_KEY = 'codex_logo';
const LARGE_IMAGE_TEXT = 'OpenAI Codex';

const FALLBACK_STATE: Record<Exclude<PresenceState, 'idle'>, string> = {
  cli: 'Terminal session active',
  app: 'Desktop session',
  both: 'CLI + Desktop',
};

const DETAILS: Record<Exclude<PresenceState, 'idle'>, string> = {
  cli: 'Coding with Codex CLI',
  app: 'Using Codex',
  both: 'Coding with Codex (CLI + Desktop)',
};

// Discord's `details` field caps around 128 chars; repo names beyond this read poorly.
const MAX_DETAILS_LENGTH = 96;

export function buildPresence(result: DetectionResult): PresencePayload | null {
  if (result.state === 'idle') return null;
  const payload: PresencePayload = {
    details: buildDetails(result),
    state: buildStateLine(result),
    largeImageKey: LARGE_IMAGE_KEY,
    largeImageText: LARGE_IMAGE_TEXT,
    instance: false,
  };
  if (result.startedAt) {
    payload.startTimestamp = Math.floor(result.startedAt.getTime() / 1000);
  }
  return payload;
}

function buildDetails(result: DetectionResult): string {
  if (result.state === 'idle') return '';
  const base = DETAILS[result.state];
  const repo = sanitizeField(result.session?.repoName, 32);
  if (!repo) return base;
  const suffix = ` · ${repo}`;
  if (base.length + suffix.length <= MAX_DETAILS_LENGTH) return base + suffix;
  return base;
}

function buildStateLine(result: DetectionResult): string {
  if (result.state === 'idle') return '';
  const model = sanitizeField(formatModel(result.codex?.model ?? null), 24);
  const effort = sanitizeField(formatEffort(result.codex?.effort ?? null), 16);
  const parts: string[] = [];
  if (model) parts.push(model);
  if (effort) parts.push(effort);
  if (parts.length === 0) return FALLBACK_STATE[result.state];
  return parts.join(' · ');
}
