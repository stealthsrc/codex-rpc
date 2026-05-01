use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(windows)]
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    },
};

const DEFAULT_DISCORD_CLIENT_ID: &str = "1494452015504293908";
const SCAN_INTERVAL_MS: u64 = 5000;
const UI_REFRESH_INTERVAL_MS: u64 = 500;
const RPC_REFRESH_INTERVAL_MS: u64 = 15_000;
const IDLE_GRACE_MS: u64 = 10_000;
const ACTIVITY_PLAYING: u8 = 0;
const ACTIVITY_LISTENING: u8 = 2;
const ACTIVITY_WATCHING: u8 = 3;
const ACTIVITY_COMPETING: u8 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RpcButton {
    label: String,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RpcSettings {
    mode: String,
    buttons: Vec<RpcButton>,
    #[serde(default, skip_serializing)]
    show_usage: Option<bool>,
    #[serde(default = "default_show_usage")]
    show_primary_usage: bool,
    #[serde(default = "default_show_usage")]
    show_weekly_usage: bool,
}

impl Default for RpcSettings {
    fn default() -> Self {
        Self {
            mode: "playing".into(),
            buttons: vec![
                RpcButton {
                    label: "Open Codex".into(),
                    url: "https://chatgpt.com/codex".into(),
                },
                RpcButton {
                    label: "Usage".into(),
                    url: "https://chatgpt.com/codex/settings/analytics".into(),
                },
            ],
            show_usage: None,
            show_primary_usage: true,
            show_weekly_usage: true,
        }
    }
}

fn default_show_usage() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PresenceState {
    Idle,
    Cli,
    App,
    Both,
}

#[derive(Debug, Clone, Default)]
struct ProcessCounts {
    cli: usize,
    app: usize,
    unknown: usize,
}

#[derive(Debug, Clone)]
struct DetectionResult {
    state: PresenceState,
    started_at_ms: Option<u64>,
    codex: Option<CodexConfig>,
    session: Option<CodexSession>,
    usage: Option<CodexUsage>,
}

impl Default for DetectionResult {
    fn default() -> Self {
        Self {
            state: PresenceState::Idle,
            started_at_ms: None,
            codex: None,
            session: None,
            usage: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct CodexConfig {
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexSession {
    repo_name: String,
}

#[derive(Debug, Clone)]
struct LimitSnapshot {
    used_percent: f64,
    resets_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct CodexUsage {
    limit_id: Option<String>,
    primary: Option<LimitSnapshot>,
    secondary: Option<LimitSnapshot>,
    credits_remaining: Option<f64>,
}

#[derive(Debug, Clone)]
struct ProcessSnapshot {
    parent_name: Option<String>,
    executable_path: Option<String>,
    creation_date_ms: Option<u64>,
}

#[cfg(windows)]
struct ProcessEntry {
    process_id: u32,
    parent_process_id: u32,
    name: String,
}

#[derive(Default)]
struct StateMachine {
    last_non_idle: Option<DetectionResult>,
    last_non_idle_at_ms: u64,
    last_emitted: DetectionResult,
    anchor_start_ms: Option<u64>,
}

pub fn run(stop: Arc<AtomicBool>, settings_path: Option<PathBuf>, status_path: Option<PathBuf>) {
    let settings_path = settings_path.unwrap_or_else(|| app_data_dir().join("rpc-buttons.json"));
    let status_path = status_path.unwrap_or_else(|| app_data_dir().join("status.txt"));
    let client_id = std::env::var("DISCORD_CLIENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DISCORD_CLIENT_ID.to_string());
    let scan_interval_ms = parse_env_u64("SCAN_INTERVAL_MS", SCAN_INTERVAL_MS, 2000);
    let idle_grace_ms = parse_env_u64("IDLE_GRACE_MS", IDLE_GRACE_MS, 0);

    let mut machine = StateMachine::default();
    let mut ipc: Option<DiscordIpc> = None;
    let mut last_key = String::new();
    let mut last_rpc_refresh_at = 0;
    let mut settings_modified = modified_ms(&settings_path);
    let mut settings = read_rpc_settings(&settings_path);
    let mut result = detect(&mut machine, idle_grace_ms);
    let mut last_scan_at = now_ms();

    while !stop.load(Ordering::SeqCst) {
        if modified_ms(&settings_path) != settings_modified {
            settings_modified = modified_ms(&settings_path);
            settings = read_rpc_settings(&settings_path);
            last_key.clear();
        }

        if ipc.is_none() {
            ipc = DiscordIpc::connect(&client_id).ok();
            if ipc.is_some() {
                last_key.clear();
            }
        }

        let now = now_ms();
        if now.saturating_sub(last_scan_at) >= scan_interval_ms {
            result = detect(&mut machine, idle_grace_ms);
            last_scan_at = now;
        }

        let mut display_result = result.clone();
        filter_usage(&mut display_result, &settings);
        write_status(
            &status_path,
            &format_status_line(
                &display_result,
                ipc.as_ref().and_then(|client| client.username.as_deref()),
            ),
        );

        let key = presence_key(&display_result, &settings);
        let should_refresh_rpc = now.saturating_sub(last_rpc_refresh_at) >= RPC_REFRESH_INTERVAL_MS;
        if key != last_key || should_refresh_rpc {
            if let Some(client) = ipc.as_mut() {
                let sent = match build_activity(&display_result, &settings) {
                    Some(activity) => client.set_activity(activity),
                    None => client.clear_activity(),
                };

                if sent.is_ok() {
                    last_key = key;
                    last_rpc_refresh_at = now;
                } else {
                    ipc = None;
                    last_key.clear();
                    last_rpc_refresh_at = 0;
                }
            }
        }

        sleep_polling(&stop, UI_REFRESH_INTERVAL_MS);
    }

    if let Some(client) = ipc.as_mut() {
        let _ = client.clear_activity();
    }
    clear_status(&status_path);
}

fn detect(machine: &mut StateMachine, idle_grace_ms: u64) -> DetectionResult {
    let mut counts = ProcessCounts::default();
    let mut oldest: Option<u64> = None;

    for process in scan_codex_processes() {
        match classify_process(&process) {
            PresenceState::Cli => {
                counts.cli += 1;
                oldest = min_option(oldest, process.creation_date_ms);
            }
            PresenceState::App => {
                counts.app += 1;
                oldest = min_option(oldest, process.creation_date_ms);
            }
            PresenceState::Idle => counts.unknown += 1,
            PresenceState::Both => {}
        }
    }

    let state = if counts.cli > 0 && counts.app > 0 {
        PresenceState::Both
    } else if counts.cli > 0 {
        PresenceState::Cli
    } else if counts.app > 0 {
        PresenceState::App
    } else {
        PresenceState::Idle
    };

    let mut result = DetectionResult {
        state,
        started_at_ms: oldest,
        codex: read_codex_config(),
        session: None,
        usage: read_codex_usage(),
    };
    if result.state != PresenceState::Idle {
        result.session = read_codex_session();
    }
    machine.step(result, idle_grace_ms)
}

impl StateMachine {
    fn step(&mut self, result: DetectionResult, idle_grace_ms: u64) -> DetectionResult {
        let now = now_ms();
        if result.state != PresenceState::Idle {
            if self.anchor_start_ms.is_none() || self.last_emitted.state == PresenceState::Idle {
                self.anchor_start_ms = result.started_at_ms;
            } else {
                self.anchor_start_ms = min_option(self.anchor_start_ms, result.started_at_ms);
            }

            let mut merged = result;
            merged.started_at_ms = self.anchor_start_ms;
            self.last_non_idle = Some(merged.clone());
            self.last_non_idle_at_ms = now;
            self.last_emitted = merged.clone();
            return merged;
        }

        if let Some(last) = &self.last_non_idle {
            if now.saturating_sub(self.last_non_idle_at_ms) < idle_grace_ms {
                return last.clone();
            }
        }

        self.last_non_idle = None;
        self.anchor_start_ms = None;
        self.last_emitted = result.clone();
        result
    }
}

fn classify_process(process: &ProcessSnapshot) -> PresenceState {
    let exe = process
        .executable_path
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let exe_unix = exe.replace('\\', "/");
    let parent = process
        .parent_name
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let parent_name = command_basename(&parent);

    if exe.contains("\\node_modules\\@openai\\codex\\")
        || exe_unix.contains("/node_modules/@openai/codex/")
    {
        return PresenceState::Cli;
    }

    let shell_parent = matches!(
        parent_name.as_str(),
        "cmd.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "windowsterminal.exe"
            | "wt.exe"
            | "bash.exe"
            | "code.exe"
            | "cursor.exe"
            | "conemu.exe"
            | "conemu64.exe"
            | "conemuc.exe"
            | "conemuc64.exe"
            | "alacritty.exe"
            | "tabby.exe"
            | "fluent-terminal.exe"
            | "hyper.exe"
            | "zsh"
            | "bash"
            | "sh"
            | "fish"
            | "nu"
            | "terminal"
            | "iterm2"
            | "warp"
            | "ghostty"
            | "alacritty"
            | "tabby"
            | "hyper"
            | "code"
            | "cursor"
    ) || parent.contains(".app/contents/macos/code")
        || parent.contains(".app/contents/macos/cursor")
        || parent.contains(".app/contents/macos/terminal")
        || parent.contains(".app/contents/macos/iterm2");

    if shell_parent {
        return PresenceState::Cli;
    }
    if !exe.is_empty() {
        return PresenceState::App;
    }
    PresenceState::Idle
}

#[cfg(windows)]
fn scan_codex_processes() -> Vec<ProcessSnapshot> {
    scan_codex_processes_windows()
}

#[cfg(target_os = "macos")]
fn scan_codex_processes() -> Vec<ProcessSnapshot> {
    scan_codex_processes_macos()
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn scan_codex_processes() -> Vec<ProcessSnapshot> {
    Vec::new()
}

#[cfg(windows)]
fn scan_codex_processes_windows() -> Vec<ProcessSnapshot> {
    let entries = list_process_entries();
    let names = entries
        .iter()
        .map(|entry| (entry.process_id, entry.name.clone()))
        .collect::<HashMap<_, _>>();

    entries
        .into_iter()
        .filter(|entry| entry.name.eq_ignore_ascii_case("codex.exe"))
        .map(|entry| ProcessSnapshot {
            parent_name: names.get(&entry.parent_process_id).cloned(),
            executable_path: query_process_path(entry.process_id),
            creation_date_ms: query_process_creation_ms(entry.process_id),
        })
        .collect()
}

#[cfg(windows)]
fn list_process_entries() -> Vec<ProcessEntry> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            entries.push(ProcessEntry {
                process_id: entry.th32ProcessID,
                parent_process_id: entry.th32ParentProcessID,
                name: wide_to_string(&entry.szExeFile),
            });

            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }

    close_handle(snapshot);
    entries
}

#[cfg(windows)]
fn query_process_path(process_id: u32) -> Option<String> {
    let handle = open_process_query(process_id)?;
    let mut buffer = vec![0u16; 32_768];
    let mut len = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    };
    close_handle(handle);
    result.ok()?;
    Some(String::from_utf16_lossy(&buffer[..len as usize]))
}

#[cfg(windows)]
fn query_process_creation_ms(process_id: u32) -> Option<u64> {
    let handle = open_process_query(process_id)?;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let result =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    close_handle(handle);
    result.ok()?;
    filetime_to_unix_ms(creation)
}

#[cfg(windows)]
fn open_process_query(process_id: u32) -> Option<HANDLE> {
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()
}

#[cfg(windows)]
fn close_handle(handle: HANDLE) {
    let _ = unsafe { CloseHandle(handle) };
}

#[cfg(windows)]
fn wide_to_string(value: &[u16]) -> String {
    let len = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..len])
}

#[cfg(windows)]
fn filetime_to_unix_ms(value: FILETIME) -> Option<u64> {
    const WINDOWS_TO_UNIX_EPOCH_MS: u64 = 11_644_473_600_000;
    let ticks = ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64;
    let ms = ticks / 10_000;
    ms.checked_sub(WINDOWS_TO_UNIX_EPOCH_MS)
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct MacProcessEntry {
    process_id: u32,
    parent_process_id: u32,
    command: String,
}

#[cfg(target_os = "macos")]
fn scan_codex_processes_macos() -> Vec<ProcessSnapshot> {
    let entries = list_macos_process_entries();
    let commands = entries
        .iter()
        .map(|entry| (entry.process_id, entry.command.clone()))
        .collect::<HashMap<_, _>>();

    entries
        .into_iter()
        .filter(|entry| is_macos_codex_candidate(&entry.command))
        .map(|entry| ProcessSnapshot {
            parent_name: commands.get(&entry.parent_process_id).cloned(),
            executable_path: Some(entry.command),
            creation_date_ms: None,
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn list_macos_process_entries() -> Vec<MacProcessEntry> {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_macos_process_line)
        .collect()
}

#[cfg(target_os = "macos")]
fn parse_macos_process_line(line: &str) -> Option<MacProcessEntry> {
    let (process_id, rest) = split_process_field(line)?;
    let (parent_process_id, rest) = split_process_field(rest)?;
    let process_id = process_id.parse().ok()?;
    let parent_process_id = parent_process_id.parse().ok()?;
    let command = rest.trim_start().to_string();
    if command.is_empty() {
        return None;
    }
    Some(MacProcessEntry {
        process_id,
        parent_process_id,
        command,
    })
}

#[cfg(target_os = "macos")]
fn split_process_field(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    if input.is_empty() {
        return None;
    }
    let end = input.find(char::is_whitespace).unwrap_or(input.len());
    Some((&input[..end], &input[end..]))
}

#[cfg(target_os = "macos")]
fn is_macos_codex_candidate(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    if command.contains("codex-rich-presence") {
        return false;
    }
    command.contains("/node_modules/@openai/codex/")
        || command.contains("/@openai/codex/")
        || command.contains(".app/contents/macos/codex")
        || command_basename(&command) == "codex"
}

fn command_basename(command: &str) -> String {
    let executable = command.split_whitespace().next().unwrap_or(command);
    executable
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(executable)
        .to_ascii_lowercase()
}

fn build_activity(result: &DetectionResult, settings: &RpcSettings) -> Option<Value> {
    if result.state == PresenceState::Idle {
        return None;
    }
    let mode = normalize_mode(&settings.mode);
    let activity_type = match mode.as_str() {
        "watching" => ACTIVITY_WATCHING,
        "listening" => ACTIVITY_LISTENING,
        "competing" => ACTIVITY_COMPETING,
        _ => ACTIVITY_PLAYING,
    };

    let mut activity = json!({
        "name": "Codex",
        "type": activity_type,
        "created_at": now_ms(),
        "instance": false,
        "details": build_details(result, &mode),
        "state": build_state_line(result),
        "assets": {
            "large_image": "codex_logo",
            "large_text": build_large_image_text(result),
            "small_image": small_image_key(result.state),
            "small_text": small_image_text(result.state),
        },
    });

    if let Some(started_at_ms) = result.started_at_ms {
        activity["timestamps"] = json!({ "start": started_at_ms / 1000 });
    }
    if mode == "watching" && !settings.buttons.is_empty() {
        activity["buttons"] =
            serde_json::to_value(settings.buttons.iter().take(2).collect::<Vec<_>>()).ok()?;
    }

    Some(activity)
}

fn build_details(result: &DetectionResult, mode: &str) -> String {
    let base = match (result.state, mode) {
        (PresenceState::Cli, "watching") => "Watching Codex CLI",
        (PresenceState::App, "watching") => "Watching Codex",
        (PresenceState::Both, "watching") => "Watching Codex (CLI + Desktop)",
        (PresenceState::Cli, _) => "Coding with Codex CLI",
        (PresenceState::App, _) => "Using Codex",
        (PresenceState::Both, _) => "Coding with Codex (CLI + Desktop)",
        (PresenceState::Idle, _) => "",
    };
    if let Some(repo) = result
        .session
        .as_ref()
        .and_then(|session| sanitize_field(Some(&session.repo_name), 32))
    {
        let candidate = format!("{base} - {repo}");
        if candidate.len() <= 96 {
            return candidate;
        }
    }
    base.to_string()
}

fn build_state_line(result: &DetectionResult) -> String {
    let model = result
        .codex
        .as_ref()
        .and_then(|cfg| cfg.model.as_deref())
        .and_then(format_model);
    let effort = result
        .codex
        .as_ref()
        .and_then(|cfg| cfg.effort.as_deref())
        .and_then(format_effort);
    let mut parts = Vec::new();
    if let Some(model) = model {
        parts.push(model);
    }
    if let Some(effort) = effort {
        parts.push(effort);
    }
    let base = if parts.is_empty() {
        match result.state {
            PresenceState::Cli => "Terminal session active".into(),
            PresenceState::App => "Desktop session".into(),
            PresenceState::Both => "CLI + Desktop".into(),
            PresenceState::Idle => String::new(),
        }
    } else {
        parts.join(" - ")
    };

    let usage = compact_usage_parts(result);
    for count in (0..=usage.len()).rev() {
        let suffix = usage[..count].join(" - ");
        let candidate = if suffix.is_empty() {
            base.clone()
        } else {
            format!("{base} - {suffix}")
        };
        if candidate.len() <= 48 {
            return candidate;
        }
    }
    truncate(base, 48)
}

fn build_large_image_text(result: &DetectionResult) -> String {
    let usage = compact_usage_parts(result);
    if usage.is_empty() {
        "OpenAI Codex".into()
    } else {
        truncate(format!("OpenAI Codex - {}", usage.join(" - ")), 48)
    }
}

fn compact_usage_parts(result: &DetectionResult) -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(usage) = &result.usage {
        if let Some(primary) = &usage.primary {
            parts.push(format!("5h {}%", remaining_percent(primary)));
        }
        if let Some(secondary) = &usage.secondary {
            parts.push(format!(
                "week {}%",
                remaining_percent(secondary)
            ));
        }
    }
    parts
}

fn format_status_line(result: &DetectionResult, discord_user: Option<&str>) -> String {
    let state = match result.state {
        PresenceState::Both => "Codex: CLI/Desktop",
        PresenceState::Cli => "Codex: CLI",
        PresenceState::App => "Codex: Desktop",
        PresenceState::Idle => "Codex: Off",
    };
    let model = result
        .codex
        .as_ref()
        .and_then(|cfg| cfg.model.as_deref())
        .and_then(format_model);
    let effort = result
        .codex
        .as_ref()
        .and_then(|cfg| cfg.effort.as_deref())
        .and_then(format_effort);
    let model_line = [model, effort]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" - ");
    let usage_line = format_usage(result.usage.as_ref()).unwrap_or_default();
    let discord = match discord_user {
        Some(user) => format!("Discord: Connected ({user})"),
        None => "Discord: RPC Disabled".into(),
    };
    format!("{state}|{model_line}|{usage_line}|{discord}")
}

fn format_usage(usage: Option<&CodexUsage>) -> Option<String> {
    let usage = usage?;
    let mut parts = Vec::new();
    if let Some(primary) = &usage.primary {
        parts.push(format!(
            "5h {}% left",
            remaining_percent(primary)
        ));
    }
    if let Some(secondary) = &usage.secondary {
        parts.push(format!(
            "week {}% left",
            remaining_percent(secondary)
        ));
    }
    if let Some(credits) = usage.credits_remaining {
        parts.push(format!("credits {}", credits.round()));
    }
    if parts.is_empty() {
        None
    } else {
        Some(format!("Usage: {}", parts.join(" / ")))
    }
}

fn read_rpc_settings(path: &Path) -> RpcSettings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return RpcSettings::default(),
    };
    let mut settings =
        serde_json::from_str::<RpcSettings>(raw.trim_start_matches('\u{feff}')).unwrap_or_default();
    if settings.show_usage == Some(false) {
        settings.show_primary_usage = false;
        settings.show_weekly_usage = false;
    }
    settings.show_usage = None;
    settings.mode = normalize_mode(&settings.mode);
    settings.buttons = settings
        .buttons
        .into_iter()
        .filter_map(|button| {
            let label = clean_label(&button.label)?;
            let url = clean_url(&button.url)?;
            Some(RpcButton { label, url })
        })
        .take(2)
        .collect();
    settings
}

fn filter_usage(result: &mut DetectionResult, settings: &RpcSettings) {
    if let Some(usage) = result.usage.as_mut() {
        if !settings.show_primary_usage {
            usage.primary = None;
        }
        if !settings.show_weekly_usage {
            usage.secondary = None;
        }
    }
}

fn read_codex_config() -> Option<CodexConfig> {
    let raw = fs::read_to_string(home_dir().join(".codex").join("config.toml")).ok()?;
    let mut cfg = CodexConfig::default();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        if let Some(value) = extract_toml_string(trimmed, "model") {
            cfg.model = Some(value);
        }
        if let Some(value) = extract_toml_string(trimmed, "model_reasoning_effort") {
            cfg.effort = Some(value);
        }
    }
    Some(cfg)
}

fn read_codex_session() -> Option<CodexSession> {
    let latest = find_latest_rollout_file(&sessions_dir(), 24 * 60 * 60 * 1000)?;
    let first_line = read_first_line(&latest.0)?;
    let obj: Value = serde_json::from_str(first_line.trim()).ok()?;
    if obj.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let cwd = obj
        .get("payload")
        .and_then(|payload| payload.get("cwd"))
        .and_then(Value::as_str)?;
    Some(CodexSession {
        repo_name: basename_safe(strip_windows_long_prefix(cwd)),
    })
}

fn read_codex_usage() -> Option<CodexUsage> {
    let mut fallback = None;
    for rollout in find_recent_rollout_files(&sessions_dir(), 24 * 60 * 60 * 1000) {
        let Some(lines) = read_tail_lines(&rollout.0, 256 * 1024) else {
            continue;
        };
        for line in lines.iter().rev() {
            let Some(usage) = parse_usage_line(line) else {
                continue;
            };
            if usage.limit_id.as_deref() == Some("codex") {
                return Some(usage);
            }
            if fallback.is_none() {
                fallback = Some(usage);
            }
        }
    }
    fallback
}

fn parse_usage_line(line: &str) -> Option<CodexUsage> {
    let obj: Value = serde_json::from_str(line).ok()?;
    if obj.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = obj.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let limits = payload.get("rate_limits")?;
    Some(CodexUsage {
        limit_id: limits
            .get("limit_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        primary: parse_limit(limits.get("primary")),
        secondary: parse_limit(limits.get("secondary")),
        credits_remaining: limits
            .get("credits")
            .and_then(|credits| credits.get("remaining").or_else(|| credits.get("balance")))
            .and_then(Value::as_f64),
    })
}

fn parse_limit(value: Option<&Value>) -> Option<LimitSnapshot> {
    let value = value?;
    Some(LimitSnapshot {
        used_percent: value.get("used_percent")?.as_f64()?,
        resets_at_ms: value
            .get("resets_at")
            .and_then(Value::as_u64)
            .map(|seconds| seconds.saturating_mul(1000)),
    })
}

fn find_latest_rollout_file(root: &Path, max_age_ms: u64) -> Option<(PathBuf, u64)> {
    fn walk(dir: &Path, now: u64, max_age_ms: u64, best: &mut Option<(PathBuf, u64)>) {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                walk(&path, now, max_age_ms, best);
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !file_type.is_file() || !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let Some(mtime) = modified_ms(&path) else {
                continue;
            };
            if now.saturating_sub(mtime) > max_age_ms {
                continue;
            }
            if best
                .as_ref()
                .map(|(_, best_time)| mtime > *best_time)
                .unwrap_or(true)
            {
                *best = Some((path, mtime));
            }
        }
    }

    let mut best = None;
    walk(root, now_ms(), max_age_ms, &mut best);
    best
}

fn find_recent_rollout_files(root: &Path, max_age_ms: u64) -> Vec<(PathBuf, u64)> {
    fn walk(dir: &Path, now: u64, max_age_ms: u64, files: &mut Vec<(PathBuf, u64)>) {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                walk(&path, now, max_age_ms, files);
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !file_type.is_file() || !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let Some(mtime) = modified_ms(&path) else {
                continue;
            };
            if now.saturating_sub(mtime) <= max_age_ms {
                files.push((path, mtime));
            }
        }
    }

    let mut files = Vec::new();
    walk(root, now_ms(), max_age_ms, &mut files);
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
}

