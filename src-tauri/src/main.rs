#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[cfg(windows)]
const RUN_REGISTRY_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_REGISTRY_NAME: &str = "CodexRichPresence";
#[cfg(target_os = "macos")]
const MACOS_LAUNCH_AGENT_LABEL: &str = "eu.stealthylabs.codex-rich-presence";

#[derive(Default)]
struct DaemonState {
    running: Arc<Mutex<bool>>,
    error: Mutex<Option<String>>,
    stop: Arc<AtomicBool>,
    handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[derive(Default)]
struct TrayMenuState {
    usage_5h: Mutex<Option<MenuItem<tauri::Wry>>>,
    usage_week: Mutex<Option<MenuItem<tauri::Wry>>>,
    usage_spark_5h: Mutex<Option<MenuItem<tauri::Wry>>>,
    usage_spark_week: Mutex<Option<MenuItem<tauri::Wry>>>,
    startup: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

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
    #[serde(default = "default_show_usage")]
    show_spark_primary_usage: bool,
    #[serde(default = "default_show_usage")]
    show_spark_weekly_usage: bool,
    #[serde(default = "default_show_usage")]
    show_effort: bool,
    #[serde(default = "default_show_usage")]
    show_credits: bool,
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
            show_spark_primary_usage: true,
            show_spark_weekly_usage: true,
            show_effort: true,
            show_credits: true,
        }
    }
}

fn default_show_usage() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
struct AppStatus {
    settings_path: String,
    status_line: String,
}

#[derive(Debug, Clone, Serialize)]
struct DaemonStatus {
    running: bool,
    pid: Option<u32>,
    error: Option<String>,
}

