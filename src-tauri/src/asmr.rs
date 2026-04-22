use crate::core::{
    asmr_index_path, asmr_works_dir, atomic_write_utf8_file, ensure_vault_layout, now_ts,
    read_utf8_file,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsmrIndex {
    version: u32,
    works: Vec<AsmrWork>,
    dictionaries: AsmrDictionaries,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsmrDictionaries {
    tags: Vec<String>,
    voice_actors: Vec<String>,
    circles: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsmrWork {
    rj_id: String,
    title: String,
    circle: String,
    voice_actors: Vec<String>,
    tags: Vec<String>,
    status: String,
    favorite: bool,
    rating: Option<u8>,
    note: String,
    work_dir: String,
    files_dir: String,
    cover_path: Option<String>,
    thumbnail_path: Option<String>,
    last_opened_folder: Option<String>,
    last_played_audio_path: Option<String>,
    last_position_ms: u64,
    imported_at: u64,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsmrBootstrapPayload {
    works: Vec<AsmrWork>,
    dictionaries: AsmrDictionaries,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsmrFolderPayload {
    rj_id: String,
    folder_path: String,
    items: Vec<AsmrFileItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsmrFileItem {
    name: String,
    relative_path: String,
    absolute_path: String,
    kind: String,
    size: u64,
    subtitle_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportAsmrWorkInput {
    source_path: String,
    rj_id: Option<String>,
    title: Option<String>,
    overwrite: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewAsmrImportInput {
    source_path: String,
    rj_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsmrImportPreview {
    source_path: String,
    rj_id: String,
    already_exists: bool,
    file_count: u64,
    folder_count: u64,
    total_size: u64,
    audio_count: u64,
    subtitle_count: u64,
    image_count: u64,
    other_count: u64,
    associated_subtitle_count: u64,
    default_folder: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAsmrWorkInput {
    rj_id: String,
    title: String,
    circle: String,
    voice_actors: Vec<String>,
    tags: Vec<String>,
    status: String,
    favorite: bool,
    rating: Option<u8>,
    note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListAsmrFolderInput {
    rj_id: String,
    folder_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAsmrPlaybackInput {
    rj_id: String,
    audio_path: String,
    position_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertAsmrDictionaryInput {
    kind: String,
    old_value: Option<String>,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteAsmrDictionaryInput {
    kind: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetAsmrCoverInput {
    rj_id: String,
    source_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadAsmrTextFileInput {
    rj_id: String,
    relative_path: String,
}

fn default_asmr_index() -> AsmrIndex {
    AsmrIndex {
        version: 1,
        works: Vec::new(),
        dictionaries: AsmrDictionaries::default(),
    }
}

fn load_asmr_index(app: &AppHandle) -> Result<AsmrIndex, String> {
    let path = asmr_index_path(app)?;
    if !path.exists() {
        let index = default_asmr_index();
        save_asmr_index(app, &index)?;
        return Ok(index);
    }

    let raw =
        read_utf8_file(&path).map_err(|error| format!("failed to read asmr index: {error}"))?;
    let mut index: AsmrIndex = match serde_json::from_str(&raw) {
        Ok(index) => index,
        Err(error) => {
            let backup_path = path.with_extension("json.bak");
            let backup_raw = read_utf8_file(&backup_path).map_err(|backup_error| {
                format!(
                    "failed to parse asmr index: {error}; failed to read backup: {backup_error}"
                )
            })?;
            serde_json::from_str(&backup_raw).map_err(|backup_error| {
                format!(
                    "failed to parse asmr index: {error}; failed to parse backup: {backup_error}"
                )
            })?
        }
    };
    normalize_asmr_index(&mut index);
    save_asmr_index(app, &index)?;
    Ok(index)
}

fn save_asmr_index(app: &AppHandle, index: &AsmrIndex) -> Result<(), String> {
    let mut normalized = index.clone();
    normalize_asmr_index(&mut normalized);
    let raw = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("failed to serialize asmr index: {error}"))?;
    atomic_write_utf8_file(&asmr_index_path(app)?, &raw)
        .map_err(|error| format!("failed to save asmr index: {error}"))
}

fn normalize_asmr_index(index: &mut AsmrIndex) {
    index.version = 1;
    index
        .works
        .sort_by(|left, right| left.rj_id.cmp(&right.rj_id));
    index
        .works
        .dedup_by(|left, right| left.rj_id == right.rj_id);

    let mut tags = BTreeSet::new();
    let mut voice_actors = BTreeSet::new();
    let mut circles = BTreeSet::new();

    for tag in &index.dictionaries.tags {
        add_dictionary_value(&mut tags, tag);
    }
    for voice_actor in &index.dictionaries.voice_actors {
        add_dictionary_value(&mut voice_actors, voice_actor);
    }
    for circle in &index.dictionaries.circles {
        add_dictionary_value(&mut circles, circle);
    }

    for work in &mut index.works {
        work.rj_id = normalize_rj_id(&work.rj_id).unwrap_or_else(|_| work.rj_id.trim().to_string());
        work.title = work.title.trim().to_string();
        work.circle = work.circle.trim().to_string();
        work.status = normalize_asmr_status(&work.status);
        work.tags = normalized_string_list(&work.tags);
        work.voice_actors = normalized_string_list(&work.voice_actors);
        work.rating = work.rating.filter(|rating| *rating <= 5);

        if !work.circle.is_empty() {
            add_dictionary_value(&mut circles, &work.circle);
        }
        for tag in &work.tags {
            add_dictionary_value(&mut tags, tag);
        }
        for voice_actor in &work.voice_actors {
            add_dictionary_value(&mut voice_actors, voice_actor);
        }
    }

    index.dictionaries.tags = tags.into_iter().collect();
    index.dictionaries.voice_actors = voice_actors.into_iter().collect();
    index.dictionaries.circles = circles.into_iter().collect();
}

fn add_dictionary_value(values: &mut BTreeSet<String>, value: &str) {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        values.insert(trimmed.to_string());
    }
}

fn normalized_string_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn dictionary_values_mut<'a>(
    dictionaries: &'a mut AsmrDictionaries,
    kind: &str,
) -> Result<&'a mut Vec<String>, String> {
    match kind {
        "circle" | "circles" => Ok(&mut dictionaries.circles),
        "tag" | "tags" => Ok(&mut dictionaries.tags),
        "voiceActor" | "voiceActors" | "voice" | "voices" => Ok(&mut dictionaries.voice_actors),
        _ => Err("invalid asmr dictionary kind".to_string()),
    }
}

fn rename_asmr_work_dictionary_value(
    work: &mut AsmrWork,
    kind: &str,
    old_value: &str,
    value: &str,
) {
    match kind {
        "circle" | "circles" => {
            if work.circle == old_value {
                work.circle = value.to_string();
            }
        }
        "tag" | "tags" => {
            for tag in &mut work.tags {
                if tag == old_value {
                    *tag = value.to_string();
                }
            }
            work.tags = normalized_string_list(&work.tags);
        }
        "voiceActor" | "voiceActors" | "voice" | "voices" => {
            for voice_actor in &mut work.voice_actors {
                if voice_actor == old_value {
                    *voice_actor = value.to_string();
                }
            }
            work.voice_actors = normalized_string_list(&work.voice_actors);
        }
        _ => {}
    }
}

fn delete_asmr_work_dictionary_value(work: &mut AsmrWork, kind: &str, value: &str) {
    match kind {
        "circle" | "circles" => {
            if work.circle == value {
                work.circle.clear();
            }
        }
        "tag" | "tags" => work.tags.retain(|tag| tag != value),
        "voiceActor" | "voiceActors" | "voice" | "voices" => {
            work.voice_actors.retain(|voice_actor| voice_actor != value)
        }
        _ => {}
    }
}

fn normalize_asmr_status(value: &str) -> String {
    match value.trim() {
        "listening" | "finished" | "archived" => value.trim().to_string(),
        _ => "new".to_string(),
    }
}

fn normalize_rj_id(raw: &str) -> Result<String, String> {
    let upper = raw.trim().to_ascii_uppercase();
    let candidate = if upper.starts_with("RJ") {
        upper
    } else {
        format!("RJ{upper}")
    };

    let valid = candidate.len() > 2 && candidate[2..].bytes().all(|byte| byte.is_ascii_digit());
    if valid {
        Ok(candidate)
    } else {
        Err("invalid RJ id".to_string())
    }
}

fn extract_rj_id_from_path(path: &Path) -> Option<String> {
    path.components().rev().find_map(|component| {
        let value = component.as_os_str().to_string_lossy();
        extract_rj_id_from_text(&value)
    })
}

fn extract_rj_id_from_text(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    for index in 0..bytes.len().saturating_sub(2) {
        if !bytes[index].eq_ignore_ascii_case(&b'R')
            || !bytes[index + 1].eq_ignore_ascii_case(&b'J')
        {
            continue;
        }
        let mut end = index + 2;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > index + 2 {
            return Some(value[index..end].to_ascii_uppercase());
        }
    }
    None
}

fn validate_relative_path(path: &str) -> Result<String, String> {
    let normalized = path.trim().trim_matches('/').replace('\\', "/");
    if normalized.is_empty() {
        return Ok(String::new());
    }

    let valid = normalized
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
    if valid {
        Ok(normalized)
    } else {
        Err("invalid relative path".to_string())
    }
}

fn asmr_work_dir(app: &AppHandle, rj_id: &str) -> Result<PathBuf, String> {
    Ok(asmr_works_dir(app)?.join(normalize_rj_id(rj_id)?))
}

fn asmr_work_files_dir(app: &AppHandle, rj_id: &str) -> Result<PathBuf, String> {
    Ok(asmr_work_dir(app, rj_id)?.join("files"))
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err("source path must be a directory".to_string());
    }
    fs::create_dir_all(target).map_err(|error| format!("failed to create target dir: {error}"))?;

    for entry in
        fs::read_dir(source).map_err(|error| format!("failed to read source dir: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read source entry: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect source entry: {error}"))?;
        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create target parent: {error}"))?;
            }
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("failed to copy file: {error}"))?;
        }
    }

    Ok(())
}

fn is_audio_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "mp3" | "wav" | "flac" | "m4a" | "ogg"
    )
}

fn is_subtitle_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "vtt" | "srt" | "lrc" | "ass" | "ssa"
    )
}

fn asmr_file_kind(path: &Path) -> Option<String> {
    if path.is_dir() {
        return Some("folder".to_string());
    }
    let extension = path.extension()?.to_string_lossy();
    if is_audio_extension(&extension) {
        Some("audio".to_string())
    } else if is_subtitle_extension(&extension) {
        Some("subtitle".to_string())
    } else {
        None
    }
}

fn subtitle_for_audio(root: &Path, path: &Path) -> Option<String> {
    let parent = path.parent()?;
    let file_stem = path.file_stem()?.to_string_lossy();
    let file_name = path.file_name()?.to_string_lossy();
    ["vtt", "srt", "lrc"].iter().find_map(|extension| {
        [
            format!("{file_stem}.{extension}"),
            format!("{file_name}.{extension}"),
        ]
        .into_iter()
        .find_map(|name| {
            let candidate = parent.join(name);
            if !candidate.exists() {
                return None;
            }
            candidate
                .strip_prefix(root)
                .ok()
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        })
    })
}

fn is_cover_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"
    )
}

fn is_image_extension(extension: &str) -> bool {
    is_cover_extension(extension)
}

fn copy_asmr_cover(source: &Path, work_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    if !source.is_file() {
        return Err("cover source must be a file".to_string());
    }
    let extension = source
        .extension()
        .map(|extension| extension.to_string_lossy().to_string())
        .ok_or_else(|| "cover file must have an extension".to_string())?;
    if !is_cover_extension(&extension) {
        return Err("unsupported cover format".to_string());
    }

    fs::create_dir_all(work_dir).map_err(|error| format!("failed to create work dir: {error}"))?;
    let cover_path = work_dir.join(format!("cover.{}", extension.to_ascii_lowercase()));
    fs::copy(source, &cover_path).map_err(|error| format!("failed to copy cover: {error}"))?;

    let thumbnail_path = work_dir.join("thumb.jpg");
    let image =
        image::open(&cover_path).map_err(|error| format!("failed to read cover image: {error}"))?;
    let thumbnail = image.thumbnail(480, 480);
    thumbnail
        .save_with_format(&thumbnail_path, image::ImageFormat::Jpeg)
        .map_err(|error| format!("failed to save cover thumbnail: {error}"))?;

    Ok((cover_path, thumbnail_path))
}

fn find_default_asmr_folder(files_dir: &Path) -> Result<Option<String>, String> {
    let mut directories = vec![files_dir.to_path_buf()];
    let mut best: Option<String> = None;

    while let Some(current) = directories.pop() {
        for entry in fs::read_dir(&current)
            .map_err(|error| format!("failed to scan asmr folders: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("failed to read asmr folder entry: {error}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let relative = path
                .strip_prefix(files_dir)
                .map_err(|error| format!("failed to resolve asmr folder path: {error}"))?
                .to_string_lossy()
                .replace('\\', "/");
            if entry
                .file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("mp3")
            {
                let replace = best
                    .as_ref()
                    .map(|current_best| relative.len() < current_best.len())
                    .unwrap_or(true);
                if replace {
                    best = Some(relative.clone());
                }
            }
            directories.push(path);
        }
    }

    Ok(best)
}

fn scan_asmr_import_source(
    source: &Path,
) -> Result<(u64, u64, u64, u64, u64, u64, u64, u64), String> {
    let mut file_count = 0;
    let mut folder_count = 0;
    let mut total_size = 0;
    let mut audio_count = 0;
    let mut subtitle_count = 0;
    let mut image_count = 0;
    let mut other_count = 0;
    let mut associated_subtitle_count = 0;
    let mut directories = vec![source.to_path_buf()];

    while let Some(current) = directories.pop() {
        for entry in
            fs::read_dir(&current).map_err(|error| format!("failed to scan source: {error}"))?
        {
            let entry = entry.map_err(|error| format!("failed to read source entry: {error}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect source entry: {error}"))?;
            if file_type.is_dir() {
                folder_count += 1;
                directories.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            file_count += 1;
            total_size += entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            let extension = path
                .extension()
                .map(|extension| extension.to_string_lossy().to_string())
                .unwrap_or_default();
            if is_audio_extension(&extension) {
                audio_count += 1;
                if subtitle_for_audio(source, &path).is_some() {
                    associated_subtitle_count += 1;
                }
            } else if is_subtitle_extension(&extension) {
                subtitle_count += 1;
            } else if is_image_extension(&extension) {
                image_count += 1;
            } else {
                other_count += 1;
            }
        }
    }

    Ok((
        file_count,
        folder_count,
        total_size,
        audio_count,
        subtitle_count,
        image_count,
        other_count,
        associated_subtitle_count,
    ))
}

#[tauri::command]
pub(crate) fn bootstrap_asmr(app: AppHandle) -> Result<AsmrBootstrapPayload, String> {
    ensure_vault_layout(&app)?;
    let index = load_asmr_index(&app)?;
    Ok(AsmrBootstrapPayload {
        works: index.works,
        dictionaries: index.dictionaries,
    })
}

#[tauri::command]
pub(crate) fn preview_asmr_import(
    app: AppHandle,
    input: PreviewAsmrImportInput,
) -> Result<AsmrImportPreview, String> {
    ensure_vault_layout(&app)?;
    let source = PathBuf::from(input.source_path);
    if !source.is_dir() {
        return Err("source path must be a directory".to_string());
    }

    let rj_id = match input.rj_id {
        Some(value) if !value.trim().is_empty() => normalize_rj_id(&value)?,
        _ => extract_rj_id_from_path(&source).ok_or_else(|| "RJ id is required".to_string())?,
    };
    let index = load_asmr_index(&app)?;
    let (
        file_count,
        folder_count,
        total_size,
        audio_count,
        subtitle_count,
        image_count,
        other_count,
        associated_subtitle_count,
    ) = scan_asmr_import_source(&source)?;

    Ok(AsmrImportPreview {
        source_path: source.display().to_string(),
        rj_id: rj_id.clone(),
        already_exists: index.works.iter().any(|work| work.rj_id == rj_id),
        file_count,
        folder_count,
        total_size,
        audio_count,
        subtitle_count,
        image_count,
        other_count,
        associated_subtitle_count,
        default_folder: find_default_asmr_folder(&source)?,
    })
}

fn asmr_payload_from_index(index: AsmrIndex) -> AsmrBootstrapPayload {
    AsmrBootstrapPayload {
        works: index.works,
        dictionaries: index.dictionaries,
    }
}

#[tauri::command]
pub(crate) fn import_asmr_work(
    app: AppHandle,
    input: ImportAsmrWorkInput,
) -> Result<AsmrWork, String> {
    ensure_vault_layout(&app)?;
    let source = PathBuf::from(input.source_path);
    if !source.is_dir() {
        return Err("source path must be a directory".to_string());
    }

    let rj_id = match input.rj_id {
        Some(value) if !value.trim().is_empty() => normalize_rj_id(&value)?,
        _ => extract_rj_id_from_path(&source).ok_or_else(|| "RJ id is required".to_string())?,
    };

    let mut index = load_asmr_index(&app)?;
    let overwrite = input.overwrite.unwrap_or(false);
    if index.works.iter().any(|work| work.rj_id == rj_id) && !overwrite {
        return Err("asmr work already exists".to_string());
    }

    let work_dir = asmr_work_dir(&app, &rj_id)?;
    if work_dir.exists() {
        if overwrite {
            fs::remove_dir_all(&work_dir)
                .map_err(|error| format!("failed to replace work dir: {error}"))?;
        } else {
            return Err("asmr work directory already exists".to_string());
        }
    }
    let files_dir = work_dir.join("files");
    copy_dir_recursive(&source, &files_dir)?;

    let ts = now_ts();
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            source
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| rj_id.clone())
        });
    let work = AsmrWork {
        rj_id: rj_id.clone(),
        title,
        circle: String::new(),
        voice_actors: Vec::new(),
        tags: Vec::new(),
        status: "new".to_string(),
        favorite: false,
        rating: None,
        note: String::new(),
        work_dir: work_dir.display().to_string(),
        files_dir: files_dir.display().to_string(),
        cover_path: None,
        thumbnail_path: None,
        last_opened_folder: find_default_asmr_folder(&files_dir)?,
        last_played_audio_path: None,
        last_position_ms: 0,
        imported_at: ts,
        updated_at: ts,
    };

    index.works.retain(|item| item.rj_id != rj_id);
    index.works.push(work.clone());
    save_asmr_index(&app, &index)?;
    Ok(work)
}

