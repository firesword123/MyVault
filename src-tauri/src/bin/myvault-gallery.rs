#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[allow(dead_code)]
#[path = "../core.rs"]
mod core;
#[path = "../gallery.rs"]
mod gallery;
#[allow(dead_code)]
#[path = "../module_protocol.rs"]
mod module_protocol;
#[path = "../module_runtime.rs"]
mod module_runtime;
#[allow(dead_code)]
#[path = "../storage.rs"]
mod storage;

use std::thread;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MODULE_ID: &str = "gallery";

fn main() {
    let args = module_runtime::parse_launch_args()
        .unwrap_or_else(|error| panic!("invalid Gallery launch arguments: {error}"));
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

            module_runtime::start_parent_monitor(app.handle().clone(), args.parent_pid);
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
            module_runtime::minimize_window,
            module_runtime::toggle_maximize_window,
            module_runtime::close_window,
            module_runtime::start_window_dragging
        ])
        .run(tauri::generate_context!(
            "gallery/tauri.conf.json",
            capabilities = ["capabilities/gallery.json"]
        ))
        .expect("error while running Gallery module");
}

fn start_ipc(app: AppHandle, pipe_name: String, session: String) {
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let pipe = module_runtime::connect_to_host(
                &pipe_name,
                &session,
                MODULE_ID,
                &["open", "focus", "shutdown"],
            )?;

            loop {
                let message = pipe.receive()?;
                match module_runtime::handle_host_message(
                    &app, &pipe, &session, "gallery", &message,
                )? {
                    module_runtime::HostMessageAction::Continue => {}
                    module_runtime::HostMessageAction::Exit(code) => {
                        app.exit(code);
                        return Ok(());
                    }
                }
            }
        })();

        if result.is_err() {
            app.exit(1);
        }
    });
}
