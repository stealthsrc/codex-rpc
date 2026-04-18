<p align="center">
  <img src="assets/codex_logo.png" width="160" alt="Codex Rich Presence logo"/>
</p>

<h1 align="center">Codex Rich Presence</h1>

<p align="center">
  Discord Rich Presence for the OpenAI Codex ecosystem on Windows —
  detects the <strong>Codex CLI</strong>, the <strong>Codex desktop app</strong>,
  and reads your active model + reasoning effort from <code>~/.codex/config.toml</code>.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a>
</p>

---

## Features

- **Detects both Codex surfaces at once.** CLI and desktop app both ship as `codex.exe`; this tool disambiguates them via executable path and parent process so your activity reads `Coding with Codex CLI`, `Using Codex`, or `Coding with Codex (CLI + Desktop)`.
- **Live model + effort.** Reads `model`, `model_reasoning_effort`, and `service_tier` from your Codex config so Discord shows, e.g., `GPT-5.4 · Extra High`.
- **Repo awareness.** Pulls the CWD of your most recent Codex session (rollout JSONL) and appends the repo name to the presence.
- **System tray.** Hidden-window tray icon with live state, model, and a `Start with Windows` toggle. No console spam.
- **Single instance, safely.** File-lock with PID + start-time identity so a forged lock can't DoS the daemon.
- **Hardened.** `LOG_FILE` allowlisted to `%LOCALAPPDATA%`, PowerShell spawned via absolute `System32` path, output capped at 2 MB, RPC has a circuit breaker on auth failures.
- **Self-contained EXE.** Single 65 MB Windows binary (Node 22 embedded) — no runtime install required for end users.

## Install

### Option A — prebuilt EXE (recommended)

1. Download `codex-rich-presence.exe` from the [Releases](../../releases) page.
2. Double-click. That's it — a Codex icon appears in the system tray.
3. *(Optional)* Right-click the tray icon → **Start with Windows** so it launches at logon.

### Option B — from source

```bash
git clone https://github.com/StealthyLabsHQ/codex-rpc.git
cd codex-rpc
npm install
npm run build
npm start
```

Requires Node.js 22+. The Discord Application ID is bundled (public identifier — override with `DISCORD_CLIENT_ID` env var if you've forked and run your own app).

## Usage

### Tray mode (default)

Just launch the EXE. The tray icon shows:

```
Codex Rich Presence
Codex: CLI/Desktop
GPT-5.4 · Extra High
──────────────
☐ Start with Windows
──────────────
Quit
```

### CLI

```bash
# Minimal status check — prints two lines then exits.
codex-rich-presence.exe --status
# →  Codex: Desktop
# →  GPT-5.3-Codex · Extra High

# Run the daemon without a tray (logs to stdout).
codex-rich-presence.exe --no-tray
```

### Environment overrides

All optional. Drop them in `.env` or set them in the shell.

| Variable             | Default                                                    | Description |
|----------------------|------------------------------------------------------------|-------------|
| `DISCORD_CLIENT_ID`  | *(bundled)*                                                | Override the shipped Discord Application ID. |
| `SCAN_INTERVAL_MS`   | `5000`                                                     | How often to poll for `codex.exe`. Minimum `2000`. |
| `IDLE_GRACE_MS`      | `10000`                                                    | Hold the last non-idle state for this long when Codex disappears, to avoid flicker. |
| `LOG_LEVEL`          | `info`                                                     | `trace` / `debug` / `info` / `warn` / `error`. |
| `LOG_FILE`           | *(stdout only)*                                            | Must resolve under `%LOCALAPPDATA%\codex-rich-presence\logs\` (rejected otherwise). |
| `FORCE_STATE`        | *(unset)*                                                  | `cli` / `app` / `both` / `idle` — skip detection, useful for testing. |

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  codex-rich-presence.exe  (Windows GUI subsystem, no console)     │
│                                                                    │
│  ┌─────────────┐   5 s    ┌────────────┐      ┌─────────────┐     │
│  │ Process     │─────────▶│ Classifier │─────▶│  Detector   │     │
│  │ scanner     │  WMI     │  (4 rules) │      │  state mach │     │
│  │ (PowerShell)│          └────────────┘      └──────┬──────┘     │
│  └─────────────┘                                     │            │
│                                                      ▼            │
│  ~/.codex/config.toml ──▶  model / effort      ┌───────────┐      │
│  ~/.codex/sessions/*  ──▶  cwd (repo name)     │ Presence  │      │
│                                                 │ builder   │      │
│                                                 └─────┬─────┘      │
│                                                       ▼            │
│                                         ┌──────────────────┐       │
│                                         │  Discord RPC     │       │
│                                         │ @xhayper client  │       │
│                                         └──────────────────┘       │
│                                                                    │
│  Status file ────▶  ┌──────────────────────────────────────────┐  │
│                     │ Tray (hidden PowerShell NotifyIcon)       │  │
│                     │  • state + model                          │  │
│                     │  • Start with Windows toggle              │  │
│                     │  • Quit                                   │  │
│                     └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### CLI vs desktop disambiguation

Four rules, applied in order:

1. **Canonical CLI path** — matches `\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\...\codex.exe`.
2. **Any `@openai\codex` install path** — pnpm / yarn / bun / monorepo variants.
3. **Parent is a shell / IDE terminal** — `cmd.exe`, `pwsh.exe`, `wt.exe`, `Code.exe`, `cursor.exe`, Alacritty, Hyper, ConEmu…
4. **Fallback: desktop app.** Anything that didn't match 1–3 is treated as `codex.exe` from the desktop installer (typically `%LocalAppData%\Programs\Codex\codex.exe`).

Unclassified processes are logged but never surfaced to Discord.

## Development

```bash
npm install
npm run build           # tsc → dist/
npm test                # vitest — 60+ unit tests
npm start               # node dist/index.js (tray mode)
npm run dist            # pkg + icon + version stamp → bin/codex-rich-presence.exe
```

### Build pipeline

`npm run dist` does three non-obvious things in sequence:

1. **rcedit-stamps the cached Node binary** (`~/.pkg-cache/v3.5/fetched-v22.22.2-win-x64`) with the icon, `ProductName`, `FileVersion`, copyright.
2. **Patches `expected-shas.json`** in `@yao-pkg/pkg-fetch` so the hash check passes against the stamped binary (restored on exit — no pollution).
3. **Flips the PE Subsystem byte** from `3` (Console) to `2` (Windows GUI) so double-clicking the EXE doesn't pop a console window.

See [`scripts/build-exe.js`](scripts/build-exe.js) for the full flow.

### Tests

Unit tests cover the classifier, state machine, TOML parser, presence builder (including sanitation), session rollout reader, single-instance lock, and config loader. Run `npm test` or `npm run test:watch`.

## Security notes

A security audit (`docs/security-audit.md` if included) informed:

- `LOG_FILE` allowlist (rejects UNC, `\\.\pipe\`, `\\?\`, traversal).
- Absolute PowerShell path + reduced environment for the scanner.
- 2 MB stdout cap on PowerShell output with kill-on-overflow.
- Lock file with `{pid, startTimeMs, exe}` identity (defeats PID spoof DoS).
- Circuit breaker: 10 consecutive Discord RPC login failures → process exits.
- Sanitation of model/effort/repo before they hit Discord (strip controls, bidi overrides, zero-width, NFC, length caps).
- CI actions pinned to commit SHAs.

## License

MIT © StealthyLabs
