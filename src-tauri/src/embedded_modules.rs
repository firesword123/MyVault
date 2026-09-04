//! Native child WebViews. Each releasable module owns a different WebView2 UDF;
//! closing a child releases its controller, renderer group, and profile resources.
use serde::Deserialize;
use std::{collections::HashMap, path::PathBuf};
use tauri::{
    async_runtime::Mutex, webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize,
    Manager, Rect, State, Webview, WebviewUrl,
};

pub(crate) struct EmbeddedModules {
    active: Mutex<Option<String>>,
    guards: Mutex<HashMap<String, String>>,
    webview_root: PathBuf,
}

impl EmbeddedModules {
    pub(crate) fn new(webview_root: PathBuf) -> Self {
        Self {
            active: Mutex::new(None),
            guards: Mutex::new(HashMap::new()),
            webview_root,
        }
    }
}

fn module_label(module: &str) -> Result<&'static str, String> {
    match module {
        "asmr" => Ok("embedded-asmr"),
        "gallery" => Ok("embedded-gallery"),
        _ => Err("unknown embedded module".into()),
    }
}

fn require_shell(caller: &Webview) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("only the shell may manage embedded WebViews".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Deserialize)]
pub(crate) struct ModuleBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl ModuleBounds {
    fn validate(self) -> Result<Self, String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|v| !v.is_finite())
            || self.x < 0.0
            || self.y < 30.0
            || self.width < 1.0
            || self.height < 1.0
            || self.width > 32768.0
            || self.height > 32768.0
        {
            return Err("invalid module content bounds".into());
        }
        Ok(self)
    }

    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        }
    }
}

#[tauri::command]
pub(crate) async fn switch_embedded_module(
    app: AppHandle,
    caller: Webview,
    state: State<'_, EmbeddedModules>,
    module: Option<String>,
    bounds: ModuleBounds,
) -> Result<(), String> {
    require_shell(&caller)?;
    let bounds = bounds.validate()?;
    if let Some(module) = &module {
        module_label(module)?;
    }
    // Async commands are required by WebView2. Serialize close/create so fast
    // tab clicks cannot create two controllers or reuse a label before closing it.
    let mut active = state.active.lock().await;
    if *active == module {
        if let Some(module) = &module {
            if let Some(view) = app.get_webview(module_label(module)?) {
                return view.set_bounds(bounds.rect()).map_err(|e| e.to_string());
            }
        } else {
            return Ok(());
        }
    }
    if let Some(previous) = active.as_ref() {
        if let Some(reason) = state.guards.lock().await.get(module_label(previous)?) {
            return Err(reason.clone());
        }
        if let Some(view) = app.get_webview(module_label(previous)?) {
            view.close()
                .map_err(|e| format!("failed to close {previous}: {e}"))?;
        }
        if previous == "gallery" {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::gallery::release_catalog(&app.state::<crate::gallery::GalleryState>())
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        state.guards.lock().await.remove(module_label(previous)?);
    }
    *active = None;
    if let Some(module) = module {
        let label = module_label(&module)?;
        let data_directory = state.webview_root.join(&module);
        std::fs::create_dir_all(&data_directory).map_err(|e| e.to_string())?;
        let window = app.get_window("main").ok_or("main window is unavailable")?;
        let builder = WebviewBuilder::new(
            label,
            WebviewUrl::App(format!("{module}.html?embedded=1").into()),
        )
        .data_directory(data_directory)
        .disable_drag_drop_handler();
        let view = window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|e| format!("failed to create {module} WebView: {e}"))?;
        *active = Some(module.clone());
        let _ = view.set_focus();
    } else {
        let _ = caller.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn embedded_module_status(
    caller: Webview,
    state: State<'_, EmbeddedModules>,
) -> Result<Option<String>, String> {
    require_shell(&caller)?;
    Ok(state.active.lock().await.clone())
}

#[tauri::command]
pub(crate) async fn set_embedded_module_guard(
    caller: Webview,
    state: State<'_, EmbeddedModules>,
    reason: Option<String>,
) -> Result<(), String> {
    if !matches!(caller.label(), "embedded-asmr" | "embedded-gallery") {
        return Err("only embedded modules may set a close guard".into());
    }
    let mut guards = state.guards.lock().await;
    if let Some(reason) = reason {
        guards.insert(caller.label().to_owned(), reason);
    } else {
        guards.remove(caller.label());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn resize_embedded_module(
    app: AppHandle,
    caller: Webview,
    state: State<'_, EmbeddedModules>,
    bounds: ModuleBounds,
) -> Result<(), String> {
    require_shell(&caller)?;
    let bounds = bounds.validate()?;
    let active = state.active.lock().await;
    if let Some(module) = active.as_ref() {
        if let Some(view) = app.get_webview(module_label(module)?) {
            view.set_bounds(bounds.rect()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn request_main_playback(
    app: AppHandle,
    caller: Webview,
    request: serde_json::Value,
) -> Result<(), String> {
    if caller.label() != "embedded-asmr" {
        return Err("only DL_ASMR may submit a playback queue".into());
    }
    crate::player::validate_player_queue(&app, &request)?;
    crate::player::replace_queue(&app, request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_protect_titlebar_and_reject_invalid_sizes() {
        let valid = ModuleBounds {
            x: 0.0,
            y: 38.0,
            width: 1093.0,
            height: 733.0,
        };
        assert!(valid.validate().is_ok());
        for value in [0.0, -1.0, f64::NAN, f64::INFINITY, 40000.0] {
            assert!(ModuleBounds {
                width: value,
                ..valid
            }
            .validate()
            .is_err());
        }
        assert!(ModuleBounds { y: 0.0, ..valid }.validate().is_err());
    }

    #[test]
    fn modules_have_distinct_labels_and_profiles() {
        assert_ne!(
            module_label("asmr").unwrap(),
            module_label("gallery").unwrap()
        );
        assert!(module_label("../shell").is_err());
        let root = PathBuf::from("WebViews");
        assert_ne!(root.join("asmr"), root.join("gallery"));
        assert_ne!(root.join("shell"), root.join("asmr"));
    }
}
