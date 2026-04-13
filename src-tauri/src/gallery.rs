use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

use super::{ensure_vault_layout, images_dir, now_ts, write_utf8_file};
const GALLERY_TRASH_FOLDER: &str = "trash";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GalleryBootstrapPayload {
    images_root_path: String,
    images: Vec<GalleryImageEntry>,
    folders: Vec<String>,
    tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GalleryWorkspacePayload {
    images: Vec<GalleryImageEntry>,
    folders: Vec<String>,
    tags: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GalleryImageEntry {
    id: String,
    file_name: String,
    relative_path: String,
    folder_path: String,
    absolute_path: String,
    file_size: u64,
    updated_at: u64,
    tags: Vec<String>,
    note: String,
    is_trashed: bool,
    original_folder_path: Option<String>,
    deleted_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GalleryImageMeta {
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    note: String,
    #[serde(default = "now_ts")]
    imported_at: u64,
    #[serde(default = "now_ts")]
    updated_at: u64,
    #[serde(default)]
    original_folder_path: Option<String>,
    #[serde(default)]
    deleted_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateImageFolderInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameImageFolderInput {
    from_path: String,
    to_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteImageFolderInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportGalleryFileInput {
    file_name: String,
    #[serde(default)]
    folder_path: String,
    relative_parent_path: Option<String>,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateGalleryImageMetaInput {
    id: String,
    tags: Vec<String>,
    note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveGalleryImageInput {
    id: String,
    folder_path: String,
}

fn ensure_gallery_layout(app: &AppHandle) -> Result<(), String> {
    ensure_vault_layout(app)?;
    fs::create_dir_all(images_dir(app)?.join(GALLERY_TRASH_FOLDER))
        .map_err(|error| format!("failed to prepare gallery trash: {error}"))?;
    Ok(())
}

fn gallery_trash_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(images_dir(app)?.join(GALLERY_TRASH_FOLDER))
}

fn is_protected_gallery_folder_path(path: &str) -> bool {
    path == GALLERY_TRASH_FOLDER || path.starts_with(&format!("{GALLERY_TRASH_FOLDER}/"))
}

fn normalize_gallery_folder_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().trim_matches('/').replace('\\', "/");
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let valid = trimmed
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..");

    if valid {
        Ok(trimmed)
    } else {
        Err("invalid gallery folder path".to_string())
    }
}

fn normalize_gallery_relative_path(path: &str) -> Result<String, String> {
    let normalized = normalize_gallery_folder_path(path)?;
    if normalized.is_empty() {
        Err("image not found".to_string())
    } else {
        Ok(normalized)
    }
}

fn sanitize_file_name(raw: &str) -> String {
    let candidate = Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let cleaned = candidate
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => ch,
        })
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "image".to_string()
    } else {
        cleaned
    }
}

fn is_supported_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "avif")
    )
}

fn compose_gallery_folder_path(folder_path: &str, relative_parent_path: Option<&str>) -> Result<String, String> {
    let base = normalize_gallery_folder_path(folder_path)?;
    let extra = normalize_gallery_folder_path(relative_parent_path.unwrap_or_default())?;

    match (base.is_empty(), extra.is_empty()) {
        (true, true) => Ok(String::new()),
        (false, true) => Ok(base),
        (true, false) => Ok(extra),
        (false, false) => Ok(format!("{base}/{extra}")),
    }
}