fn read_first_line(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buf = vec![0; 8192];
    let len = file.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..len]);
    Some(text.split('\n').next().unwrap_or_default().to_string())
}

fn read_tail_lines(path: &Path, max_bytes: u64) -> Option<Vec<String>> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let len = size.min(max_bytes);
    let offset = size.saturating_sub(len);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0; len as usize];
    file.read_exact(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if offset > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Some(lines)
}

struct DiscordIpc {
    connection: IpcConnection,
    username: Option<String>,
    nonce: u64,
}

enum IpcConnection {
    #[cfg(windows)]
    File(File),
    #[cfg(unix)]
    Unix(UnixStream),
}

impl Read for IpcConnection {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(windows)]
            Self::File(file) => file.read(buf),
            #[cfg(unix)]
            Self::Unix(stream) => stream.read(buf),
        }
    }
}

impl Write for IpcConnection {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(windows)]
            Self::File(file) => file.write(buf),
            #[cfg(unix)]
            Self::Unix(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(windows)]
            Self::File(file) => file.flush(),
            #[cfg(unix)]
            Self::Unix(stream) => stream.flush(),
        }
    }
}

impl DiscordIpc {
    fn connect(client_id: &str) -> std::io::Result<Self> {
        let mut client = Self {
            connection: connect_discord_ipc()?,
            username: None,
            nonce: 0,
        };
        client.send_frame(0, &json!({ "v": 1, "client_id": client_id }))?;
        let ready = client.read_frame()?;
        client.username = ready
            .get("data")
            .and_then(|data| data.get("user"))
            .and_then(|user| user.get("username"))
            .and_then(Value::as_str)
            .map(|value| sanitize_discord_user(value).unwrap_or_else(|| value.to_string()));
        Ok(client)
    }