#[tauri::command]
pub(crate) fn update_asmr_work(
    app: AppHandle,
    input: UpdateAsmrWorkInput,
) -> Result<AsmrWork, String> {
    ensure_vault_layout(&app)?;
    let rj_id = normalize_rj_id(&input.rj_id)?;
    let mut index = load_asmr_index(&app)?;
    let work = index
        .works
        .iter_mut()
        .find(|work| work.rj_id == rj_id)
        .ok_or_else(|| "asmr work not found".to_string())?;

    work.title = input.title.trim().to_string();
    work.circle = input.circle.trim().to_string();
    work.voice_actors = normalized_string_list(&input.voice_actors);
    work.tags = normalized_string_list(&input.tags);
    work.status = normalize_asmr_status(&input.status);
    work.favorite = input.favorite;
    work.rating = input.rating.filter(|rating| *rating <= 5);
    work.note = input.note;
    work.updated_at = now_ts();

    let updated = work.clone();
    save_asmr_index(&app, &index)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn upsert_asmr_dictionary(
    app: AppHandle,
    input: UpsertAsmrDictionaryInput,
) -> Result<AsmrBootstrapPayload, String> {
    ensure_vault_layout(&app)?;
    let value = input.value.trim().to_string();
    if value.is_empty() {
        return Err("dictionary value is required".to_string());
    }

    let mut index = load_asmr_index(&app)?;
    {
        let values = dictionary_values_mut(&mut index.dictionaries, &input.kind)?;
        if let Some(old_value) = input
            .old_value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            values.retain(|item| item != old_value);
            for work in &mut index.works {
                rename_asmr_work_dictionary_value(work, &input.kind, old_value, &value);
            }
        }
        if !values.iter().any(|item| item == &value) {
            values.push(value);
        }
    }
    save_asmr_index(&app, &index)?;
    Ok(asmr_payload_from_index(load_asmr_index(&app)?))
}