fn gallery_folder_path_from_image_path(app: &AppHandle, path: &Path) -> Result<String, String> {
    let root = images_dir(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve image parent directory".to_string())?;
    let relative = parent
        .strip_prefix(&root)
        .map_err(|error| format!("failed to resolve gallery folder path: {error}"))?;

    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn image_relative_path(app: &AppHandle, path: &Path) -> Result<String, String> {
    let root = images_dir(app)?;
    path.strip_prefix(&root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|error| format!("failed to resolve image path: {error}"))
}

fn image_meta_path(image_path: &Path) -> Result<PathBuf, String> {
    let file_name = image_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "failed to resolve image filename".to_string())?;
    Ok(image_path.with_file_name(format!("{file_name}.meta.json")))
}

fn read_gallery_meta(image_path: &Path) -> Result<GalleryImageMeta, String> {
    let path = image_meta_path(image_path)?;
    if !path.exists() {
        return Ok(GalleryImageMeta::default());
    }

    let raw = fs::read_to_string(&path).map_err(|error| format!("failed to read image meta: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("failed to parse image meta: {error}"))
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = tags
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    normalized.sort_by_key(|value| value.to_ascii_lowercase());
    normalized.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    normalized
}

fn write_gallery_meta(image_path: &Path, meta: &GalleryImageMeta) -> Result<(), String> {
    let mut next = meta.clone();
    next.tags = normalize_tags(&next.tags);
    next.updated_at = now_ts();
    if next.imported_at == 0 {
        next.imported_at = next.updated_at;
    }

    let raw = serde_json::to_string_pretty(&next)
        .map_err(|error| format!("failed to serialize image meta: {error}"))?;
    write_utf8_file(&image_meta_path(image_path)?, &raw)
        .map_err(|error| format!("failed to write image meta: {error}"))
}

fn gallery_entry_from_path(app: &AppHandle, path: &Path) -> Result<GalleryImageEntry, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("failed to stat image: {error}"))?;
    let meta = read_gallery_meta(path)?;
    let relative_path = image_relative_path(app, path)?;
    let folder_path = gallery_folder_path_from_image_path(app, path)?;
    let is_trashed = folder_path == GALLERY_TRASH_FOLDER;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "failed to resolve image filename".to_string())?
        .to_string();

    Ok(GalleryImageEntry {
        id: relative_path.clone(),
        file_name,
        relative_path,
        folder_path,
        absolute_path: path.display().to_string(),
        file_size: metadata.len(),
        updated_at: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(meta.updated_at),
        tags: meta.tags,
        note: meta.note,
        is_trashed,
        original_folder_path: meta.original_folder_path,
        deleted_at: meta.deleted_at,
    })
}

fn collect_gallery_images(app: &AppHandle) -> Result<Vec<GalleryImageEntry>, String> {
    let root = images_dir(app)?;
    let mut directories = vec![root];
    let mut images = Vec::new();

    while let Some(current_dir) = directories.pop() {
        let entries = fs::read_dir(&current_dir)
            .map_err(|error| format!("failed to read images dir: {error}"))?;

        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read image entry: {error}"))?;
            let path = entry.path();

            if path.is_dir() {
                directories.push(path);
                continue;
            }

            let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
            if file_name.ends_with(".meta.json") || !is_supported_image_path(&path) {
                continue;
            }

            images.push(gallery_entry_from_path(app, &path)?);
        }
    }

    images.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok(images)
}

fn collect_gallery_folders(app: &AppHandle) -> Result<Vec<String>, String> {
    let root = images_dir(app)?;
    let mut directories = vec![root.clone()];
    let mut folders = Vec::new();

    while let Some(current_dir) = directories.pop() {
        let entries = fs::read_dir(&current_dir)
            .map_err(|error| format!("failed to read gallery folders: {error}"))?;

        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read gallery folder entry: {error}"))?;
            let path = entry.path();

            if !path.is_dir() {
                continue;
            }

            let relative = path
                .strip_prefix(&root)
                .map_err(|error| format!("failed to resolve gallery folder: {error}"))?;
            let folder = relative.to_string_lossy().replace('\\', "/");
            if !folder.is_empty() && !is_protected_gallery_folder_path(&folder) {
                folders.push(folder);
            }
            directories.push(path);
        }
    }

    folders.sort();
    folders.dedup();
    Ok(folders)
}

fn collect_gallery_tags(images: &[GalleryImageEntry]) -> Vec<String> {
    let mut tags = images
        .iter()
        .flat_map(|image| image.tags.iter().cloned())
        .collect::<Vec<_>>();
    tags.sort_by_key(|value| value.to_ascii_lowercase());
    tags.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    tags
}

fn gallery_workspace_payload(app: &AppHandle) -> Result<GalleryWorkspacePayload, String> {
    let images = collect_gallery_images(app)?;
    Ok(GalleryWorkspacePayload {
        folders: collect_gallery_folders(app)?,
        tags: collect_gallery_tags(&images),
        images,
    })
}

fn ensure_gallery_folder_exists(app: &AppHandle, folder_path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_gallery_folder_path(folder_path)?;
    if is_protected_gallery_folder_path(&normalized) {
        return Err("target gallery folder is not allowed".to_string());
    }
    let path = if normalized.is_empty() {
        images_dir(app)?
    } else {
        images_dir(app)?.join(normalized)
    };
    if !path.exists() {
        return Err("gallery folder not found".to_string());
    }
    Ok(path)
}

