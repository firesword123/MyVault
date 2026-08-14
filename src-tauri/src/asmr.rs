use crate::core::{
    asmr_index_path, asmr_works_dir, atomic_write_utf8_file, data_root_dir, ensure_asmr_layout,
    now_ts, read_utf8_file,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    io::Read,
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
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadAsmrTextFileInput {
    rj_id: String,
    relative_path: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoverStorageMigrationReport {
    migrated_at: u64,
    cleared_works: Vec<String>,
    removed_legacy_covers: Vec<String>,
    removed_thumbnails: Vec<String>,
    preserved_ambiguous_covers: Vec<String>,
}

fn default_asmr_index() -> AsmrIndex {
    AsmrIndex {
        version: crate::storage::DATA_SCHEMA_VERSION,
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
    let repaired_paths = repair_0_1_9_work_paths(&mut index);
    let cover_migration = migrate_legacy_cover_storage(app, &mut index)?;
    save_asmr_index(app, &index)?;
    if let Some(report) = cover_migration {
        write_cover_storage_migration_report(app, &report)?;
    }
    let archived_root_metadata = archive_misrouted_root_metadata(app, &index)?;
    if !repaired_paths.is_empty() || !archived_root_metadata.is_empty() {
        write_0_1_10_repair_report(app, &repaired_paths, &archived_root_metadata)?;
    }
    Ok(index)
}

fn repair_0_1_9_work_paths(index: &mut AsmrIndex) -> Vec<String> {
    let mut repaired = Vec::new();
    for work in &mut index.works {
        let Ok(rj_id) = normalize_rj_id(&work.rj_id) else {
            continue;
        };
        let expected_work_dir = format!("DL_ASMR/{rj_id}");
        let mut changed = false;
        if work.work_dir.replace('\\', "/") == rj_id {
            work.work_dir = expected_work_dir.clone();
            changed = true;
        }
        if work.files_dir.replace('\\', "/") == rj_id {
            work.files_dir = expected_work_dir.clone();
            changed = true;
        }
        if let Some(cover_path) = work.cover_path.as_mut() {
            let normalized = cover_path.replace('\\', "/");
            let wrong_prefix = format!("{rj_id}/");
            if normalized.starts_with(&wrong_prefix) {
                *cover_path = format!("DL_ASMR/{normalized}");
                changed = true;
            }
        }
        if changed {
            repaired.push(rj_id);
        }
    }
    repaired.sort();
    repaired.dedup();
    repaired
}

fn archive_misrouted_root_metadata(
    app: &AppHandle,
    index: &AsmrIndex,
) -> Result<Vec<String>, String> {
    let root = data_root_dir(app)?;
    archive_misrouted_root_metadata_at(&root, index)
}

fn archive_misrouted_root_metadata_at(
    root: &Path,
    index: &AsmrIndex,
) -> Result<Vec<String>, String> {
    let mut archived = Vec::new();
    for work in &index.works {
        let Ok(rj_id) = normalize_rj_id(&work.rj_id) else {
            continue;
        };
        let source_dir = root.join(&rj_id);
        let correct_dir = root.join("DL_ASMR").join(&rj_id);
        if !source_dir.is_dir() || !correct_dir.is_dir() {
            continue;
        }

        let entries = fs::read_dir(&source_dir)
            .map_err(|error| format!("failed to inspect misplaced {rj_id} metadata: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to inspect misplaced {rj_id} metadata: {error}"))?;
        let safe = entries.iter().all(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
                && matches!(
                    entry.file_name().to_string_lossy().as_ref(),
                    "_Work.json" | "_Work.json.bak"
                )
        });
        if !safe {
            continue;
        }

        let backup_dir = root
            .join("_MyVault/Backups/Repair-0.1.10/UnexpectedRootWorkMetadata")
            .join(&rj_id);
        fs::create_dir_all(&backup_dir)
            .map_err(|error| format!("failed to create repair backup for {rj_id}: {error}"))?;
        for entry in entries {
            let mut target = backup_dir.join(entry.file_name());
            if target.exists() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                target = backup_dir.join(format!("{file_name}-{}", uuid::Uuid::new_v4()));
            }
            fs::rename(entry.path(), &target).map_err(|error| {
                format!("failed to archive misplaced {rj_id} metadata: {error}")
            })?;
        }
        fs::remove_dir(&source_dir).map_err(|error| {
            format!("failed to remove empty misplaced {rj_id} directory: {error}")
        })?;
        archived.push(rj_id);
    }
    archived.sort();
    archived.dedup();
    Ok(archived)
}

fn write_0_1_10_repair_report(
    app: &AppHandle,
    repaired_paths: &[String],
    archived_root_metadata: &[String],
) -> Result<(), String> {
    let repaired_at = now_ts();
    let path = data_root_dir(app)?
        .join("_MyVault/RepairReports")
        .join(format!("dl-asmr-paths-0.1.10-{repaired_at}.json"));
    let raw = serde_json::to_string_pretty(&serde_json::json!({
        "version": "0.1.10",
        "repairedAt": repaired_at,
        "repairedLibraryPaths": repaired_paths,
        "archivedUnexpectedRootMetadata": archived_root_metadata,
    }))
    .map_err(|error| format!("failed to serialize DL_ASMR repair report: {error}"))?;
    atomic_write_utf8_file(&path, &raw)
        .map_err(|error| format!("failed to save DL_ASMR repair report: {error}"))
}

fn cover_storage_migration_path(root: &Path) -> PathBuf {
    root.join("_MyVault/Migrations/DL_ASMR-CoverPaths-v2.json")
}

fn is_legacy_cover_name(name: &str) -> bool {
    let path = Path::new(name);
    path.file_stem()
        .map(|stem| stem.to_string_lossy().eq_ignore_ascii_case("_Cover"))
        .unwrap_or(false)
        && path
            .extension()
            .map(|extension| is_cover_extension(&extension.to_string_lossy()))
            .unwrap_or(false)
}

fn indexed_legacy_cover_name(stored_path: &str, rj_id: &str) -> Option<String> {
    let normalized = stored_path.replace('\\', "/");
    let prefix = format!("DL_ASMR/{rj_id}/");
    if normalized.len() <= prefix.len()
        || !normalized
            .get(..prefix.len())
            .map(|value| value.eq_ignore_ascii_case(&prefix))
            .unwrap_or(false)
    {
        return None;
    }
    let name = &normalized[prefix.len()..];
    (!name.contains('/') && is_legacy_cover_name(name)).then(|| name.to_string())
}

fn relative_report_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn files_are_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_metadata = fs::metadata(left)
        .map_err(|error| format!("failed to inspect {}: {error}", left.display()))?;
    let right_metadata = fs::metadata(right)
        .map_err(|error| format!("failed to inspect {}: {error}", right.display()))?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }

    let mut left_file = fs::File::open(left)
        .map_err(|error| format!("failed to read {}: {error}", left.display()))?;
    let mut right_file = fs::File::open(right)
        .map_err(|error| format!("failed to read {}: {error}", right.display()))?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left_file
            .read(&mut left_buffer)
            .map_err(|error| format!("failed to read {}: {error}", left.display()))?;
        let right_read = right_file
            .read(&mut right_buffer)
            .map_err(|error| format!("failed to read {}: {error}", right.display()))?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn legacy_cover_has_user_copy(work_dir: &Path, legacy_cover: &Path) -> Result<bool, String> {
    if !is_supported_image_file(legacy_cover) {
        return Ok(false);
    }
    let legacy_size = fs::metadata(legacy_cover)
        .map_err(|error| format!("failed to inspect {}: {error}", legacy_cover.display()))?
        .len();
    let mut directories = VecDeque::from([work_dir.to_path_buf()]);
    while let Some(directory) = directories.pop_front() {
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| format!("failed to inspect {}: {error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to inspect {}: {error}", directory.display()))?;
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
        for entry in entries {
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
            if file_type.is_dir() {
                directories.push_back(path);
                continue;
            }
            if !file_type.is_file() || path == legacy_cover {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("_Work.json")
                || name.eq_ignore_ascii_case("_Work.json.bak")
                || is_legacy_cover_name(&name)
            {
                continue;
            }
            if entry.metadata().map(|metadata| metadata.len()).unwrap_or(0) == legacy_size
                && is_supported_image_file(&path)
                && files_are_equal(legacy_cover, &path)?
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn migrate_legacy_cover_storage(
    app: &AppHandle,
    index: &mut AsmrIndex,
) -> Result<Option<CoverStorageMigrationReport>, String> {
    let root = data_root_dir(app)?;
    migrate_legacy_cover_storage_at(&root, index)
}

fn migrate_legacy_cover_storage_at(
    root: &Path,
    index: &mut AsmrIndex,
) -> Result<Option<CoverStorageMigrationReport>, String> {
    if cover_storage_migration_path(root).exists() {
        return Ok(None);
    }

    let mut report = CoverStorageMigrationReport {
        migrated_at: now_ts(),
        ..CoverStorageMigrationReport::default()
    };
    for work in &mut index.works {
        let rj_id = normalize_rj_id(&work.rj_id)?;
        let work_dir = root.join("DL_ASMR").join(&rj_id);
        let indexed_legacy_name = work
            .cover_path
            .as_deref()
            .and_then(|path| indexed_legacy_cover_name(path, &rj_id));
        if indexed_legacy_name.is_some() {
            work.cover_path = None;
            report.cleared_works.push(rj_id.clone());
        }
        if work.thumbnail_path.take().is_some() {
            report.cleared_works.push(rj_id.clone());
        }

        let thumbnail = root
            .join("_MyVault/Index/DL_ASMR/Thumbnails")
            .join(format!("{rj_id}.jpg"));
        if thumbnail.is_file() {
            fs::remove_file(&thumbnail).map_err(|error| {
                format!(
                    "failed to remove legacy DL_ASMR thumbnail {}: {error}",
                    thumbnail.display()
                )
            })?;
            report
                .removed_thumbnails
                .push(relative_report_path(root, &thumbnail));
        }

        if !work_dir.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&work_dir)
            .map_err(|error| format!("failed to inspect {}: {error}", work_dir.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to inspect {}: {error}", work_dir.display()))?;
        for entry in entries {
            let path = entry.path();
            if !entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_legacy_cover_name(&name) {
                continue;
            }
            let indexed = indexed_legacy_name
                .as_deref()
                .map(|indexed_name| indexed_name.eq_ignore_ascii_case(&name))
                .unwrap_or(false);
            if indexed || legacy_cover_has_user_copy(&work_dir, &path)? {
                fs::remove_file(&path).map_err(|error| {
                    format!(
                        "failed to remove legacy DL_ASMR cover {}: {error}",
                        path.display()
                    )
                })?;
                report
                    .removed_legacy_covers
                    .push(relative_report_path(root, &path));
            } else {
                report
                    .preserved_ambiguous_covers
                    .push(relative_report_path(root, &path));
            }
        }
    }

    report.cleared_works.sort();
    report.cleared_works.dedup();
    report.removed_legacy_covers.sort();
    report.removed_thumbnails.sort();
    report.preserved_ambiguous_covers.sort();
    for directory in [
        root.join("_MyVault/Index/DL_ASMR/Thumbnails"),
        root.join("_MyVault/Index/DL_ASMR"),
        root.join("_MyVault/Index"),
    ] {
        if directory.is_dir()
            && fs::read_dir(&directory)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
        {
            let _ = fs::remove_dir(&directory);
        }
    }
    Ok(Some(report))
}

fn write_cover_storage_migration_report(
    app: &AppHandle,
    report: &CoverStorageMigrationReport,
) -> Result<(), String> {
    let path = cover_storage_migration_path(&data_root_dir(app)?);
    let raw = serde_json::to_string_pretty(report)
        .map_err(|error| format!("failed to serialize cover storage migration: {error}"))?;
    atomic_write_utf8_file(&path, &raw)
        .map_err(|error| format!("failed to save cover storage migration report: {error}"))
}

fn save_asmr_index(app: &AppHandle, index: &AsmrIndex) -> Result<(), String> {
    let mut normalized = index.clone();
    normalize_asmr_index(&mut normalized);
    let raw = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("failed to serialize asmr index: {error}"))?;
    atomic_write_utf8_file(&asmr_index_path(app)?, &raw)
        .map_err(|error| format!("failed to save DL_ASMR index: {error}"))?;
    for work in &normalized.works {
        let work_dir = stored_path(app, &work.work_dir)?;
        fs::create_dir_all(&work_dir)
            .map_err(|error| format!("failed to create DL_ASMR work directory: {error}"))?;
        let work_raw = serde_json::to_string_pretty(work)
            .map_err(|error| format!("failed to serialize DL_ASMR work: {error}"))?;
        atomic_write_utf8_file(&work_dir.join("_Work.json"), &work_raw)
            .map_err(|error| format!("failed to save DL_ASMR work metadata: {error}"))?;
    }
    Ok(())
}

fn normalize_asmr_index(index: &mut AsmrIndex) {
    index.version = crate::storage::DATA_SCHEMA_VERSION;
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

    let candidate = Path::new(&normalized);
    let valid = normalized
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && !candidate.is_absolute()
        && candidate
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)));
    if valid {
        Ok(normalized)
    } else {
        Err("invalid relative path".to_string())
    }
}