    fn set_activity(&mut self, activity: Value) -> std::io::Result<()> {
        let nonce = self.next_nonce();
        self.send_frame(
            1,
            &json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id(), "activity": activity },
                "nonce": nonce,
            }),
        )?;
        self.read_response(&nonce)
    }

    fn clear_activity(&mut self) -> std::io::Result<()> {
        let nonce = self.next_nonce();
        self.send_frame(
            1,
            &json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id() },
                "nonce": nonce,
            }),
        )?;
        self.read_response(&nonce)
    }

    fn read_response(&mut self, nonce: &str) -> std::io::Result<()> {
        for _ in 0..4 {
            let frame = self.read_frame()?;
            if frame.get("nonce").and_then(Value::as_str) == Some(nonce) {
                if frame.get("evt").and_then(Value::as_str) == Some("ERROR") {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "discord rpc error",
                    ));
                }
                return Ok(());
            }
        }
        Ok(())
    }

    fn next_nonce(&mut self) -> String {
        self.nonce += 1;
        format!("codex-rpc-{}-{}", std::process::id(), self.nonce)
    }

    fn send_frame(&mut self, opcode: u32, payload: &Value) -> std::io::Result<()> {
        let data = serde_json::to_vec(payload)?;
        self.connection.write_all(&opcode.to_le_bytes())?;
        self.connection
            .write_all(&(data.len() as u32).to_le_bytes())?;
        self.connection.write_all(&data)?;
        self.connection.flush()
    }

    fn read_frame(&mut self) -> std::io::Result<Value> {
        loop {
            let mut header = [0u8; 8];
            self.connection.read_exact(&mut header)?;
            let opcode = u32::from_le_bytes(header[0..4].try_into().unwrap());
            let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            if len > 1024 * 1024 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "discord ipc frame too large",
                ));
            }
            let mut payload = vec![0u8; len];
            self.connection.read_exact(&mut payload)?;
            let value: Value = serde_json::from_slice(&payload)?;
            match opcode {
                1 => return Ok(value),
                2 => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "discord closed ipc",
                    ));
                }
                3 => {
                    let _ = self.send_frame(4, &value);
                }
                4 => {}
                _ => {}
            }
        }
    }
}

