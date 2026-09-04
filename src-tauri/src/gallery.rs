use image::{metadata::Orientation, ImageDecoder, ImageReader};
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

const DEFAULT_VIEWPORT_WIDTH: f64 = 900.0;
const DEFAULT_VIEWPORT_HEIGHT: f64 = 520.0;
const DEFAULT_TARGET_WIDTH: f64 = 192.0;
const MASONRY_GAP: f64 = 16.0;
const CARD_TEXT_HEIGHT: f64 = 40.0;
const MAX_VISIBLE_ITEMS: usize = 96;
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
    width: u32,
    height: u32,
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
    viewport_width: Option<f64>,
    viewport_height: Option<f64>,
    target_width: Option<f64>,
    anchor_relative_path: Option<String>,
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
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GalleryPage {
    gallery_path: String,
    items: Vec<GalleryItem>,
    total_items: usize,
    page: usize,
    total_pages: usize,
    column_count: usize,
    column_width: f64,
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

fn image_display_dimensions(path: &Path) -> Option<(u32, u32)> {
    let reader = ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let (mut width, mut height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return None;
    }
    if matches!(
        decoder.orientation().unwrap_or(Orientation::NoTransforms),
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    ) {
        std::mem::swap(&mut width, &mut height);
    }
    Some((width, height))
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
            if !file_type.is_file() {
                continue;
            }
            let Some((width, height)) = image_display_dimensions(&path) else {
                continue;
            };
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
                width,
                height,
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

fn finite_between(value: Option<f64>, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    value
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
        .clamp(minimum, maximum)
}

fn masonry_layout(
    records: &[GalleryRecord],
    input: &ListGalleryInput,
) -> (usize, f64, Vec<(usize, usize)>) {
    let viewport_width =
        finite_between(input.viewport_width, DEFAULT_VIEWPORT_WIDTH, 240.0, 8_192.0);
    let viewport_height = finite_between(
        input.viewport_height,
        DEFAULT_VIEWPORT_HEIGHT,
        180.0,
        8_192.0,
    );
    let target_width = finite_between(input.target_width, DEFAULT_TARGET_WIDTH, 112.0, 320.0);
    let column_count =
        (((viewport_width + MASONRY_GAP) / (target_width + MASONRY_GAP)).floor() as usize).max(1);
    let column_width = (viewport_width - MASONRY_GAP * column_count.saturating_sub(1) as f64)
        / column_count as f64;
    if records.is_empty() {
        return (column_count, column_width, vec![(0, 0)]);
    }

    let mut pages = Vec::new();
    let mut start = 0;
    while start < records.len() {
        let mut heights = vec![0.0_f64; column_count];
        let mut end = start;
        while end < records.len() {
            if end - start >= MAX_VISIBLE_ITEMS {
                break;
            }
            let shortest = heights
                .iter()
                .enumerate()
                .min_by(|left, right| left.1.total_cmp(right.1))
                .map(|(index, _)| index)
                .unwrap_or_default();
            let record = &records[end];
            let image_height = column_width * f64::from(record.height) / f64::from(record.width);
            let item_height = image_height + CARD_TEXT_HEIGHT;
            let next_height = heights[shortest]
                + if heights[shortest] > 0.0 {
                    MASONRY_GAP
                } else {
                    0.0
                }
                + item_height;
            let columns_started = heights.iter().all(|height| *height > 0.0);
            if columns_started && next_height > viewport_height {
                break;
            }
            heights[shortest] = next_height;
            end += 1;
        }
        if end == start {
            end += 1;
        }
        pages.push((start, end));
        start = end;
    }
    (column_count, column_width, pages)
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
    let (column_count, column_width, pages) = masonry_layout(&records, &input);
    let total_pages = pages.len();
    let mut page = input.page.max(1).min(total_pages);
    if let Some(anchor) = input.anchor_relative_path.as_deref() {
        if let Some(index) = records
            .iter()
            .position(|record| record.relative_path == anchor)
        {
            if let Some(found) = pages
                .iter()
                .position(|(start, end)| index >= *start && index < *end)
            {
                page = found + 1;
            }
        }
    }
    let (start, end) = pages[page - 1];
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
            width: record.width,
            height: record.height,
        });
    }
    Ok(GalleryPage {
        gallery_path: normalized_frontend_path(&crate::core::gallery_dir(&app)?),
        items,
        total_items: records.len(),
        page,
        total_pages,
        column_count,
        column_width,
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
            } else if file_type.is_file() && image_display_dimensions(&entry.path()).is_some() {
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
            if image_display_dimensions(&source).is_none() {
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

    fn layout_record(index: usize) -> GalleryRecord {
        GalleryRecord {
            absolute_path: PathBuf::from(format!("image-{index}.jpg")),
            relative_path: format!("image-{index}.jpg"),
            file_name: format!("image-{index}.jpg"),
            thumbnail_id: format!("{index:016x}"),
            width: 1_600,
            height: 1_200,
        }
    }

    #[test]
    fn masonry_density_changes_visible_capacity_without_losing_items() {
        let records = (0..30).map(layout_record).collect::<Vec<_>>();
        let input = |target_width| ListGalleryInput {
            page: 1,
            viewport_width: Some(900.0),
            viewport_height: Some(500.0),
            target_width: Some(target_width),
            anchor_relative_path: None,
            refresh: None,
        };
        let (_, _, compact_pages) = masonry_layout(&records, &input(128.0));
        let (_, _, large_pages) = masonry_layout(&records, &input(288.0));

        assert!(compact_pages[0].1 > large_pages[0].1);
        assert_eq!(
            compact_pages
                .iter()
                .map(|(start, end)| end - start)
                .sum::<usize>(),
            records.len()
        );
        assert_eq!(
            large_pages
                .iter()
                .map(|(start, end)| end - start)
                .sum::<usize>(),
            records.len()
        );
    }

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
        assert_eq!((records[0].width, records[0].height), (32, 24));
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