fn stored_path(app: &AppHandle, value: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(value)?;
    if relative.is_empty() {
        return Err("stored DL_ASMR path is empty".to_string());
    }
    Ok(data_root_dir(app)?.join(relative))
}

fn frontend_absolute_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(network_path) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{network_path}")
    } else if let Some(local_path) = value.strip_prefix(r"\\?\") {
        local_path.to_string()
    } else {
        value.into_owned()
    }
}

fn relative_data_path(app: &AppHandle, path: &Path) -> Result<String, String> {
    path.strip_prefix(data_root_dir(app)?)
        .map_err(|error| format!("failed to make DL_ASMR path relative: {error}"))
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn hydrate_work(app: &AppHandle, work: &AsmrWork) -> Result<AsmrWork, String> {
    let mut hydrated = work.clone();
    hydrated.work_dir = frontend_absolute_path(&stored_path(app, &work.work_dir)?);
    hydrated.files_dir = frontend_absolute_path(&stored_path(app, &work.files_dir)?);
    hydrated.cover_path = work
        .cover_path
        .as_deref()
        .map(|path| stored_path(app, path).map(|value| frontend_absolute_path(&value)))
        .transpose()?;
    hydrated.thumbnail_path = work
        .thumbnail_path
        .as_deref()
        .map(|path| stored_path(app, path).map(|value| frontend_absolute_path(&value)))
        .transpose()?;
    Ok(hydrated)
}

fn asmr_work_dir(app: &AppHandle, rj_id: &str) -> Result<PathBuf, String> {
    Ok(asmr_works_dir(app)?.join(normalize_rj_id(rj_id)?))
}

fn asmr_work_files_dir(app: &AppHandle, rj_id: &str) -> Result<PathBuf, String> {
    asmr_work_dir(app, rj_id)
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

fn asmr_file_kind(path: &Path) -> String {
    if path.is_dir() {
        return "folder".to_string();
    }
    if is_supported_image_file(path) {
        return "image".to_string();
    }
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_string())
        .unwrap_or_default();
    if is_audio_extension(&extension) {
        "audio".to_string()
    } else if is_subtitle_extension(&extension) {
        "subtitle".to_string()
    } else {
        "file".to_string()
    }
}

fn should_hide_work_file(name: &str) -> bool {
    name.eq_ignore_ascii_case("_Work.json")
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

fn supported_image_format(path: &Path) -> Option<image::ImageFormat> {
    let reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let format = reader.format()?;
    matches!(
        format,
        image::ImageFormat::Jpeg
            | image::ImageFormat::Png
            | image::ImageFormat::Gif
            | image::ImageFormat::WebP
            | image::ImageFormat::Bmp
    )
    .then_some(format)
}

fn is_supported_image_file(path: &Path) -> bool {
    path.is_file() && supported_image_format(path).is_some()
}

fn find_first_image_file(root: &Path) -> Result<Option<PathBuf>, String> {
    let mut directories = VecDeque::from([root.to_path_buf()]);
    while let Some(directory) = directories.pop_front() {
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| {
                format!(
                    "failed to scan {} for cover images: {error}",
                    directory.display()
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                format!(
                    "failed to scan {} for cover images: {error}",
                    directory.display()
                )
            })?;
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());

        for entry in &entries {
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("_Work.json")
                || name.eq_ignore_ascii_case("_Work.json.bak")
                || is_legacy_cover_name(&name)
            {
                continue;
            }
            if is_supported_image_file(&path) {
                return Ok(Some(path));
            }
        }
        for entry in entries {
            let path = entry.path();
            if entry
                .file_type()
                .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?
                .is_dir()
            {
                directories.push_back(path);
            }
        }
    }
    Ok(None)
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
            } else if is_supported_image_file(&path) {
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
    ensure_asmr_layout(&app)?;
    let index = load_asmr_index(&app)?;
    Ok(AsmrBootstrapPayload {
        works: index
            .works
            .iter()
            .map(|work| hydrate_work(&app, work))
            .collect::<Result<Vec<_>, _>>()?,
        dictionaries: index.dictionaries,
    })
}

#[tauri::command]
pub(crate) fn preview_asmr_import(
    app: AppHandle,
    input: PreviewAsmrImportInput,
) -> Result<AsmrImportPreview, String> {
    ensure_asmr_layout(&app)?;
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

fn asmr_payload_from_index(
    app: &AppHandle,
    index: AsmrIndex,
) -> Result<AsmrBootstrapPayload, String> {
    Ok(AsmrBootstrapPayload {
        works: index
            .works
            .iter()
            .map(|work| hydrate_work(app, work))
            .collect::<Result<Vec<_>, _>>()?,
        dictionaries: index.dictionaries,
    })
}

#[tauri::command]
pub(crate) fn import_asmr_work(
    app: AppHandle,
    input: ImportAsmrWorkInput,
) -> Result<AsmrWork, String> {
    ensure_asmr_layout(&app)?;
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
    if work_dir.exists() && !overwrite {
        return Err("DL_ASMR work directory already exists".to_string());
    }
    let importing_dir = data_root_dir(&app)?
        .join("_MyVault/Importing")
        .join(format!("{}-{}", rj_id, uuid::Uuid::new_v4()));
    copy_dir_recursive(&source, &importing_dir)?;

    let mut backup_path = None;
    if work_dir.exists() {
        let backup = data_root_dir(&app)?
            .join("_MyVault/Backups/DL_ASMR")
            .join(format!("{}-{}", rj_id, now_ts()));
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to prepare DL_ASMR backup: {error}"))?;
        }
        fs::rename(&work_dir, &backup)
            .map_err(|error| format!("failed to preserve previous DL_ASMR work: {error}"))?;
        backup_path = Some(backup);
    }
    if let Err(error) = fs::rename(&importing_dir, &work_dir) {
        if let Some(backup) = backup_path {
            let _ = fs::rename(backup, &work_dir);
        }
        return Err(format!("failed to activate imported DL_ASMR work: {error}"));
    }
    let files_dir = work_dir.clone();
    let auto_cover_path = find_first_image_file(&files_dir)?
        .map(|path| relative_data_path(&app, &path))
        .transpose()?;

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
        work_dir: relative_data_path(&app, &work_dir)?,
        files_dir: relative_data_path(&app, &files_dir)?,
        cover_path: auto_cover_path,
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
    hydrate_work(&app, &work)
}

#[tauri::command]
pub(crate) fn update_asmr_work(
    app: AppHandle,
    input: UpdateAsmrWorkInput,
) -> Result<AsmrWork, String> {
    ensure_asmr_layout(&app)?;
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
    hydrate_work(&app, &updated)
}

#[tauri::command]
pub(crate) fn upsert_asmr_dictionary(
    app: AppHandle,
    input: UpsertAsmrDictionaryInput,
) -> Result<AsmrBootstrapPayload, String> {
    ensure_asmr_layout(&app)?;
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
    asmr_payload_from_index(&app, load_asmr_index(&app)?)
}

#[tauri::command]
pub(crate) fn delete_asmr_dictionary(
    app: AppHandle,
    input: DeleteAsmrDictionaryInput,
) -> Result<AsmrBootstrapPayload, String> {
    ensure_asmr_layout(&app)?;
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
    asmr_payload_from_index(&app, load_asmr_index(&app)?)
}

#[tauri::command]
pub(crate) fn list_asmr_folder(
    app: AppHandle,
    input: ListAsmrFolderInput,
) -> Result<AsmrFolderPayload, String> {
    ensure_asmr_layout(&app)?;
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
        let name = entry.file_name().to_string_lossy().to_string();
        if should_hide_work_file(&name) {
            continue;
        }
        let kind = asmr_file_kind(&path);
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
            absolute_path: frontend_absolute_path(&path),
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
        } else if left.kind == "image" {
            2
        } else if left.kind == "subtitle" {
            3
        } else {
            4
        };
        let right_rank = if right.kind == "folder" {
            0
        } else if right.kind == "audio" {
            1
        } else if right.kind == "image" {
            2
        } else if right.kind == "subtitle" {
            3
        } else {
            4
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
    ensure_asmr_layout(&app)?;
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
    hydrate_work(&app, &updated)
}

#[tauri::command]
pub(crate) fn set_asmr_cover(app: AppHandle, input: SetAsmrCoverInput) -> Result<AsmrWork, String> {
    ensure_asmr_layout(&app)?;
    let rj_id = normalize_rj_id(&input.rj_id)?;
    let relative_path = validate_relative_path(&input.relative_path)?;
    if relative_path.is_empty() {
        return Err("cover path is required".to_string());
    }
    let file_name = Path::new(&relative_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "cover path must identify a file".to_string())?;
    if is_legacy_cover_name(&file_name) {
        return Err("legacy _Cover files cannot be selected as cover".to_string());
    }
    let work_dir = asmr_work_dir(&app, &rj_id)?;
    let source = work_dir.join(&relative_path);
    if !source.is_file() || !is_supported_image_file(&source) {
        return Err("selected work file is not a supported image".to_string());
    }
    let canonical_work_dir = fs::canonicalize(&work_dir)
        .map_err(|error| format!("failed to resolve work directory: {error}"))?;
    let canonical_source = fs::canonicalize(&source)
        .map_err(|error| format!("failed to resolve cover image: {error}"))?;
    if !canonical_source.starts_with(&canonical_work_dir) {
        return Err("cover image must stay inside the work directory".to_string());
    }

    let mut index = load_asmr_index(&app)?;
    if !index.works.iter().any(|work| work.rj_id == rj_id) {
        return Err("asmr work not found".to_string());
    }

    let work = index
        .works
        .iter_mut()
        .find(|work| work.rj_id == rj_id)
        .ok_or_else(|| "asmr work not found".to_string())?;
    work.cover_path = Some(relative_data_path(&app, &source)?);
    work.thumbnail_path = None;
    work.updated_at = now_ts();
    let updated = work.clone();
    save_asmr_index(&app, &index)?;
    hydrate_work(&app, &updated)
}

#[tauri::command]
pub(crate) fn read_asmr_text_file(
    app: AppHandle,
    input: ReadAsmrTextFileInput,
) -> Result<String, String> {
    ensure_asmr_layout(&app)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_work() -> AsmrWork {
        AsmrWork {
            rj_id: "RJ123".to_string(),
            title: "Work".to_string(),
            circle: String::new(),
            voice_actors: Vec::new(),
            tags: Vec::new(),
            status: "new".to_string(),
            favorite: false,
            rating: None,
            note: String::new(),
            work_dir: "RJ123".to_string(),
            files_dir: "RJ123".to_string(),
            cover_path: Some("RJ123/_Cover.png".to_string()),
            thumbnail_path: Some("_MyVault/Index/DL_ASMR/Thumbnails/RJ123.jpg".to_string()),
            last_opened_folder: None,
            last_played_audio_path: None,
            last_position_ms: 0,
            imported_at: 1,
            updated_at: 1,
        }
    }

    fn sample_index() -> AsmrIndex {
        AsmrIndex {
            version: 2,
            works: vec![sample_work()],
            dictionaries: AsmrDictionaries::default(),
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("myvault-asmr-{label}-{}", uuid::Uuid::new_v4()))
    }

    fn write_test_image(path: &Path, format: image::ImageFormat, size: u32) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        image::DynamicImage::new_rgba8(size, size)
            .save_with_format(path, format)
            .unwrap();
    }

    #[test]
    fn detects_supported_images_from_contents_instead_of_extension() {
        let root = temp_root("image-header");
        let disguised_webp = root.join("cover.jpg");
        write_test_image(&disguised_webp, image::ImageFormat::WebP, 2);

        assert_eq!(
            supported_image_format(&disguised_webp),
            Some(image::ImageFormat::WebP)
        );
        assert_eq!(asmr_file_kind(&disguised_webp), "image");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn first_cover_scan_is_sorted_and_prefers_the_current_directory() {
        let root = temp_root("cover-scan");
        write_test_image(
            &root.join("nested/00-nested.png"),
            image::ImageFormat::Png,
            2,
        );
        write_test_image(&root.join("20-cover.png"), image::ImageFormat::Png, 2);
        write_test_image(&root.join("10-cover.png"), image::ImageFormat::Png, 2);

        assert_eq!(
            find_first_image_file(&root).unwrap(),
            Some(root.join("10-cover.png"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn only_proven_duplicate_or_indexed_legacy_covers_are_removable() {
        assert_eq!(
            indexed_legacy_cover_name("DL_ASMR/RJ123/_Cover.jpg", "RJ123").as_deref(),
            Some("_Cover.jpg")
        );
        assert!(indexed_legacy_cover_name("DL_ASMR/RJ123/user-cover.jpg", "RJ123").is_none());
        assert!(indexed_legacy_cover_name("DL_ASMR/RJ999/_Cover.jpg", "RJ123").is_none());

        let duplicate_root = temp_root("duplicate-cover");
        let original = duplicate_root.join("RJ123.jpg");
        let legacy = duplicate_root.join("_Cover.jpg");
        write_test_image(&original, image::ImageFormat::WebP, 2);
        fs::copy(&original, &legacy).unwrap();
        assert!(legacy_cover_has_user_copy(&duplicate_root, &legacy).unwrap());

        let unique_root = temp_root("unique-cover");
        let unique_legacy = unique_root.join("_Cover.png");
        write_test_image(&unique_legacy, image::ImageFormat::Png, 3);
        assert!(!legacy_cover_has_user_copy(&unique_root, &unique_legacy).unwrap());

        let _ = fs::remove_dir_all(duplicate_root);
        let _ = fs::remove_dir_all(unique_root);
    }

    #[test]
    fn cover_migration_removes_owned_files_and_preserves_ambiguous_user_data() {
        let root = temp_root("cover-migration");
        let work_dir = root.join("DL_ASMR/RJ123");
        let original = work_dir.join("RJ123.jpg");
        let indexed_legacy = work_dir.join("_Cover.jpg");
        let ambiguous_legacy = work_dir.join("_Cover.png");
        let thumbnail = root.join("_MyVault/Index/DL_ASMR/Thumbnails/RJ123.jpg");
        write_test_image(&original, image::ImageFormat::WebP, 2);
        fs::copy(&original, &indexed_legacy).unwrap();
        write_test_image(&ambiguous_legacy, image::ImageFormat::Png, 3);
        write_test_image(&thumbnail, image::ImageFormat::Jpeg, 2);

        let mut index = sample_index();
        index.works[0].work_dir = "DL_ASMR/RJ123".to_string();
        index.works[0].files_dir = "DL_ASMR/RJ123".to_string();
        index.works[0].cover_path = Some("DL_ASMR/RJ123/_Cover.jpg".to_string());
        let report = migrate_legacy_cover_storage_at(&root, &mut index)
            .unwrap()
            .unwrap();

        assert!(original.is_file());
        assert!(!indexed_legacy.exists());
        assert!(ambiguous_legacy.is_file());
        assert!(!thumbnail.exists());
        assert!(index.works[0].cover_path.is_none());
        assert!(index.works[0].thumbnail_path.is_none());
        assert_eq!(
            report.removed_legacy_covers,
            vec!["DL_ASMR/RJ123/_Cover.jpg".to_string()]
        );
        assert_eq!(
            report.preserved_ambiguous_covers,
            vec!["DL_ASMR/RJ123/_Cover.png".to_string()]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ordinary_work_files_are_classified_instead_of_filtered() {
        let root = temp_root("ordinary-file");
        fs::create_dir_all(&root).unwrap();
        let readme = root.join("readme.txt");
        let archive = root.join("resources.zip");
        fs::write(&readme, "readme").unwrap();
        fs::write(&archive, "archive").unwrap();
        assert_eq!(asmr_file_kind(&readme), "file");
        assert_eq!(asmr_file_kind(&archive), "file");
        assert!(should_hide_work_file("_Work.json"));
        assert!(!should_hide_work_file("_Work.json.bak"));
        assert!(!should_hide_work_file("_Cover.jpg"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn repairs_paths_written_by_0_1_9() {
        let mut index = sample_index();
        assert_eq!(
            repair_0_1_9_work_paths(&mut index),
            vec!["RJ123".to_string()]
        );
        let work = &index.works[0];
        assert_eq!(work.work_dir, "DL_ASMR/RJ123");
        assert_eq!(work.files_dir, "DL_ASMR/RJ123");
        assert_eq!(work.cover_path.as_deref(), Some("DL_ASMR/RJ123/_Cover.png"));
        assert!(repair_0_1_9_work_paths(&mut index).is_empty());
    }

    #[test]
    fn archives_only_safe_misrouted_root_metadata() {
        let root = temp_root("repair");
        fs::create_dir_all(root.join("DL_ASMR/RJ123")).unwrap();
        fs::create_dir_all(root.join("RJ123")).unwrap();
        fs::write(root.join("RJ123/_Work.json"), "wrong path metadata").unwrap();
        fs::write(root.join("RJ123/_Work.json.bak"), "older metadata").unwrap();

        let archived = archive_misrouted_root_metadata_at(&root, &sample_index()).unwrap();
        assert_eq!(archived, vec!["RJ123".to_string()]);
        assert!(!root.join("RJ123").exists());
        assert!(root
            .join("_MyVault/Backups/Repair-0.1.10/UnexpectedRootWorkMetadata/RJ123/_Work.json")
            .is_file());
        assert!(root
            .join("_MyVault/Backups/Repair-0.1.10/UnexpectedRootWorkMetadata/RJ123/_Work.json.bak")
            .is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_a_misrouted_directory_if_it_contains_user_data() {
        let root = temp_root("unsafe-repair");
        fs::create_dir_all(root.join("DL_ASMR/RJ123")).unwrap();
        fs::create_dir_all(root.join("RJ123")).unwrap();
        fs::write(root.join("RJ123/_Work.json"), "metadata").unwrap();
        fs::write(root.join("RJ123/audio.flac"), "user data").unwrap();

        assert!(archive_misrouted_root_metadata_at(&root, &sample_index())
            .unwrap()
            .is_empty());
        assert!(root.join("RJ123/audio.flac").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn strips_windows_verbatim_prefixes_from_frontend_paths() {
        assert_eq!(
            frontend_absolute_path(Path::new(r"\\?\E:\MyVaultData\DL_ASMR\track.mp3")),
            r"E:\MyVaultData\DL_ASMR\track.mp3"
        );
        assert_eq!(
            frontend_absolute_path(Path::new(r"\\?\UNC\server\share\track.mp3")),
            r"\\server\share\track.mp3"
        );
    }
}
