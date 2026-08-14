#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code)]

#[path = "../asmr.rs"]
mod asmr;
#[path = "../core.rs"]
mod core;
#[path = "../module_protocol.rs"]
mod module_protocol;
#[path = "../storage.rs"]
mod storage;

use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{OpenProcess, WaitForSingleObject},
};

struct LaunchArgs {
    data_root: PathBuf,
    module: String,
    session: String,
    parent_pid: u32,
    pipe: String,
}

#[derive(Clone)]
struct MainConnection {
    session: String,
    pipe: Arc<Mutex<Option<Arc<module_protocol::PipeHandle>>>>,
}

fn main() {
    let args =
        parse_args().unwrap_or_else(|error| panic!("invalid DL_ASMR launch arguments: {error}"));
    if args.module != module_protocol::MODULE_ID {
        panic!("invalid DL_ASMR module id");
    }
    core::set_data_root_override(args.data_root.clone())
        .unwrap_or_else(|error| panic!("failed to configure DL_ASMR data root: {error}"));
    let connection = MainConnection {
        session: args.session.clone(),
        pipe: Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .manage(connection.clone())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            core::ensure_asmr_layout(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let webview_data = app
                .path()
                .app_local_data_dir()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?
                .join("webview")
                .join("dl_asmr");
            WebviewWindowBuilder::new(app, "asmr", WebviewUrl::App("asmr.html".into()))
                .title("MyVault DL_ASMR")
                .inner_size(1180.0, 780.0)
                .min_inner_size(900.0, 620.0)
                .decorations(false)
                .visible(false)
                .data_directory(webview_data)
                .build()?;

            start_parent_monitor(app.handle().clone(), args.parent_pid);
            start_ipc(app.handle().clone(), args.pipe.clone(), connection.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            asmr::bootstrap_asmr,
            asmr::preview_asmr_import,
            asmr::import_asmr_work,
            asmr::update_asmr_work,
            asmr::upsert_asmr_dictionary,
            asmr::delete_asmr_dictionary,
            asmr::list_asmr_folder,
            asmr::update_asmr_playback,
            asmr::set_asmr_cover,
            asmr::read_asmr_text_file,
            request_main_playback,
            minimize_window,
            toggle_maximize_window,
            close_window,
            start_window_dragging
        ])
        .run(tauri::generate_context!(
            "asmr/tauri.conf.json",
            capabilities = ["capabilities/asmr.json"]
        ))
        .expect("error while running DL_ASMR module");
}

fn parse_args() -> Result<LaunchArgs, String> {
    let mut data_root = None;
    let mut module = None;
    let mut session = None;
    let mut parent_pid = None;
    let mut pipe = None;
    let mut args = std::env::args_os().skip(1);

    while let Some(name) = args.next() {
        let name = name.to_string_lossy();
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {name}"))?;
        match name.as_ref() {
            "--data-root" => data_root = Some(PathBuf::from(value)),
            "--module" => module = Some(value.to_string_lossy().into_owned()),
            "--session" => session = Some(value.to_string_lossy().into_owned()),
            "--parent-pid" => {
                parent_pid = Some(
                    value
                        .to_string_lossy()
                        .parse::<u32>()
                        .map_err(|_| "parent pid must be an integer".to_string())?,
                )
            }
            "--pipe" => pipe = Some(value.to_string_lossy().into_owned()),
            _ => return Err(format!("unknown argument {name}")),
        }
    }

    let data_root = data_root.ok_or_else(|| "--data-root is required".to_string())?;
    if !data_root.is_absolute() {
        return Err("--data-root must be an absolute path".to_string());
    }
    Ok(LaunchArgs {
        data_root,
        module: module.ok_or_else(|| "--module is required".to_string())?,
        session: session.ok_or_else(|| "--session is required".to_string())?,
        parent_pid: parent_pid.ok_or_else(|| "--parent-pid is required".to_string())?,
        pipe: pipe.ok_or_else(|| "--pipe is required".to_string())?,
    })
}

fn start_ipc(app: AppHandle, pipe_name: String, connection: MainConnection) {
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let pipe = Arc::new(module_protocol::connect_client(
                &pipe_name,
                Duration::from_secs(10),
            )?);
            *connection
                .pipe
                .lock()
                .map_err(|_| "main connection registry is poisoned".to_string())? =
                Some(pipe.clone());
            let mut hello = module_protocol::base_message(&connection.session, "hello");
            hello["module"] = module_protocol::MODULE_ID.into();
            hello["moduleVersion"] = env!("CARGO_PKG_VERSION").into();
            hello["pid"] = std::process::id().into();
            pipe.send(&hello)?;

            let mut ready = module_protocol::base_message(&connection.session, "ready");
            ready["capabilities"] =
                serde_json::json!(["open", "focus", "shutdown", "player.replace_queue"]);
            pipe.send(&ready)?;

            loop {
                let message = pipe.receive()?;
                validate_envelope(&message, &connection.session)?;
                match message.get("type").and_then(Value::as_str) {
                    Some("open") | Some("focus") => focus_window(&app)?,
                    Some("shutdown") => {
                        app.exit(0);
                        return Ok(());
                    }
                    Some("error") => {
                        app.exit(1);
                        return Ok(());
                    }
                    Some(message_type) => {
                        let mut error = module_protocol::base_message(&connection.session, "error");
                        error["code"] = "unknown_message".into();
                        error["message"] =
                            format!("unsupported message type: {message_type}").into();
                        pipe.send(&error)?;
                    }
                    None => return Err("module message type is missing".to_string()),
                }
            }
        })();

        if let Ok(mut slot) = connection.pipe.lock() {
            *slot = None;
        }

        if result.is_err() {
            app.exit(1);
        }
    });
}