#[tauri::command]
pub(crate) fn delete_asmr_dictionary(
    app: AppHandle,
    input: DeleteAsmrDictionaryInput,
) -> Result<AsmrBootstrapPayload, String> {
    ensure_vault_layout(&app)?;
    let value = input.value.trim().to_string();
    if value.is_empty() {
        return Err("dictionary value is required".to_string());
    }

    let mut index = load_asmr_index(&app)?;
    {
        let values = dictionary_values_mut(&mut index.dictionaries, &input.kind)?;
        values.retain(|item| item != &value);
    }
    for work in &mut index.works {
        delete_asmr_work_dictionary_value(work, &input.kind, &value);
    }
    save_asmr_index(&app, &index)?;
    Ok(asmr_payload_from_index(load_asmr_index(&app)?))
}

#[tauri::command]
pub(crate) fn list_asmr_folder(
    app: AppHandle,
    input: ListAsmrFolderInput,
) -> Result<AsmrFolderPayload, String> {
    ensure_vault_layout(&app)?;
    let rj_id = normalize_rj_id(&input.rj_id)?;
    let folder_path = validate_relative_path(&input.folder_path)?;
    let root = asmr_work_files_dir(&app, &rj_id)?;
    let folder = if folder_path.is_empty() {
        root.clone()
    } else {
        root.join(&folder_path)
    };

    if !folder.exists() || !folder.is_dir() {
        return Err("asmr folder not found".to_string());
    }

    let mut index = load_asmr_index(&app)?;
    if let Some(work) = index.works.iter_mut().find(|work| work.rj_id == rj_id) {
        work.last_opened_folder = if folder_path.is_empty() {
            None
        } else {
            Some(folder_path.clone())
        };
        work.updated_at = now_ts();
        save_asmr_index(&app, &index)?;
    }

    let mut items = Vec::new();
    for entry in
        fs::read_dir(&folder).map_err(|error| format!("failed to read asmr folder: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read asmr folder entry: {error}"))?;
        let path = entry.path();
        let Some(kind) = asmr_file_kind(&path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = path
            .strip_prefix(&root)
            .map_err(|error| format!("failed to resolve asmr file path: {error}"))?
            .to_string_lossy()
            .replace('\\', "/");
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        let subtitle_path = if kind == "audio" {
            subtitle_for_audio(&root, &path)
        } else {
            None
        };
        items.push(AsmrFileItem {
            name,
            relative_path,
            absolute_path: path.display().to_string(),
            kind,
            size,
            subtitle_path,
        });
    }

    items.sort_by(|left, right| {
        let left_rank = if left.kind == "folder" {
            0
        } else if left.kind == "audio" {
            1
        } else {
            2
        };
        let right_rank = if right.kind == "folder" {
            0
        } else if right.kind == "audio" {
            1
        } else {
            2
        };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(AsmrFolderPayload {
        rj_id,
        folder_path,
        items,
    })
}

#[tauri::command]
pub(crate) fn update_asmr_playback(
    app: AppHandle,
    input: UpdateAsmrPlaybackInput,
) -> Result<AsmrWork, String> {
    ensure_vault_layout(&app)?;
    let rj_id = normalize_rj_id(&input.rj_id)?;
    let audio_path = validate_relative_path(&input.audio_path)?;
    let mut index = load_asmr_index(&app)?;
    let work = index
        .works
        .iter_mut()
        .find(|work| work.rj_id == rj_id)
        .ok_or_else(|| "asmr work not found".to_string())?;
    work.last_played_audio_path = Some(audio_path);
    work.last_position_ms = input.position_ms;
    work.updated_at = now_ts();
    let updated = work.clone();
    save_asmr_index(&app, &index)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn set_asmr_cover(app: AppHandle, input: SetAsmrCoverInput) -> Result<AsmrWork, String> {
    ensure_vault_layout(&app)?;
    let rj_id = normalize_rj_id(&input.rj_id)?;
    let source = PathBuf::from(input.source_path);
    let mut index = load_asmr_index(&app)?;
    if !index.works.iter().any(|work| work.rj_id == rj_id) {
        return Err("asmr work not found".to_string());
    }

    let work_dir = asmr_work_dir(&app, &rj_id)?;
    let (cover_path, thumbnail_path) = copy_asmr_cover(&source, &work_dir)?;

    let work = index
        .works
        .iter_mut()
        .find(|work| work.rj_id == rj_id)
        .ok_or_else(|| "asmr work not found".to_string())?;
    work.cover_path = Some(cover_path.display().to_string());
    work.thumbnail_path = Some(thumbnail_path.display().to_string());
    work.updated_at = now_ts();
    let updated = work.clone();
    save_asmr_index(&app, &index)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn read_asmr_text_file(
    app: AppHandle,
    input: ReadAsmrTextFileInput,
) -> Result<String, String> {
    ensure_vault_layout(&app)?;
    let rj_id = normalize_rj_id(&input.rj_id)?;
    let relative_path = validate_relative_path(&input.relative_path)?;
    let root = asmr_work_files_dir(&app, &rj_id)?;
    let path = root.join(&relative_path);
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_string())
        .unwrap_or_default();
    if !is_subtitle_extension(&extension) {
        return Err("unsupported text file".to_string());
    }
    if !path.exists() || !path.is_file() {
        return Err("text file not found".to_string());
    }
    read_utf8_file(&path).map_err(|error| format!("failed to read text file: {error}"))
}