#[tauri::command]
fn load_settings() -> Result<RpcSettings, String> {
    let path = settings_path()?;
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(normalize_settings(
            serde_json::from_str::<RpcSettings>(raw.trim_start_matches('\u{feff}'))
                .unwrap_or_default(),
        )),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(RpcSettings::default()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn save_settings(_app: tauri::AppHandle, settings: RpcSettings) -> Result<(), String> {
    let settings = normalize_settings(settings);
    write_settings(&settings)?;
    Ok(())
}

fn write_settings(settings: &RpcSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let json = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
}

#[tauri::command]
fn load_status() -> Result<AppStatus, String> {
    let path = settings_path()?;
    let status = status_path()?;
    let status_line = fs::read_to_string(status)
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|_| "Codex: Off".into());

    Ok(AppStatus {
        settings_path: path.to_string_lossy().into_owned(),
        status_line,
    })
}

#[tauri::command]
fn start_daemon(
    app: tauri::AppHandle,
    state: tauri::State<'_, DaemonState>,
) -> Result<DaemonStatus, String> {
    start_daemon_inner(&app, &state);
    Ok(read_daemon_status(&state))
}

#[tauri::command]
fn daemon_status(state: tauri::State<'_, DaemonState>) -> Result<DaemonStatus, String> {
    Ok(read_daemon_status(&state))
}

fn main() {
    tauri::Builder::default()
        .manage(DaemonState::default())
        .manage(TrayMenuState::default())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            load_status,
            start_daemon,
            daemon_status,
            close_settings
        ])
        .setup(|app| {
            keep_window_in_tray(app);
            let handle = app.handle().clone();
            let state = app.state::<DaemonState>();
            start_daemon_inner(&handle, &state);
            create_tray(app)?;
            spawn_usage_refresh_thread(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Codex RPC tray");
}

fn keep_window_in_tray(app: &mut tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        let window_to_hide = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_to_hide.hide();
            }
        });
    }
}

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Settings", true, None::<&str>)?;
    let usage_5h_item = MenuItem::with_id(app, "usage_5h", "5h: —", false, None::<&str>)?;
    let usage_week_item = MenuItem::with_id(app, "usage_week", "Week: —", false, None::<&str>)?;
    let usage_spark_5h_item =
        MenuItem::with_id(app, "usage_spark_5h", "Spark 5h: —", false, None::<&str>)?;
    let usage_spark_week_item = MenuItem::with_id(
        app,
        "usage_spark_week",
        "Spark week: —",
        false,
        None::<&str>,
    )?;
    let startup_item = CheckMenuItem::with_id(
        app,
        "startup",
        startup_menu_label(),
        true,
        startup_enabled(),
        None::<&str>,
    )?;
    let separator_1 = PredefinedMenuItem::separator(app)?;
    let separator_2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &separator_1,
            &usage_5h_item,
            &usage_week_item,
            &usage_spark_5h_item,
            &usage_spark_week_item,
            &startup_item,
            &separator_2,
            &quit_item,
        ],
    )?;

    let tray_state = app.state::<TrayMenuState>();
    *tray_state.usage_5h.lock().expect("tray menu mutex poisoned") = Some(usage_5h_item.clone());
    *tray_state
        .usage_week
        .lock()
        .expect("tray menu mutex poisoned") = Some(usage_week_item.clone());
    *tray_state
        .usage_spark_5h
        .lock()
        .expect("tray menu mutex poisoned") = Some(usage_spark_5h_item.clone());
    *tray_state
        .usage_spark_week
        .lock()
        .expect("tray menu mutex poisoned") = Some(usage_spark_week_item.clone());
    *tray_state.startup.lock().expect("tray menu mutex poisoned") = Some(startup_item.clone());

    TrayIconBuilder::new()
        .tooltip("Codex RPC")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_settings(app),
            "startup" => {
                let _ = set_startup_enabled(!startup_enabled());
                sync_startup_menu(app);
            }
            "quit" => {
                let state = app.state::<DaemonState>();
                stop_daemon(&state);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_settings(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn spawn_usage_refresh_thread(handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut last_line = String::new();
        loop {
            let line = status_path()
                .ok()
                .and_then(|path| fs::read_to_string(path).ok())
                .map(|raw| raw.trim().to_string())
                .unwrap_or_default();
            if line != last_line {
                last_line.clone_from(&line);
                sync_usage_menu(&handle, &line);
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

fn sync_usage_menu(app: &tauri::AppHandle, status_line: &str) {
    let labels = parse_status_usage(status_line);
    let state = app.state::<TrayMenuState>();
    let usage_5h = state.usage_5h.lock().expect("tray menu mutex poisoned").clone();
    let usage_week = state.usage_week.lock().expect("tray menu mutex poisoned").clone();
    let usage_spark_5h = state
        .usage_spark_5h
        .lock()
        .expect("tray menu mutex poisoned")
        .clone();
    let usage_spark_week = state
        .usage_spark_week
        .lock()
        .expect("tray menu mutex poisoned")
        .clone();

    if let Some(item) = usage_5h {
        let _ = item.set_text(format!("5h: {}", labels.primary.as_deref().unwrap_or("—")));
    }
    if let Some(item) = usage_week {
        let _ = item.set_text(format!("Week: {}", labels.secondary.as_deref().unwrap_or("—")));
    }
    if let Some(item) = usage_spark_5h {
        let _ = item.set_text(format!(
            "Spark 5h: {}",
            labels.spark_primary.as_deref().unwrap_or("—")
        ));
    }
    if let Some(item) = usage_spark_week {
        let _ = item.set_text(format!(
            "Spark week: {}",
            labels.spark_secondary.as_deref().unwrap_or("—")
        ));
    }
}

#[derive(Default)]
struct UsageLabels {
    primary: Option<String>,
    secondary: Option<String>,
    spark_primary: Option<String>,
    spark_secondary: Option<String>,
}

fn parse_status_usage(status_line: &str) -> UsageLabels {
    // Status line format: "{state}|{model}|{usage}|{discord}" where {usage}
    // is "Usage: 5h X% left / week Y% left / Spark 5h Z% left / Spark week W% left / credits N".
    let mut labels = UsageLabels::default();
    let usage_field = match status_line.split('|').nth(2) {
        Some(field) if !field.trim().is_empty() => field.trim().to_string(),
        _ => return labels,
    };
    let body = usage_field
        .strip_prefix("Usage:")
        .map(str::trim)
        .unwrap_or(usage_field.as_str());
    for raw in body.split('/') {
        let part = raw.trim();
        let lower = part.to_ascii_lowercase();
        let value = part
            .trim_end_matches(|ch: char| ch.is_ascii_alphabetic() || ch.is_whitespace())
            .rsplit(' ')
            .next()
            .unwrap_or("")
            .to_string();
        if value.is_empty() {
            continue;
        }
        if lower.starts_with("spark 5h") {
            labels.spark_primary = Some(value);
        } else if lower.starts_with("spark week") || lower.starts_with("spark wk") {
            labels.spark_secondary = Some(value);
        } else if lower.starts_with("5h") {
            labels.primary = Some(value);
        } else if lower.starts_with("week") {
            labels.secondary = Some(value);
        }
    }
    labels
}

fn sync_startup_menu(app: &tauri::AppHandle) {
    let startup = app
        .state::<TrayMenuState>()
        .startup
        .lock()
        .expect("tray menu mutex poisoned")
        .clone();
    if let Some(item) = startup {
        let _ = item.set_checked(startup_enabled());
    }
}

#[cfg(windows)]
fn startup_menu_label() -> &'static str {
    "Start on Windows"
}

#[cfg(not(windows))]
fn startup_menu_label() -> &'static str {
    "Start at Login"
}

#[cfg(windows)]
fn startup_enabled() -> bool {
    reg_command()
        .args(["query", RUN_REGISTRY_KEY, "/v", RUN_REGISTRY_NAME])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn startup_enabled() -> bool {
    launch_agent_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn startup_enabled() -> bool {
    false
}

#[cfg(windows)]
fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    let mut command = reg_command();
    if enabled {
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let startup_command = format!("\"{}\"", exe.to_string_lossy());
        command.args([
            "add",
            RUN_REGISTRY_KEY,
            "/v",
            RUN_REGISTRY_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &startup_command,
            "/f",
        ]);
    } else {
        command.args(["delete", RUN_REGISTRY_KEY, "/v", RUN_REGISTRY_NAME, "/f"]);
    }

    let status = command.status().map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("reg.exe exited with {status}"))
    }
}

#[cfg(target_os = "macos")]
fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    let path = launch_agent_path()?;
    if enabled {
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let exe = xml_escape(&exe.to_string_lossy());
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{MACOS_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
        );
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(path, plist).map_err(|err| err.to_string())
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn set_startup_enabled(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn reg_command() -> std::process::Command {
    use std::ffi::OsString;
    use std::os::windows::process::CommandExt;

    let system_root = std::env::var_os("SystemRoot")
        .unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let reg_path = Path::new(&system_root).join("System32").join("reg.exe");
    let mut command = std::process::Command::new(reg_path);
    command.creation_flags(0x08000000);
    command
}

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    Ok(Path::new(&home)
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{MACOS_LAUNCH_AGENT_LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn start_daemon_inner(_app: &tauri::AppHandle, state: &DaemonState) {
    let mut running = state.running.lock().expect("daemon state mutex poisoned");
    if *running {
        return;
    }

    state.stop.store(false, Ordering::SeqCst);
    *state.error.lock().expect("daemon error mutex poisoned") = None;
    *running = true;

    let stop = Arc::clone(&state.stop);
    let running_flag = Arc::clone(&state.running);
    let status_path = status_path().ok();
    let settings_path = settings_path().ok();
    if let Some(handle) = state
        .handle
        .lock()
        .expect("daemon handle mutex poisoned")
        .take()
    {
        let _ = handle.join();
    }
    let handle = std::thread::spawn(move || {
        daemon::run(stop, settings_path, status_path);
        if let Ok(mut running) = running_flag.lock() {
            *running = false;
        }
    });
    *state.handle.lock().expect("daemon handle mutex poisoned") = Some(handle);
}

fn stop_daemon(state: &DaemonState) {
    state.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = state
        .handle
        .lock()
        .expect("daemon handle mutex poisoned")
        .take()
    {
        let _ = handle.join();
    }
}

fn read_daemon_status(state: &DaemonState) -> DaemonStatus {
    let running = *state.running.lock().expect("daemon state mutex poisoned");
    let error = state
        .error
        .lock()
        .expect("daemon error mutex poisoned")
        .clone();

    DaemonStatus {
        running,
        pid: if running {
            Some(std::process::id())
        } else {
            None
        },
        error,
    }
}

#[tauri::command]
fn close_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn show_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn normalize_settings(mut settings: RpcSettings) -> RpcSettings {
    if settings.show_usage == Some(false) {
        settings.show_primary_usage = false;
        settings.show_weekly_usage = false;
        settings.show_spark_primary_usage = false;
        settings.show_spark_weekly_usage = false;
        settings.show_credits = false;
    }
    settings.show_usage = None;

    settings.mode = match settings.mode.trim().to_ascii_lowercase().as_str() {
        "watching" | "tv" => "watching".into(),
        "listening" | "listen" => "listening".into(),
        "competing" | "compete" => "competing".into(),
        _ => "playing".into(),
    };

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

fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("rpc-buttons.json"))
}

fn status_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("status.txt"))
}

fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return Ok(Path::new(&local_app_data).join("codex-rich-presence"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(Path::new(&home)
            .join("Library")
            .join("Application Support")
            .join("codex-rich-presence"));
    }
    std::env::current_dir()
        .map(|path| path.join("codex-rich-presence"))
        .map_err(|err| err.to_string())
}