#[cfg(windows)]
fn connect_discord_ipc() -> std::io::Result<IpcConnection> {
    for id in 0..10 {
        let path = format!(r"\\?\pipe\discord-ipc-{id}");
        if let Ok(candidate) = OpenOptions::new().read(true).write(true).open(path) {
            return Ok(IpcConnection::File(candidate));
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "discord ipc",
    ))
}

#[cfg(unix)]
fn connect_discord_ipc() -> std::io::Result<IpcConnection> {
    for base in discord_ipc_roots() {
        for id in 0..10 {
            let path = base.join(format!("discord-ipc-{id}"));
            if let Ok(stream) = UnixStream::connect(path) {
                return Ok(IpcConnection::Unix(stream));
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "discord ipc",
    ))
}

#[cfg(unix)]
fn discord_ipc_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for name in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] {
        if let Some(path) = std::env::var_os(name).map(PathBuf::from) {
            push_unique_path(&mut roots, path);
        }
    }
    for path in ["/tmp", "/var/tmp", "/usr/tmp"] {
        push_unique_path(&mut roots, PathBuf::from(path));
    }
    roots
}

#[cfg(unix)]
fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn clean_label(value: &str) -> Option<String> {
    let cleaned = value
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.chars().take(32).collect())
    }
}

fn clean_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        Some(value.to_string())
    } else {
        None
    }
}

