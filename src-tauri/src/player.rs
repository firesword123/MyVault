use serde::Deserialize;
use serde_json::Value;
use std::{path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_SUBTITLE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayerSubtitleInput {
    work_id: String,
    relative_path: String,
}

#[derive(Default)]
pub(crate) struct PlayerState {
    queue: Mutex<Option<Value>>,
}

#[tauri::command]
pub(crate) fn bootstrap_player(state: State<'_, PlayerState>) -> Result<Option<Value>, String> {
    state
        .queue
        .lock()
        .map(|queue| queue.clone())
        .map_err(|_| "player queue registry is poisoned".to_string())
}

#[tauri::command]
pub(crate) fn clear_player_queue(state: State<'_, PlayerState>) -> Result<(), String> {
    *state
        .queue
        .lock()
        .map_err(|_| "player queue registry is poisoned".to_string())? = None;
    Ok(())
}

pub(crate) fn validate_player_queue(app: &AppHandle, payload: &Value) -> Result<(), String> {
    let tracks = payload
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or_else(|| "player queue tracks are missing".to_string())?;
    if tracks.is_empty() || tracks.len() > 2_000 {
        return Err("player queue must contain between 1 and 2000 tracks".to_string());
    }
    let start_index = payload
        .get("startIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| "player queue start index is missing".to_string())?
        as usize;
    if start_index >= tracks.len() {
        return Err("player queue start index is out of range".to_string());
    }
    let vault = crate::core::vault_dir(app)?
        .canonicalize()
        .map_err(|error| format!("failed to resolve Vault path: {error}"))?;
    for track in tracks {
        for field in [
            "id",
            "title",
            "workId",
            "workTitle",
            "absolutePath",
            "relativePath",
        ] {
            if track
                .get(field)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err(format!("player queue track field {field} is missing"));
            }
        }
        let absolute_path = std::path::PathBuf::from(
            track
                .get("absolutePath")
                .and_then(Value::as_str)
                .expect("absolutePath was validated"),
        )
        .canonicalize()
        .map_err(|error| format!("failed to resolve playback file: {error}"))?;
        if !absolute_path.starts_with(&vault) || !absolute_path.is_file() {
            return Err("player queue track is outside the active Vault".to_string());
        }
        if let Some(subtitle_path) = track.get("subtitlePath").and_then(Value::as_str) {
            let normalized = subtitle_path.replace('\\', "/");
            let path = Path::new(&normalized);
            if normalized.is_empty()
                || path.is_absolute()
                || normalized
                    .split('/')
                    .any(|segment| segment.is_empty() || segment == "." || segment == "..")
            {
                return Err("player queue subtitle path is invalid".to_string());
            }
        }
    }
    Ok(())
}

fn normalize_work_id(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() > 2
        && value.starts_with("RJ")
        && value[2..].bytes().all(|byte| byte.is_ascii_digit())
    {
        Ok(value)
    } else {
        Err("invalid DL_ASMR work id".to_string())
    }
}

fn normalize_relative_path(value: &str) -> Result<String, String> {
    let value = value.trim().trim_matches('/').replace('\\', "/");
    let path = Path::new(&value);
    let valid = !value.is_empty()
        && !path.is_absolute()
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)));
    if valid {
        Ok(value)
    } else {
        Err("invalid subtitle path".to_string())
    }
}

#[tauri::command]
pub(crate) fn read_player_subtitle(
    app: AppHandle,
    input: PlayerSubtitleInput,
) -> Result<String, String> {
    let work_id = normalize_work_id(&input.work_id)?;
    let relative_path = normalize_relative_path(&input.relative_path)?;
    let extension = Path::new(&relative_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "vtt" | "srt" | "lrc" | "ass" | "ssa") {
        return Err("unsupported subtitle format".to_string());
    }

    let work_root = crate::core::data_root_dir(&app)?
        .join("DL_ASMR")
        .join(work_id)
        .canonicalize()
        .map_err(|error| format!("failed to resolve DL_ASMR work path: {error}"))?;
    let subtitle = work_root
        .join(relative_path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve subtitle path: {error}"))?;
    if !subtitle.starts_with(&work_root) || !subtitle.is_file() {
        return Err("subtitle is outside the selected DL_ASMR work".to_string());
    }
    let length = subtitle
        .metadata()
        .map_err(|error| format!("failed to inspect subtitle: {error}"))?
        .len();
    if length > MAX_SUBTITLE_BYTES {
        return Err("subtitle exceeds the 16 MiB limit".to_string());
    }
    crate::core::read_utf8_file(&subtitle)
}

pub(crate) fn replace_queue(app: &AppHandle, payload: Value) -> Result<(), String> {
    let state = app
        .try_state::<PlayerState>()
        .ok_or_else(|| "player state is unavailable".to_string())?;
    *state
        .queue
        .lock()
        .map_err(|_| "player queue registry is poisoned".to_string())? = Some(payload.clone());

    app.emit_to("main", "player:replace-queue", payload)
        .map_err(|error| format!("failed to forward player queue: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_player_subtitle_identifiers() {
        assert_eq!(normalize_work_id("rj123").unwrap(), "RJ123");
        assert!(normalize_work_id("RJ").is_err());
        assert_eq!(
            normalize_relative_path(r"folder\track.mp3.vtt").unwrap(),
            "folder/track.mp3.vtt"
        );
        assert!(normalize_relative_path("../outside.vtt").is_err());
    }
}