#[tauri::command]
fn request_main_playback(
    connection: State<'_, MainConnection>,
    request: Value,
) -> Result<(), String> {
    validate_playback_request(&request)?;
    let pipe = connection
        .pipe
        .lock()
        .map_err(|_| "main connection registry is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "main player is not connected".to_string())?;
    let mut message = module_protocol::base_message(&connection.session, "player.replace_queue");
    message["payload"] = request;
    pipe.send(&message)
}

fn validate_playback_request(request: &Value) -> Result<(), String> {
    let tracks = request
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or_else(|| "playback tracks are missing".to_string())?;
    let start_index = request
        .get("startIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| "playback start index is missing".to_string())?
        as usize;
    if tracks.is_empty() || tracks.len() > 2_000 || start_index >= tracks.len() {
        return Err("invalid playback queue".to_string());
    }
    Ok(())
}

fn validate_envelope(message: &Value, session: &str) -> Result<(), String> {
    if message.get("version").and_then(Value::as_u64) != Some(module_protocol::PROTOCOL_VERSION) {
        return Err("module protocol version mismatch".to_string());
    }
    if message.get("session").and_then(Value::as_str) != Some(session) {
        return Err("module session mismatch".to_string());
    }
    if message.get("requestId").and_then(Value::as_str).is_none() {
        return Err("module request id is missing".to_string());
    }
    Ok(())
}

fn focus_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("asmr")
        .ok_or_else(|| "DL_ASMR window is unavailable".to_string())?;
    window
        .show()
        .map_err(|error| format!("failed to show DL_ASMR window: {error}"))?;
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("failed to restore DL_ASMR window: {error}"))?;
    }
    window
        .set_focus()
        .map_err(|error| format!("failed to focus DL_ASMR window: {error}"))
}

fn start_parent_monitor(app: AppHandle, parent_pid: u32) {
    thread::spawn(move || {
        let process = unsafe { OpenProcess(SYNCHRONIZE, 0, parent_pid) };
        if process.is_null() {
            app.exit(1);
            return;
        }
        loop {
            let result = unsafe { WaitForSingleObject(process, 1000) };
            if result == WAIT_OBJECT_0 {
                unsafe {
                    CloseHandle(process);
                }
                app.exit(0);
                return;
            }
            if result != WAIT_TIMEOUT {
                unsafe {
                    CloseHandle(process);
                }
                app.exit(1);
                return;
            }
        }
    });
}

#[tauri::command]
fn minimize_window(window: Window) -> Result<(), String> {
    window
        .minimize()
        .map_err(|error| format!("failed to minimize DL_ASMR window: {error}"))
}

#[tauri::command]
fn toggle_maximize_window(window: Window) -> Result<(), String> {
    let is_maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to query DL_ASMR window state: {error}"))?;
    if is_maximized {
        window
            .unmaximize()
            .map_err(|error| format!("failed to restore DL_ASMR window: {error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("failed to maximize DL_ASMR window: {error}"))
    }
}

#[tauri::command]
fn close_window(window: Window) -> Result<(), String> {
    window
        .close()
        .map_err(|error| format!("failed to close DL_ASMR window: {error}"))
}

#[tauri::command]
fn start_window_dragging(window: Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("failed to drag DL_ASMR window: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_bounded_player_queue() {
        let request = serde_json::json!({
            "source": "dl_asmr",
            "startIndex": 0,
            "tracks": [{
                "id": "RJ1:track.mp3",
                "title": "track.mp3",
                "workId": "RJ1",
                "workTitle": "Work",
                "absolutePath": "C:\\Vault\\asmr\\RJ1\\track.mp3",
                "relativePath": "track.mp3",
                "subtitlePath": "track.mp3.vtt"
            }]
        });
        assert!(validate_playback_request(&request).is_ok());
    }

    #[test]
    fn rejects_an_out_of_range_player_index() {
        let request = serde_json::json!({
            "source": "dl_asmr",
            "startIndex": 1,
            "tracks": [{"id": "one"}]
        });
        assert_eq!(
            validate_playback_request(&request),
            Err("invalid playback queue".to_string())
        );
    }
}
