use image::{codecs::jpeg::JpegEncoder, ImageReader};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::{Hash, Hasher},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, State};
use uuid::Uuid;

const DEFAULT_PAGE_SIZE: usize = 48;
const MAX_PAGE_SIZE: usize = 96;
const THUMBNAIL_EDGE: u32 = 480;
const CACHE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
const CACHE_TARGET_BYTES: u64 = 384 * 1024 * 1024;

#[derive(Clone)]
struct GalleryRecord {
    absolute_path: PathBuf,
    relative_path: String,
    file_name: String,
    cache_name: String,
}

#[derive(Default)]
pub(crate) struct GalleryState {
    catalog: Mutex<Option<Vec<GalleryRecord>>>,
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
    thumbnail_path: String,
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

fn cache_name(relative_path: &str, metadata: &fs::Metadata) -> String {
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
    format!("{:016x}.jpg", hasher.finish())
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
                cache_name: cache_name(&relative_path, &metadata),
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

fn clean_cache(cache: &Path, records: &[GalleryRecord]) -> Result<(), String> {
    fs::create_dir_all(cache)
        .map_err(|error| format!("failed to create gallery cache: {error}"))?;
    let expected = records
        .iter()
        .map(|record| record.cache_name.as_str())
        .collect::<HashSet<_>>();
    let mut cache_files = Vec::new();
    let mut total_bytes = 0u64;
    for entry in
        fs::read_dir(cache).map_err(|error| format!("failed to read gallery cache: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read gallery cache: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect gallery cache: {error}"))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !expected.contains(name.as_str()) {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to inspect gallery cache: {error}"))?;
        total_bytes = total_bytes.saturating_add(metadata.len());
        cache_files.push((
            entry.path(),
            metadata.modified().unwrap_or(UNIX_EPOCH),
            metadata.len(),
        ));
    }
    if total_bytes <= CACHE_LIMIT_BYTES {
        return Ok(());
    }
    cache_files.sort_by_key(|(_, modified, _)| *modified);
    for (path, _, size) in cache_files {
        if total_bytes <= CACHE_TARGET_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total_bytes = total_bytes.saturating_sub(size);
        }
    }
    Ok(())
}

fn ensure_thumbnail(record: &GalleryRecord, cache: &Path) -> Result<PathBuf, String> {
    let target = cache.join(&record.cache_name);
    if target.is_file() {
        return Ok(target);
    }
    let image = ImageReader::open(&record.absolute_path)
        .map_err(|error| format!("failed to open image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("failed to identify image: {error}"))?
        .decode()
        .map_err(|error| format!("failed to decode image: {error}"))?;
    let thumbnail = image.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE).to_rgb8();
    let temporary = cache.join(format!(".thumb-{}.tmp", Uuid::new_v4()));
    let file = fs::File::create(&temporary)
        .map_err(|error| format!("failed to create thumbnail: {error}"))?;
    let mut writer = BufWriter::new(file);
    JpegEncoder::new_with_quality(&mut writer, 82)
        .encode_image(&thumbnail)
        .map_err(|error| format!("failed to encode thumbnail: {error}"))?;
    drop(writer);
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        if !target.is_file() {
            return Err(format!("failed to activate thumbnail: {error}"));
        }
    }
    Ok(target)
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
    clean_cache(&crate::core::gallery_cache_dir(app)?, &records)?;
    *slot = Some(records.clone());
    Ok(records)
}

fn invalidate_catalog(state: &GalleryState) -> Result<(), String> {
    *state
        .catalog
        .lock()
        .map_err(|_| "gallery catalog is poisoned".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_gallery(
    app: AppHandle,
    state: State<'_, GalleryState>,
    input: ListGalleryInput,
) -> Result<GalleryPage, String> {
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
    let cache = crate::core::gallery_cache_dir(&app)?;
    let page_records = &records[start..end];
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        .clamp(1, 4)
        .min(page_records.len().max(1));
    let chunk_size = page_records.len().max(1).div_ceil(worker_count);
    let thumbnail_results = thread::scope(|scope| {
        let mut workers = Vec::new();
        for chunk in page_records.chunks(chunk_size) {
            workers.push(scope.spawn(|| {
                chunk
                    .iter()
                    .map(|record| ensure_thumbnail(record, &cache))
                    .collect::<Vec<_>>()
            }));
        }
        let mut results = Vec::with_capacity(page_records.len());
        for worker in workers {
            results.extend(
                worker
                    .join()
                    .unwrap_or_else(|_| vec![Err("thumbnail worker failed".to_string())]),
            );
        }
        results
    });
    let mut items = Vec::with_capacity(page_records.len());
    for (record, thumbnail) in page_records.iter().zip(thumbnail_results) {
        let thumbnail = thumbnail?;
        items.push(GalleryItem {
            relative_path: record.relative_path.clone(),
            file_name: record.file_name.clone(),
            original_path: normalized_frontend_path(&record.absolute_path),
            thumbnail_path: normalized_frontend_path(&thumbnail),
        });
    }
    clean_cache(&cache, &records)?;
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

#[tauri::command]
pub(crate) fn import_gallery(
    app: AppHandle,
    state: State<'_, GalleryState>,
    input: ImportGalleryInput,
) -> Result<ImportGalleryResult, String> {
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
    fn scans_images_and_removes_orphaned_thumbnails() {
        let root = std::env::temp_dir().join(format!("myvault-gallery-{}", Uuid::new_v4()));
        let gallery = root.join("Gallery");
        let cache = root.join("Cache");
        fs::create_dir_all(&gallery).unwrap();
        fs::create_dir_all(&cache).unwrap();
        image::RgbImage::from_pixel(32, 24, image::Rgb([80, 120, 180]))
            .save(gallery.join("sample.png"))
            .unwrap();
        fs::write(gallery.join("notes.txt"), "not an image").unwrap();

        let records = scan_gallery(&gallery).unwrap();
        assert_eq!(records.len(), 1);
        let thumbnail = ensure_thumbnail(&records[0], &cache).unwrap();
        assert!(thumbnail.is_file());
        assert!(!gallery.join("_Gallery.json").exists());

        fs::remove_file(gallery.join("sample.png")).unwrap();
        clean_cache(&cache, &[]).unwrap();
        assert!(!thumbnail.exists());
        let _ = fs::remove_dir_all(root);
    }
}
