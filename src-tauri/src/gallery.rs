use image::ImageReader;
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, State};
use uuid::Uuid;

const DEFAULT_PAGE_SIZE: usize = 48;
const MAX_PAGE_SIZE: usize = 96;
static COMMAND_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn release_catalog(state: &GalleryState) -> Result<(), String> {
    let _command = COMMAND_LOCK
        .lock()
        .map_err(|_| "gallery command lock is poisoned")?;
    invalidate_catalog(state)
}

#[derive(Clone)]
struct GalleryRecord {
    absolute_path: PathBuf,
    relative_path: String,
    file_name: String,
    thumbnail_id: String,
}

#[derive(Default)]
pub(crate) struct GalleryState {
    catalog: Mutex<Option<Vec<GalleryRecord>>>,
    visible_thumbnail_ids: Mutex<HashSet<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListGalleryInput {
    page: usize,
    page_size: usize,
    refresh: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportGalleryInput {
    paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GalleryItem {
    relative_path: String,
    file_name: String,
    original_path: String,
    thumbnail_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GalleryPage {
    gallery_path: String,
    items: Vec<GalleryItem>,
    total_items: usize,
    page: usize,
    page_size: usize,
    total_pages: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportGalleryResult {
    imported: usize,
    skipped: usize,
}

fn normalized_frontend_path(path: &Path) -> String {
    path.to_string_lossy()
        .strip_prefix(r"\\?\")
        .unwrap_or(&path.to_string_lossy())
        .replace('\\', "/")
}

fn is_supported_image(path: &Path) -> bool {
    ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .ok()
        .and_then(|reader| reader.format())
        .is_some()
}

fn thumbnail_id(relative_path: &str, metadata: &fs::Metadata) -> String {
    let mut hasher = DefaultHasher::new();
    relative_path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn scan_gallery(root: &Path) -> Result<Vec<GalleryRecord>, String> {
    let mut records = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries =
            fs::read_dir(&directory).map_err(|error| format!("failed to scan gallery: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to scan gallery: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect gallery item: {error}"))?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() || !is_supported_image(&path) {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "gallery item escaped the gallery root".to_string())?;
            let relative_path = normalized_frontend_path(relative);
            let metadata = entry
                .metadata()
                .map_err(|error| format!("failed to inspect gallery image: {error}"))?;
            records.push(GalleryRecord {
                absolute_path: path,
                file_name: entry.file_name().to_string_lossy().into_owned(),
                thumbnail_id: thumbnail_id(&relative_path, &metadata),
                relative_path,
            });
        }
    }
    records.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    Ok(records)
}

fn is_owned_legacy_thumbnail(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".jpg") else {
        return name.starts_with(".thumb-") && name.ends_with(".tmp");
    };
    stem.len() == 16 && stem.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn retire_legacy_thumbnail_cache(cache: &Path) -> Result<(), String> {
    if !cache.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(cache)
        .map_err(|error| format!("failed to inspect legacy gallery cache: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to inspect legacy gallery cache: {error}"))?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_file() && is_owned_legacy_thumbnail(&name) {
            fs::remove_file(entry.path())
                .map_err(|error| format!("failed to remove legacy thumbnail {name}: {error}"))?;
        }
    }
    if fs::read_dir(cache)
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        fs::remove_dir(cache).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn load_catalog(app: &AppHandle, state: &GalleryState) -> Result<Vec<GalleryRecord>, String> {
    let mut slot = state
        .catalog
        .lock()
        .map_err(|_| "gallery catalog is poisoned".to_string())?;
    if let Some(records) = slot.as_ref() {
        return Ok(records.clone());
    }
    let root = crate::core::gallery_dir(app)?;
    let records = scan_gallery(&root)?;
    retire_legacy_thumbnail_cache(&crate::core::gallery_cache_dir(app)?)?;
    *slot = Some(records.clone());
    Ok(records)
}

fn invalidate_catalog(state: &GalleryState) -> Result<(), String> {
    *state
        .catalog
        .lock()
        .map_err(|_| "gallery catalog is poisoned".to_string())? = None;
    state
        .visible_thumbnail_ids
        .lock()
        .map_err(|_| "gallery visible thumbnail registry is poisoned".to_string())?
        .clear();
    Ok(())
}

pub(crate) fn visible_thumbnail_path(
    state: &GalleryState,
    thumbnail_id: &str,
) -> Result<Option<PathBuf>, String> {
    if !state
        .visible_thumbnail_ids
        .lock()
        .map_err(|_| "gallery visible thumbnail registry is poisoned")?
        .contains(thumbnail_id)
    {
        return Ok(None);
    }
    let catalog = state
        .catalog
        .lock()
        .map_err(|_| "gallery catalog is poisoned")?;
    Ok(catalog.as_ref().and_then(|records| {
        records
            .iter()
            .find(|record| record.thumbnail_id == thumbnail_id)
            .map(|record| record.absolute_path.clone())
    }))
}

#[tauri::command(async)]
pub(crate) fn list_gallery(
    app: AppHandle,
    state: State<'_, GalleryState>,
    input: ListGalleryInput,
) -> Result<GalleryPage, String> {
    let _command = COMMAND_LOCK
        .lock()
        .map_err(|_| "gallery command lock is poisoned")?;
    crate::core::ensure_gallery_layout(&app)?;
    if input.refresh.unwrap_or(false) {
        invalidate_catalog(&state)?;
    }
    let records = load_catalog(&app, &state)?;
    let page_size = if input.page_size == 0 {
        DEFAULT_PAGE_SIZE
    } else {
        input.page_size.min(MAX_PAGE_SIZE)
    };
    let total_pages = records.len().max(1).div_ceil(page_size);
    let page = input.page.max(1).min(total_pages);
    let start = (page - 1) * page_size;
    let end = (start + page_size).min(records.len());
    let page_records = &records[start..end];
    *state
        .visible_thumbnail_ids
        .lock()
        .map_err(|_| "gallery visible thumbnail registry is poisoned")? = page_records
        .iter()
        .map(|record| record.thumbnail_id.clone())
        .collect();
    let mut items = Vec::with_capacity(page_records.len());
    for record in page_records {
        items.push(GalleryItem {
            relative_path: record.relative_path.clone(),
            file_name: record.file_name.clone(),
            original_path: normalized_frontend_path(&record.absolute_path),
            thumbnail_id: record.thumbnail_id.clone(),
        });
    }
    Ok(GalleryPage {
        gallery_path: normalized_frontend_path(&crate::core::gallery_dir(&app)?),
        items,
        total_items: records.len(),
        page,
        page_size,
        total_pages,
    })
}

fn unique_file_destination(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 2..=10_000 {
        let name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("image-{}", Uuid::new_v4()))
}

fn unique_directory_destination(root: &Path, name: &str) -> PathBuf {
    let candidate = root.join(name);
    if !candidate.exists() {
        return candidate;
    }
    for index in 2..=10_000 {
        let candidate = root.join(format!("{name} ({index})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!("Imported-{}", Uuid::new_v4()))
}

fn copy_image(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create import directory: {error}"))?;
    }
    let temporary = destination.with_extension(format!("{}.myvault-importing", Uuid::new_v4()));
    let copied = fs::copy(source, &temporary)
        .map_err(|error| format!("failed to import {}: {error}", source.display()))?;
    let source_size = fs::metadata(source)
        .map_err(|error| format!("failed to inspect imported image: {error}"))?
        .len();
    if copied != source_size {
        let _ = fs::remove_file(&temporary);
        return Err(format!("incomplete image import: {}", source.display()));
    }
    fs::rename(&temporary, destination).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("failed to finish image import: {error}")
    })
}

fn collect_directory_images(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut images = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("failed to read import folder: {error}"))?
        {
            let entry = entry.map_err(|error| format!("failed to read import folder: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect import item: {error}"))?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() && is_supported_image(&entry.path()) {
                images.push(entry.path());
            }
        }
    }
    images.sort();
    Ok(images)
}

#[tauri::command(async)]
pub(crate) fn import_gallery(
    app: AppHandle,
    state: State<'_, GalleryState>,
    input: ImportGalleryInput,
) -> Result<ImportGalleryResult, String> {
    let _command = COMMAND_LOCK
        .lock()
        .map_err(|_| "gallery command lock is poisoned")?;
    crate::core::ensure_gallery_layout(&app)?;
    invalidate_catalog(&state)?;
    let gallery = crate::core::gallery_dir(&app)?
        .canonicalize()
        .map_err(|error| format!("failed to resolve gallery directory: {error}"))?;
    let mut imported = 0usize;
    let mut skipped = 0usize;
    for raw in input.paths {
        let source = PathBuf::from(raw);
        let Ok(source) = source.canonicalize() else {
            skipped += 1;
            continue;
        };
        if source.starts_with(&gallery) || gallery.starts_with(&source) {
            skipped += 1;
            continue;
        }
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("failed to inspect import path: {error}"))?;
        if metadata.file_type().is_symlink() {
            skipped += 1;
            continue;
        }
        if metadata.is_file() {
            if !is_supported_image(&source) {
                skipped += 1;
                continue;
            }
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("image");
            let destination = unique_file_destination(&gallery, name);
            copy_image(&source, &destination)?;
            imported += 1;
            continue;
        }
        if !metadata.is_dir() {
            skipped += 1;
            continue;
        }
        let images = collect_directory_images(&source)?;
        if images.is_empty() {
            skipped += 1;
            continue;
        }
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("Imported");
        let destination_root = unique_directory_destination(&gallery, name);
        for image in images {
            let relative = image
                .strip_prefix(&source)
                .map_err(|_| "imported image escaped its source folder".to_string())?;
            copy_image(&image, &destination_root.join(relative))?;
            imported += 1;
        }
    }
    Ok(ImportGalleryResult { imported, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_names_get_a_readable_suffix() {
        let root = std::env::temp_dir().join(format!("myvault-gallery-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("photo.jpg"), b"one").unwrap();
        assert_eq!(
            unique_file_destination(&root, "photo.jpg")
                .file_name()
                .unwrap(),
            "photo (2).jpg"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scans_images_without_creating_a_private_thumbnail() {
        let root = std::env::temp_dir().join(format!("myvault-gallery-{}", Uuid::new_v4()));
        let gallery = root.join("Gallery");
        fs::create_dir_all(&gallery).unwrap();
        image::RgbImage::from_pixel(32, 24, image::Rgb([80, 120, 180]))
            .save(gallery.join("sample.png"))
            .unwrap();
        fs::write(gallery.join("notes.txt"), "not an image").unwrap();

        let records = scan_gallery(&gallery).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].thumbnail_id.len(), 16);
        assert!(records[0]
            .thumbnail_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert!(!gallery.join("_Gallery.json").exists());
        assert_eq!(fs::read_dir(&gallery).unwrap().count(), 2);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retires_only_owned_legacy_thumbnail_files() {
        let root = std::env::temp_dir().join(format!("myvault-gallery-{}", Uuid::new_v4()));
        let cache = root.join("Cache");
        fs::create_dir_all(&cache).unwrap();
        let thumbnail = cache.join("0123456789abcdef.jpg");
        let temporary = cache.join(".thumb-0123456789abcdef.tmp");
        let unknown = cache.join("keep.txt");
        fs::write(&thumbnail, b"old thumbnail").unwrap();
        fs::write(&temporary, b"old temporary thumbnail").unwrap();
        fs::write(&unknown, b"not owned by the thumbnail generator").unwrap();

        retire_legacy_thumbnail_cache(&cache).unwrap();

        assert!(!thumbnail.exists());
        assert!(!temporary.exists());
        assert!(unknown.exists());
        let _ = fs::remove_dir_all(root);
    }
}