fn unique_target_path(target_dir: &Path, file_name: &str) -> PathBuf {
    let initial = target_dir.join(file_name);
    if !initial.exists() {
        return initial;
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    for index in 2.. {
        let candidate = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        let path = target_dir.join(candidate);
        if !path.exists() {
            return path;
        }
    }

    unreachable!()
}

fn find_gallery_image_path_by_id(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let relative_path = normalize_gallery_relative_path(id)?;
    let path = images_dir(app)?.join(relative_path);
    if path.exists() && path.is_file() && is_supported_image_path(&path) {
        Ok(path)
    } else {
        Err("image not found".to_string())
    }
}

#[tauri::command]
pub(crate) fn bootstrap_gallery(app: AppHandle) -> Result<GalleryBootstrapPayload, String> {
    ensure_gallery_layout(&app)?;
    let workspace = gallery_workspace_payload(&app)?;
    Ok(GalleryBootstrapPayload {
        images_root_path: images_dir(&app)?.display().to_string(),
        images: workspace.images,
        folders: workspace.folders,
        tags: workspace.tags,
    })
}

#[tauri::command]
pub(crate) fn list_gallery_workspace(app: AppHandle) -> Result<GalleryWorkspacePayload, String> {
    ensure_gallery_layout(&app)?;
    gallery_workspace_payload(&app)
}

#[tauri::command]
pub(crate) fn create_image_folder(
    app: AppHandle,
    input: CreateImageFolderInput,
) -> Result<Vec<String>, String> {
    ensure_gallery_layout(&app)?;
    let normalized = normalize_gallery_folder_path(&input.path)?;
    if normalized.is_empty() || is_protected_gallery_folder_path(&normalized) {
        return Err("invalid gallery folder path".to_string());
    }
    fs::create_dir_all(images_dir(&app)?.join(&normalized))
        .map_err(|error| format!("failed to create gallery folder: {error}"))?;
    collect_gallery_folders(&app)
}

#[tauri::command]
pub(crate) fn rename_image_folder(
    app: AppHandle,
    input: RenameImageFolderInput,
) -> Result<Vec<String>, String> {
    ensure_gallery_layout(&app)?;
    let from_path = normalize_gallery_folder_path(&input.from_path)?;
    let to_path = normalize_gallery_folder_path(&input.to_path)?;
    if from_path.is_empty()
        || to_path.is_empty()
        || is_protected_gallery_folder_path(&from_path)
        || is_protected_gallery_folder_path(&to_path)
    {
        return Err("invalid gallery folder path".to_string());
    }

    let root = images_dir(&app)?;
    let source = root.join(&from_path);
    let target = root.join(&to_path);
    if !source.exists() {
        return Err("gallery folder not found".to_string());
    }
    if target.exists() {
        return Err("gallery folder already exists".to_string());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to prepare gallery folder rename: {error}"))?;
    }

    fs::rename(source, target).map_err(|error| format!("failed to rename gallery folder: {error}"))?;
    collect_gallery_folders(&app)
}

#[tauri::command]
pub(crate) fn delete_image_folder(
    app: AppHandle,
    input: DeleteImageFolderInput,
) -> Result<Vec<String>, String> {
    ensure_gallery_layout(&app)?;
    let normalized = normalize_gallery_folder_path(&input.path)?;
    if normalized.is_empty() || is_protected_gallery_folder_path(&normalized) {
        return Err("invalid gallery folder path".to_string());
    }

    let target = images_dir(&app)?.join(&normalized);
    if !target.exists() {
        return Err("gallery folder not found".to_string());
    }
    if fs::read_dir(&target)
        .map_err(|error| format!("failed to inspect gallery folder: {error}"))?
        .next()
        .is_some()
    {
        return Err("only empty gallery folders can be deleted".to_string());
    }

    fs::remove_dir(target).map_err(|error| format!("failed to delete gallery folder: {error}"))?;
    collect_gallery_folders(&app)
}

#[tauri::command]
pub(crate) fn import_gallery_file(
    app: AppHandle,
    input: ImportGalleryFileInput,
) -> Result<GalleryImageEntry, String> {
    ensure_gallery_layout(&app)?;
    let file_name = sanitize_file_name(&input.file_name);
    let pseudo_path = Path::new(&file_name);
    if !is_supported_image_path(pseudo_path) {
        return Err("unsupported image format".to_string());
    }

    let target_folder = compose_gallery_folder_path(&input.folder_path, input.relative_parent_path.as_deref())?;
    let target_dir = if target_folder.is_empty() {
        images_dir(&app)?
    } else {
        images_dir(&app)?.join(&target_folder)
    };
    fs::create_dir_all(&target_dir).map_err(|error| format!("failed to prepare import folder: {error}"))?;

    let target_path = unique_target_path(&target_dir, &file_name);
    fs::write(&target_path, &input.bytes).map_err(|error| format!("failed to import image: {error}"))?;
    write_gallery_meta(
        &target_path,
        &GalleryImageMeta {
            imported_at: now_ts(),
            updated_at: now_ts(),
            original_folder_path: None,
            deleted_at: None,
            ..GalleryImageMeta::default()
        },
    )?;
    gallery_entry_from_path(&app, &target_path)
}

#[tauri::command]
pub(crate) fn update_gallery_image_meta(
    app: AppHandle,
    input: UpdateGalleryImageMetaInput,
) -> Result<GalleryImageEntry, String> {
    ensure_gallery_layout(&app)?;
    let image_path = find_gallery_image_path_by_id(&app, &input.id)?;
    let current = read_gallery_meta(&image_path)?;
    write_gallery_meta(
        &image_path,
        &GalleryImageMeta {
            tags: input.tags,
            note: input.note,
            imported_at: current.imported_at,
            updated_at: current.updated_at,
            original_folder_path: current.original_folder_path,
            deleted_at: current.deleted_at,
        },
    )?;
    gallery_entry_from_path(&app, &image_path)
}

#[tauri::command]
pub(crate) fn move_gallery_image(
    app: AppHandle,
    input: MoveGalleryImageInput,
) -> Result<GalleryImageEntry, String> {
    ensure_gallery_layout(&app)?;
    let image_path = find_gallery_image_path_by_id(&app, &input.id)?;
    let current = read_gallery_meta(&image_path)?;
    if current.deleted_at.is_some() {
        return Err("target gallery folder is not allowed".to_string());
    }
    let target_dir = ensure_gallery_folder_exists(&app, &input.folder_path)?;
    let file_name = image_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "failed to resolve image filename".to_string())?;
    let target_path = unique_target_path(&target_dir, file_name);
    if target_path == image_path {
        return gallery_entry_from_path(&app, &image_path);
    }

    fs::rename(&image_path, &target_path).map_err(|error| format!("failed to move image: {error}"))?;

    let source_meta = image_meta_path(&image_path)?;
    let target_meta = image_meta_path(&target_path)?;
    if source_meta.exists() {
        fs::rename(source_meta, target_meta).map_err(|error| format!("failed to move image meta: {error}"))?;
    }

    gallery_entry_from_path(&app, &target_path)
}

