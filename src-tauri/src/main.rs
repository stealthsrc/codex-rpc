#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

#[derive(Default)]
struct DaemonState {
    child: Mutex<Option<CommandChild>>,
    error: Mutex<Option<String>>,
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
        }
    }
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
            serde_json::from_str::<RpcSettings>(raw.trim_start_matches('\u{feff}')).unwrap_or_default(),
        )),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(RpcSettings::default()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn save_settings(settings: RpcSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let settings = normalize_settings(settings);
    let json = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
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
        .plugin(tauri_plugin_shell::init())
        .manage(DaemonState::default())
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Codex Rich Presence tray");
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
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    TrayIconBuilder::new()
        .tooltip("Codex Rich Presence")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_settings(app),
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

fn start_daemon_inner(app: &tauri::AppHandle, state: &DaemonState) {
    let mut child_slot = state.child.lock().expect("daemon child mutex poisoned");
    if child_slot.is_some() {
        return;
    }

    match app
        .shell()
        .sidecar("codex-rpc-daemon")
        .and_then(|command| command.args(["--no-tray"]).spawn().map(|(_, child)| child))
    {
        Ok(child) => {
            *state.error.lock().expect("daemon error mutex poisoned") = None;
            *child_slot = Some(child);
        }
        Err(err) => {
            *state.error.lock().expect("daemon error mutex poisoned") = Some(err.to_string());
        }
    }
}

fn stop_daemon(state: &DaemonState) {
    if let Some(child) = state
        .child
        .lock()
        .expect("daemon child mutex poisoned")
        .take()
    {
        let _ = child.kill();
    }
}

fn read_daemon_status(state: &DaemonState) -> DaemonStatus {
    let pid = state
        .child
        .lock()
        .expect("daemon child mutex poisoned")
        .as_ref()
        .map(CommandChild::pid);
    let error = state
        .error
        .lock()
        .expect("daemon error mutex poisoned")
        .clone();

    DaemonStatus {
        running: pid.is_some(),
        pid,
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
    std::env::current_dir()
        .map(|path| path.join("codex-rich-presence"))
        .map_err(|err| err.to_string())
}