fn clean_status_line(line: &str) -> String {
    line.replace(['\r', '\n'], " ").chars().take(256).collect()
}

fn write_status(path: &Path, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("txt.tmp");
    if fs::write(&tmp, clean_status_line(line)).is_ok() {
        let _ = fs::rename(tmp, path);
    }
}

fn clear_status(path: &Path) {
    let _ = fs::remove_file(path);
}

fn normalize_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "watching" | "tv" => "watching",
        "listening" | "listen" => "listening",
        "competing" | "compete" => "competing",
        _ => "playing",
    }
    .into()
}

fn extract_toml_string(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start();
    let value = rest.strip_prefix('=')?.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        return Some(value[1..value.len() - 1].replace("\\\"", "\""));
    }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        return Some(value[1..value.len() - 1].to_string());
    }
    Some(value.to_string())
}

fn format_model(model: &str) -> Option<String> {
    sanitize_field(
        Some(
            &model
                .split('-')
                .enumerate()
                .map(|(i, segment)| {
                    if i == 0 && segment.chars().all(|ch| ch.is_ascii_lowercase()) {
                        segment.to_ascii_uppercase()
                    } else if segment
                        .chars()
                        .next()
                        .map(char::is_lowercase)
                        .unwrap_or(false)
                    {
                        let mut chars = segment.chars();
                        match chars.next() {
                            Some(first) => {
                                first.to_uppercase().collect::<String>() + chars.as_str()
                            }
                            None => String::new(),
                        }
                    } else {
                        segment.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("-"),
        ),
        24,
    )
}

fn format_effort(effort: &str) -> Option<String> {
    let label = match effort.to_ascii_lowercase().as_str() {
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" | "extra-high" => "Extra High",
        _ => effort,
    };
    sanitize_field(Some(label), 16)
}

fn sanitize_field(raw: Option<&str>, max_len: usize) -> Option<String> {
    let cleaned = raw?
        .chars()
        .filter(|ch| !ch.is_control() && !matches!(*ch as u32, 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2069 | 0xFEFF))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        None
    } else {
        Some(truncate(cleaned, max_len))
    }
}

fn sanitize_discord_user(raw: &str) -> Option<String> {
    sanitize_field(Some(raw), 32)
}

fn truncate(value: String, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value;
    }
    let mut result = value
        .chars()
        .take(max_len.saturating_sub(3))
        .collect::<String>();
    result.push_str("...");
    result
}

fn small_image_key(state: PresenceState) -> &'static str {
    match state {
        PresenceState::Cli => "cli_badge",
        PresenceState::App => "app_badge",
        PresenceState::Both => "combo_badge",
        PresenceState::Idle => "codex_logo",
    }
}

