# Changelog

All notable changes to Codex RPC are documented here.

## [0.3.9] - 2026-05-01

### Fixed

- Model and reasoning effort now sync from the latest Codex turn context instead of stale top-level config.

## [0.3.8] - 2026-05-01

### Fixed

- Usage limits now show 100% after their reset time even before Codex writes a fresh rate-limit snapshot.

## [0.3.7] - 2026-04-29

### Fixed

- Tauri desktop daemon now uses the same multi-rollout usage selection as the CLI daemon.

## [0.3.6] - 2026-04-29

### Fixed

- Discord RPC now refreshes when usage percentages change.
- Usage display now prefers global Codex limits over model-specific Spark limits.

## [0.3.5] - 2026-04-29

### Fixed

- Usage limits now fall back across recent Codex rollout logs when the newest CLI/Desktop session has no rate-limit snapshot.

## [0.3.4] - 2026-04-27

### Added

- macOS Tauri build with `.app`, `.dmg`, and portable arm64 binary artifacts.
- macOS Codex process detection for CLI and desktop activity.
- macOS Discord RPC IPC support through Unix `discord-ipc-*` sockets.
- macOS start-at-login support through a LaunchAgent.

### Changed

- Settings and status files now use `~/Library/Application Support/codex-rich-presence` on macOS.
- Build scripts now export platform-specific Tauri binaries and validate the signed macOS app bundle.

## [0.3.3] - 2026-04-27

### Added

- Start on Windows toggle in the tray menu.

## [0.3.2] - 2026-04-26

### Changed

- Refreshed settings UI with glass panels, softer backgrounds, and stronger focus states.

## [0.3.1] - 2026-04-26

### Added

- Native Windows process scanner in the integrated Tauri daemon.
- Live autosave for settings.
- Local Discord RPC preview with Codex logo.
- Preview of Discord buttons in Watching mode.
- Separate 5h and weekly usage visibility toggles.
- Tray quick toggles for all RPC modes.
- Tray quick toggles for 5h/week usage visibility.
- Resizable settings window.
- Neutral dark/light UI palette.

### Changed

- Settings and RPC refresh every 500ms.
- Process scanning remains at 5s by default.
- Settings window now uses a calmer grey-first palette, keeping blue for active and primary controls.

### Removed

- PowerShell/CIM process polling from the Tauri daemon.

### Validation

- `npm run build`
- `npm test` - 76 passed
- `npm audit --json` - 0 vulnerabilities
- `cargo check`
- `npm run tauri:build`
- Runtime smoke test: no `codex-rpc-daemon.exe` sidecar.

## [0.3.0] - 2026-04-26

### Changed

- Integrated the RPC daemon into the Tauri process.
- Removed the daemon sidecar from the shipped Tauri app.
- Kept Discord RPC, status file, and tray behavior inside one main app process.

## [0.2.1] - 2026-04-26

### Changed

- Updated app metadata and process description to `Codex RPC`.

## [0.2.0] - 2026-04-26

### Added

- Tauri settings window.
- Discord RPC button configuration.
- RPC mode selection.
- Usage visibility controls.
- Dark, System, and Light themes.
- NSIS installer artifact.

## [0.1.2] - 2026-04-26

### Fixed

- Tray state now reflects Discord disconnects within one tick.

## [0.1.1] - 2026-04-26

### Added

- Discord RPC connection state in tray/status output.

## [0.1.0] - 2026-04-26

### Added

- Initial public release.
- Codex process detection.
- Discord Rich Presence updates.
- Windows executable packaging.
