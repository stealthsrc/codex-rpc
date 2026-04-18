import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexConfig {
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
}

const DEFAULT_PATH = path.join(os.homedir(), '.codex', 'config.toml');

/**
 * Minimal TOML extractor — we only care about three top-level string keys.
 * Running a full parser isn't worth the dep: the file can contain arbitrary
 * nested tables we explicitly don't want to touch.
 */
export function parseCodexConfig(tomlContent: string): CodexConfig {
  return {
    model: extractTopLevelString(tomlContent, 'model'),
    effort: extractTopLevelString(tomlContent, 'model_reasoning_effort'),
    serviceTier: extractTopLevelString(tomlContent, 'service_tier'),
  };
}

export function readCodexConfig(configPath: string = DEFAULT_PATH): CodexConfig | null {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return parseCodexConfig(raw);
  } catch {
    return null;
  }
}

/**
 * Extracts `key = "value"` or `key = 'value'` that appears at the top of the file,
 * before any `[section]` header. Ignores matches inside nested tables.
 */
function extractTopLevelString(toml: string, key: string): string | null {
  const lines = toml.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*$`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break; // reached first [section] — stop.
    const match = line.match(keyPattern);
    if (!match) continue;
    const value = match[1].trim();
    const quoted = value.match(/^"((?:[^"\\]|\\.)*)"$/) ?? value.match(/^'([^']*)'$/);
    if (quoted) return quoted[1];
    return value;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalize CLI-style shorthand to user-facing label (mirrors Codex app UI). */
export function formatEffort(effort: string | null): string | null {
  if (!effort) return null;
  const map: Record<string, string> = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    'extra-high': 'Extra High',
  };
  return map[effort.toLowerCase()] ?? effort;
}

/** e.g. `gpt-5.4` → `GPT-5.4`, `gpt-5.3-codex` → `GPT-5.3-Codex`. */
export function formatModel(model: string | null): string | null {
  if (!model) return null;
  return model
    .split('-')
    .map((segment, i) => {
      if (segment.length === 0) return segment;
      if (i === 0 && /^[a-z]+$/.test(segment)) return segment.toUpperCase();
      if (/^[a-z]/.test(segment)) return segment.charAt(0).toUpperCase() + segment.slice(1);
      return segment;
    })
    .join('-');
}
