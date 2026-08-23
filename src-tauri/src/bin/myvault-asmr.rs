#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[path = "../asmr.rs"]
mod asmr;
#[allow(dead_code)]
#[path = "../core.rs"]
mod core;
#[allow(dead_code)]
#[path = "../module_protocol.rs"]
mod module_protocol;
#[path = "../module_runtime.rs"]
mod module_runtime;
#[allow(dead_code)]
#[path = "../storage.rs"]
mod storage;

use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
struct MainConnection {
    session: String,
    pipe: Arc<Mutex<Option<Arc<module_protocol::PipeHandle>>>>,
}

fn main() {
    let args = module_runtime::parse_launch_args()
        .unwrap_or_else(|error| panic!("invalid DL_ASMR launch arguments: {error}"));
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

            module_runtime::start_parent_monitor(app.handle().clone(), args.parent_pid);
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
            module_runtime::minimize_window,
            module_runtime::toggle_maximize_window,
            module_runtime::close_window,
            module_runtime::start_window_dragging
        ])
        .run(tauri::generate_context!(
            "asmr/tauri.conf.json",
            capabilities = ["capabilities/asmr.json"]
        ))
        .expect("error while running DL_ASMR module");
}

fn start_ipc(app: AppHandle, pipe_name: String, connection: MainConnection) {
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let pipe = module_runtime::connect_to_host(
                &pipe_name,
                &connection.session,
                module_protocol::MODULE_ID,
                &["open", "focus", "shutdown", "player.replace_queue"],
            )?;
            *connection
                .pipe
                .lock()
                .map_err(|_| "main connection registry is poisoned".to_string())? =
                Some(pipe.clone());
            loop {
                let message = pipe.receive()?;
                match module_runtime::handle_host_message(
                    &app,
                    &pipe,
                    &connection.session,
                    "asmr",
                    &message,
                )? {
                    module_runtime::HostMessageAction::Continue => {}
                    module_runtime::HostMessageAction::Exit(code) => {
                        app.exit(code);
                        return Ok(());
                    }
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
