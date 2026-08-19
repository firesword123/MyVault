#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code)]

#[path = "../core.rs"]
mod core;
#[path = "../gallery.rs"]
mod gallery;
#[path = "../module_protocol.rs"]
mod module_protocol;
#[path = "../storage.rs"]
mod storage;

use serde_json::Value;
use std::{path::PathBuf, sync::Arc, thread, time::Duration};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window};
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{OpenProcess, WaitForSingleObject},
};

const MODULE_ID: &str = "gallery";

struct LaunchArgs {
    data_root: PathBuf,
    module: String,
    session: String,
    parent_pid: u32,
    pipe: String,
}

fn main() {
    let args =
        parse_args().unwrap_or_else(|error| panic!("invalid Gallery launch arguments: {error}"));
    if args.module != MODULE_ID {
        panic!("invalid Gallery module id");
    }
    core::set_data_root_override(args.data_root.clone())
        .unwrap_or_else(|error| panic!("failed to configure Gallery data root: {error}"));

    tauri::Builder::default()
        .manage(gallery::GalleryState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            core::ensure_gallery_layout(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let webview_data = app
                .path()
                .app_local_data_dir()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?
                .join("webview")
                .join("gallery");
            WebviewWindowBuilder::new(app, "gallery", WebviewUrl::App("gallery.html".into()))
                .title("MyVault 图库")
                .inner_size(1180.0, 780.0)
                .min_inner_size(860.0, 600.0)
                .decorations(false)
                .visible(false)
                .data_directory(webview_data)
                .build()?;

            start_parent_monitor(app.handle().clone(), args.parent_pid);
            start_ipc(
                app.handle().clone(),
                args.pipe.clone(),
                args.session.clone(),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gallery::list_gallery,
            gallery::import_gallery,
            minimize_window,
            toggle_maximize_window,
            close_window,
            start_window_dragging
        ])
        .run(tauri::generate_context!(
            "gallery/tauri.conf.json",
            capabilities = ["capabilities/gallery.json"]
        ))
        .expect("error while running Gallery module");
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

fn start_ipc(app: AppHandle, pipe_name: String, session: String) {
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let pipe = Arc::new(module_protocol::connect_client(
                &pipe_name,
                Duration::from_secs(10),
            )?);
            let mut hello = module_protocol::base_message(&session, "hello");
            hello["module"] = MODULE_ID.into();
            hello["moduleVersion"] = env!("CARGO_PKG_VERSION").into();
            hello["pid"] = std::process::id().into();
            pipe.send(&hello)?;

            let mut ready = module_protocol::base_message(&session, "ready");
            ready["capabilities"] = serde_json::json!(["open", "focus", "shutdown"]);
            pipe.send(&ready)?;

            loop {
                let message = pipe.receive()?;
                validate_envelope(&message, &session)?;
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
                        let mut error = module_protocol::base_message(&session, "error");
                        error["code"] = "unknown_message".into();
                        error["message"] =
                            format!("unsupported message type: {message_type}").into();
                        pipe.send(&error)?;
                    }
                    None => return Err("module message type is missing".to_string()),
                }
            }
        })();

        if result.is_err() {
            app.exit(1);
        }
    });
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
        .get_webview_window("gallery")
        .ok_or_else(|| "Gallery window is unavailable".to_string())?;
    window
        .show()
        .map_err(|error| format!("failed to show Gallery window: {error}"))?;
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("failed to restore Gallery window: {error}"))?;
    }
    window
        .set_focus()
        .map_err(|error| format!("failed to focus Gallery window: {error}"))
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
                unsafe { CloseHandle(process) };
                app.exit(0);
                return;
            }
            if result != WAIT_TIMEOUT {
                unsafe { CloseHandle(process) };
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
        .map_err(|error| format!("failed to minimize Gallery window: {error}"))
}

#[tauri::command]
fn toggle_maximize_window(window: Window) -> Result<(), String> {
    let is_maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to query Gallery window state: {error}"))?;
    if is_maximized {
        window
            .unmaximize()
            .map_err(|error| format!("failed to restore Gallery window: {error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("failed to maximize Gallery window: {error}"))
    }
}

#[tauri::command]
fn close_window(window: Window) -> Result<(), String> {
    window
        .close()
        .map_err(|error| format!("failed to close Gallery window: {error}"))
}

#[tauri::command]
fn start_window_dragging(window: Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("failed to drag Gallery window: {error}"))
}
