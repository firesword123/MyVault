mod core;
mod module_launcher;
mod module_protocol;
mod notes;
mod player;
mod storage;

use crate::core::{
    apply_network_settings, default_close_behavior, ensure_vault_layout, load_settings,
};
use std::path::PathBuf;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, Window, WindowEvent,
};

fn tray_icon_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("icons")
        .join("icon.ico")
}

fn hide_window_to_tray(window: &Window) -> Result<(), String> {
    window
        .hide()
        .map_err(|error| format!("failed to hide window: {error}"))?;
    Ok(())
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .show()
        .map_err(|error| format!("failed to show window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus window: {error}"))?;
    Ok(())
}

fn close_behavior(app: &AppHandle) -> String {
    load_settings(app)
        .map(|settings| settings.close_behavior)
        .unwrap_or_else(|_| default_close_behavior())
}

fn handle_close_action(window: &Window) -> Result<(), String> {
    if window.label() != "main" {
        return window
            .close()
            .map_err(|error| format!("failed to close window: {error}"));
    }
    let app = window.app_handle();
    if close_behavior(&app) == "tray" {
        hide_window_to_tray(window)
    } else {
        window
            .close()
            .map_err(|error| format!("failed to close window: {error}"))
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, "tray_show", "Show MyVault", true, None::<&str>)
        .map_err(|error| format!("failed to create tray show item: {error}"))?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)
        .map_err(|error| format!("failed to create tray quit item: {error}"))?;
    let menu = Menu::with_items(app, &[&show, &quit])
        .map_err(|error| format!("failed to create tray menu: {error}"))?;
    let icon = Image::from_path(tray_icon_path())
        .map_err(|error| format!("failed to load tray icon: {error}"))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => {
                let _ = show_main_window(app);
            }
            "tray_quit" => {
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
                let _ = show_main_window(&tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| format!("failed to build tray icon: {error}"))?;

    Ok(())
}

#[tauri::command]
fn minimize_window(window: Window) -> Result<(), String> {
    let _ = window.emit("app:minimize", ());
    window
        .minimize()
        .map_err(|error| format!("failed to minimize window: {error}"))
}

#[tauri::command]
fn toggle_maximize_window(window: Window) -> Result<(), String> {
    let is_maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to query maximize state: {error}"))?;

    if is_maximized {
        window
            .unmaximize()
            .map_err(|error| format!("failed to restore window: {error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("failed to maximize window: {error}"))
    }
}

#[tauri::command]
fn close_window(window: Window) -> Result<(), String> {
    handle_close_action(&window)
}

#[tauri::command]
fn start_window_dragging(window: Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("failed to start dragging: {error}"))
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(include_str!("../../updater.key.pub").trim())
                .build(),
        )
        .setup(|app| {
            ensure_vault_layout(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let module_manager = module_launcher::ModuleManager::new()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            app.manage(module_manager);
            app.manage(player::PlayerState::default());
            let settings = load_settings(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            apply_network_settings(&settings);
            setup_tray(app.handle()).map_err(Into::into)
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && close_behavior(&window.app_handle()) == "tray" {
                    api.prevent_close();
                    let _ = hide_window_to_tray(window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            notes::bootstrap_app,
            core::get_settings,
            core::get_resource_usage,
            core::update_settings,
            notes::update_notes_state,
            module_launcher::launch_asmr_module,
            module_launcher::launch_gallery_module,
            player::bootstrap_player,
            player::clear_player_queue,
            player::read_player_subtitle,
            player::trim_player_memory,
            notes::list_notes,
            notes::list_workspace,
            notes::load_note,
            notes::create_note,
            notes::create_folder,
            notes::rename_folder,
            notes::delete_folder,
            notes::save_note,
            notes::trash_note,
            notes::restore_note,
            notes::delete_note,
            notes::discard_draft_note,
            notes::empty_trash,
            notes::move_note,
            minimize_window,
            toggle_maximize_window,
            close_window,
            start_window_dragging
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(manager) = app_handle.try_state::<module_launcher::ModuleManager>() {
                manager.shutdown_all();
            }
        }
    });
}