#[tauri::command]
pub(crate) fn trash_gallery_image(app: AppHandle, id: String) -> Result<Vec<GalleryImageEntry>, String> {
    ensure_gallery_layout(&app)?;
    let image_path = find_gallery_image_path_by_id(&app, &id)?;
    let current_folder = gallery_folder_path_from_image_path(&app, &image_path)?;
    if current_folder == GALLERY_TRASH_FOLDER {
        return collect_gallery_images(&app);
    }

    let file_name = image_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "failed to resolve image filename".to_string())?;
    let target_path = unique_target_path(&gallery_trash_dir(&app)?, file_name);
    fs::rename(&image_path, &target_path).map_err(|error| format!("failed to trash image: {error}"))?;

    let current_meta = read_gallery_meta(&image_path)?;
    let target_meta = image_meta_path(&target_path)?;
    write_gallery_meta(
        &target_path,
        &GalleryImageMeta {
            tags: current_meta.tags,
            note: current_meta.note,
            imported_at: current_meta.imported_at,
            updated_at: current_meta.updated_at,
            original_folder_path: Some(current_folder),
            deleted_at: Some(now_ts()),
        },
    )?;
    let source_meta = image_meta_path(&image_path)?;
    if source_meta.exists() && source_meta != target_meta {
        let _ = fs::remove_file(source_meta);
    }

    collect_gallery_images(&app)
}

