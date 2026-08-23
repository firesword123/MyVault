use crate::module_protocol;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, thread, time::Duration};
use tauri::{AppHandle, Manager, Window};
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{OpenProcess, WaitForSingleObject},
};

pub(crate) struct LaunchArgs {
    pub(crate) data_root: PathBuf,
    pub(crate) module: String,
    pub(crate) session: String,
    pub(crate) parent_pid: u32,
    pub(crate) pipe: String,
}

pub(crate) enum HostMessageAction {
    Continue,
    Exit(i32),
}

pub(crate) fn parse_launch_args() -> Result<LaunchArgs, String> {
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

pub(crate) fn connect_to_host(
    pipe_name: &str,
    session: &str,
    module_id: &str,
    capabilities: &[&str],
) -> Result<Arc<module_protocol::PipeHandle>, String> {
    let pipe = Arc::new(module_protocol::connect_client(
        pipe_name,
        Duration::from_secs(10),
    )?);
    let mut hello = module_protocol::base_message(session, "hello");
    hello["module"] = module_id.into();
    hello["moduleVersion"] = env!("CARGO_PKG_VERSION").into();
    hello["pid"] = std::process::id().into();
    pipe.send(&hello)?;

    let mut ready = module_protocol::base_message(session, "ready");
    ready["capabilities"] = serde_json::json!(capabilities);
    pipe.send(&ready)?;
    Ok(pipe)
}

pub(crate) fn handle_host_message(
    app: &AppHandle,
    pipe: &module_protocol::PipeHandle,
    session: &str,
    window_label: &str,
    message: &Value,
) -> Result<HostMessageAction, String> {
    validate_envelope(message, session)?;
    match message.get("type").and_then(Value::as_str) {
        Some("open") | Some("focus") => {
            focus_window(app, window_label)?;
            Ok(HostMessageAction::Continue)
        }
        Some("shutdown") => Ok(HostMessageAction::Exit(0)),
        Some("error") => Ok(HostMessageAction::Exit(1)),
        Some(message_type) => {
            let mut error = module_protocol::base_message(session, "error");
            error["code"] = "unknown_message".into();
            error["message"] = format!("unsupported message type: {message_type}").into();
            pipe.send(&error)?;
            Ok(HostMessageAction::Continue)
        }
        None => Err("module message type is missing".to_string()),
    }
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

fn focus_window(app: &AppHandle, window_label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(window_label)
        .ok_or_else(|| format!("module window {window_label} is unavailable"))?;
    window
        .show()
        .map_err(|error| format!("failed to show module window: {error}"))?;
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("failed to restore module window: {error}"))?;
    }
    window
        .set_focus()
        .map_err(|error| format!("failed to focus module window: {error}"))
}

pub(crate) fn start_parent_monitor(app: AppHandle, parent_pid: u32) {
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
pub(crate) fn minimize_window(window: Window) -> Result<(), String> {
    window
        .minimize()
        .map_err(|error| format!("failed to minimize module window: {error}"))
}

#[tauri::command]
pub(crate) fn toggle_maximize_window(window: Window) -> Result<(), String> {
    let is_maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to query module window state: {error}"))?;
    if is_maximized {
        window
            .unmaximize()
            .map_err(|error| format!("failed to restore module window: {error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("failed to maximize module window: {error}"))
    }
}

#[tauri::command]
pub(crate) fn close_window(window: Window) -> Result<(), String> {
    window
        .close()
        .map_err(|error| format!("failed to close module window: {error}"))
}

#[tauri::command]
pub(crate) fn start_window_dragging(window: Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("failed to drag module window: {error}"))
}