fn small_image_text(state: PresenceState) -> &'static str {
    match state {
        PresenceState::Cli => "Codex CLI",
        PresenceState::App => "Codex Desktop",
        PresenceState::Both => "CLI + Desktop",
        PresenceState::Idle => "Codex",
    }
}

fn presence_key(result: &DetectionResult, settings: &RpcSettings) -> String {
    format!(
        "{:?}|{:?}|{}|{}|{}|{}|{}|{}|{}|{}",
        result.state,
        result.started_at_ms,
        result
            .codex
            .as_ref()
            .and_then(|cfg| cfg.model.as_deref())
            .unwrap_or(""),
        result
            .codex
            .as_ref()
            .and_then(|cfg| cfg.effort.as_deref())
            .unwrap_or(""),
        result
            .session
            .as_ref()
            .map(|session| session.repo_name.as_str())
            .unwrap_or(""),
        format_usage(result.usage.as_ref()).unwrap_or_default(),
        settings.mode,
        settings.show_primary_usage,
        settings.show_weekly_usage,
        settings
            .buttons
            .iter()
            .map(|button| format!("{}:{}", button.label, button.url))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn min_option(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn remaining_percent(limit: &LimitSnapshot) -> i64 {
    if limit
        .resets_at_ms
        .map(|reset| reset <= now_ms())
        .unwrap_or(false)
    {
        return 100;
    }
    (100.0 - limit.used_percent).max(0.0).round() as i64
}

fn parse_env_u64(name: &str, fallback: u64, min: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= min)
        .unwrap_or(fallback)
}

fn sleep_polling(stop: &AtomicBool, total_ms: u64) {
    let mut remaining = total_ms;
    while remaining > 0 && !stop.load(Ordering::SeqCst) {
        let chunk = remaining.min(200);
        thread::sleep(Duration::from_millis(chunk));
        remaining -= chunk;
    }
}

fn sessions_dir() -> PathBuf {
    home_dir().join(".codex").join("sessions")
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn app_data_dir() -> PathBuf {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("codex-rich-presence");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("codex-rich-presence");
    }
    PathBuf::from(".").join("codex-rich-presence")
}

fn strip_windows_long_prefix(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

fn basename_safe(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    trimmed
        .rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}