#[tauri::command]
pub(crate) fn restore_gallery_image(app: AppHandle, id: String) -> Result<GalleryImageEntry, String> {
    ensure_gallery_layout(&app)?;
    let image_path = find_gallery_image_path_by_id(&app, &id)?;
    let current = read_gallery_meta(&image_path)?;
    if current.deleted_at.is_none() {
        return gallery_entry_from_path(&app, &image_path);
    }

    let preferred_folder = current.original_folder_path.clone().unwrap_or_default();
    let restored_folder = if !preferred_folder.is_empty() && images_dir(&app)?.join(&preferred_folder).exists() {
        preferred_folder
    } else {
        String::new()
    };
    let target_dir = if restored_folder.is_empty() {
        images_dir(&app)?
    } else {
        images_dir(&app)?.join(&restored_folder)
    };
    fs::create_dir_all(&target_dir).map_err(|error| format!("failed to prepare restore folder: {error}"))?;

    let file_name = image_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "failed to resolve image filename".to_string())?;
    let target_path = unique_target_path(&target_dir, file_name);
    fs::rename(&image_path, &target_path).map_err(|error| format!("failed to restore image: {error}"))?;

    let source_meta = image_meta_path(&image_path)?;
    let target_meta = image_meta_path(&target_path)?;
    write_gallery_meta(
        &target_path,
        &GalleryImageMeta {
            tags: current.tags,
            note: current.note,
            imported_at: current.imported_at,
            updated_at: current.updated_at,
            original_folder_path: None,
            deleted_at: None,
        },
    )?;
    if source_meta.exists() && source_meta != target_meta {
        let _ = fs::remove_file(source_meta);
    }

    gallery_entry_from_path(&app, &target_path)
}

#[tauri::command]
pub(crate) fn delete_gallery_image(app: AppHandle, id: String) -> Result<Vec<GalleryImageEntry>, String> {
    ensure_gallery_layout(&app)?;
    let image_path = find_gallery_image_path_by_id(&app, &id)?;
    if image_path.exists() {
        fs::remove_file(&image_path).map_err(|error| format!("failed to delete image: {error}"))?;
    }

    let meta_path = image_meta_path(&image_path)?;
    if meta_path.exists() {
        fs::remove_file(meta_path).map_err(|error| format!("failed to delete image meta: {error}"))?;
    }

    collect_gallery_images(&app)
}

#[tauri::command]
pub(crate) fn empty_gallery_trash(app: AppHandle) -> Result<Vec<GalleryImageEntry>, String> {
    ensure_gallery_layout(&app)?;
    for image in collect_gallery_images(&app)?
        .into_iter()
        .filter(|image| image.is_trashed)
    {
        let image_path = find_gallery_image_path_by_id(&app, &image.id)?;
        if image_path.exists() {
            fs::remove_file(&image_path).map_err(|error| format!("failed to delete image: {error}"))?;
        }
        let meta_path = image_meta_path(&image_path)?;
        if meta_path.exists() {
            fs::remove_file(meta_path).map_err(|error| format!("failed to delete image meta: {error}"))?;
        }
    }
    collect_gallery_images(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_gallery_folder_path_handles_root_and_nested_paths() {
        assert_eq!(normalize_gallery_folder_path("").unwrap(), "");
        assert_eq!(
            normalize_gallery_folder_path("projects/reference").unwrap(),
            "projects/reference"
        );
        assert!(normalize_gallery_folder_path("../escape").is_err());
        assert!(normalize_gallery_folder_path("a//b").is_err());
    }

    #[test]
    fn normalize_tags_deduplicates_case_insensitively() {
        let tags = normalize_tags(&[
            "Travel".to_string(),
            " travel ".to_string(),
            "Moodboard".to_string(),
        ]);
        assert_eq!(tags, vec!["Moodboard".to_string(), "Travel".to_string()]);
    }

    #[test]
    fn unique_target_path_appends_suffix() {
        let root = std::env::temp_dir().join(format!("myvault-gallery-{}", now_ts()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("cover.jpg");
        fs::write(&first, b"demo").unwrap();

        let next = unique_target_path(&root, "cover.jpg");
        assert!(next.ends_with("cover (2).jpg"));

        fs::remove_dir_all(root).unwrap();
    }
}
