use crate::core::{
    drafts_dir, ensure_vault_layout, load_settings, notes_dir, now_ts, read_utf8_file,
    save_settings_file, trash_dir, vault_dir, write_utf8_file, AppSettings, DRAFTS_FOLDER,
    INBOX_FOLDER, TRASH_FOLDER,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

const DEFAULT_NOTE_BODY: &str = "# Welcome to MyVault\n\nStart writing here.";
static NOTE_ID_SEED: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapPayload {
    vault_path: String,
    notes: Vec<NoteSummary>,
    folders: Vec<String>,
    settings: AppSettings,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePayload {
    notes: Vec<NoteSummary>,
    folders: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteSummary {
    id: String,
    title: String,
    relative_path: String,
    folder_path: String,
    is_draft: bool,
    is_trashed: bool,
    updated_at: u64,
    preview: String,
    original_folder_path: Option<String>,
    deleted_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteDetail {
    id: String,
    title: String,
    content: String,
    created_at: u64,
    updated_at: u64,
    relative_path: String,
    folder_path: String,
    is_draft: bool,
    is_trashed: bool,
    original_folder_path: Option<String>,
    deleted_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateNoteInput {
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveNoteInput {
    id: String,
    title: String,
    content: String,
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateFolderInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameFolderInput {
    from_path: String,
    to_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteFolderInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveNoteInput {
    id: String,
    folder_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotesStateInput {
    selected_note_id: String,
}

#[derive(Clone)]
struct NoteDocument {
    id: String,
    title: String,
    content: String,
    created_at: u64,
    updated_at: u64,
    original_folder_path: Option<String>,
    deleted_at: Option<u64>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_title(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "Untitled Note".to_string()
    } else {
        trimmed.replace(['\r', '\n'], " ")
    }
}

fn note_file_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_note_id(id)?;
    Ok(drafts_dir(app)?.join(format!("{id}.md")))
}

fn note_file_path_in_folder(app: &AppHandle, folder: &str, id: &str) -> Result<PathBuf, String> {
    validate_note_id(id)?;
    let normalized = normalize_folder_path(folder)?;
    Ok(notes_dir(app)?.join(normalized).join(format!("{id}.md")))
}

fn validate_note_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');

    if valid {
        Ok(())
    } else {
        Err("invalid note id".to_string())
    }
}

fn normalize_folder_path(folder: &str) -> Result<String, String> {
    let trimmed = folder.trim().trim_matches('/').replace('\\', "/");
    if trimmed.is_empty() {
        return Ok(INBOX_FOLDER.to_string());
    }

    let valid = trimmed
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..");

    if valid {
        Ok(trimmed)
    } else {
        Err("invalid folder path".to_string())
    }
}

fn is_system_folder(folder: &str) -> bool {
    matches!(folder, DRAFTS_FOLDER | INBOX_FOLDER | TRASH_FOLDER)
}

fn is_inside_system_folder(folder: &str) -> bool {
    [DRAFTS_FOLDER, INBOX_FOLDER, TRASH_FOLDER]
        .iter()
        .any(|system| folder == *system || folder.starts_with(&format!("{system}/")))
}

fn serialize_note(document: &NoteDocument) -> String {
    format!(
        "---\nid: {}\ntitle: {}\ncreated_at: {}\nupdated_at: {}\noriginal_folder_path: {}\ndeleted_at: {}\n---\n{}",
        document.id,
        document.title,
        document.created_at,
        document.updated_at,
        document.original_folder_path.as_deref().unwrap_or(""),
        document
            .deleted_at
            .map(|value| value.to_string())
            .unwrap_or_default(),
        document.content
    )
}

fn parse_note(id: String, raw: &str) -> NoteDocument {
    let fallback_ts = now_ts();

    if !raw.starts_with("---\n") {
        return NoteDocument {
            id,
            title: "Untitled Note".to_string(),
            content: raw.to_string(),
            created_at: fallback_ts,
            updated_at: fallback_ts,
            original_folder_path: None,
            deleted_at: None,
        };
    }

    let mut parts = raw.splitn(3, "---\n");
    let _ = parts.next();
    let metadata = parts.next().unwrap_or_default();
    let content = parts.next().unwrap_or_default().to_string();

    let mut title = "Untitled Note".to_string();
    let mut created_at = fallback_ts;
    let mut updated_at = fallback_ts;
    let mut original_folder_path = None;
    let mut deleted_at = None;

    for line in metadata.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let normalized = value.trim();
            match key.trim() {
                "title" => title = sanitize_title(normalized),
                "created_at" => {
                    created_at = normalized.parse::<u64>().unwrap_or(fallback_ts);
                }
                "updated_at" => {
                    updated_at = normalized.parse::<u64>().unwrap_or(fallback_ts);
                }
                "original_folder_path" => {
                    if !normalized.is_empty() {
                        original_folder_path = Some(normalized.to_string());
                    }
                }
                "deleted_at" => {
                    if !normalized.is_empty() {
                        deleted_at = normalized.parse::<u64>().ok();
                    }
                }
                _ => {}
            }
        }
    }

    NoteDocument {
        id,
        title,
        content,
        created_at,
        updated_at,
        original_folder_path,
        deleted_at,
    }
}

fn load_note_document(path: &Path) -> Result<NoteDocument, String> {
    let raw = read_utf8_file(path).map_err(|error| format!("failed to read note: {error}"))?;
    let id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| "failed to resolve note file id".to_string())?
        .to_string();

    Ok(parse_note(id, &raw))
}

fn folder_path_from_note_path(app: &AppHandle, path: &Path) -> Result<String, String> {
    let notes_root = notes_dir(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve note parent directory".to_string())?;
    let relative = parent
        .strip_prefix(&notes_root)
        .map_err(|error| format!("failed to resolve folder path: {error}"))?;

    let folder = relative.to_string_lossy().replace('\\', "/");
    if folder.is_empty() {
        Ok(INBOX_FOLDER.to_string())
    } else {
        Ok(folder)
    }
}

fn is_draft_folder(folder: &str) -> bool {
    folder == DRAFTS_FOLDER
}

fn is_trash_folder(folder: &str) -> bool {
    folder == TRASH_FOLDER
}

fn can_delete_note_permanently(folder: &str) -> bool {
    is_trash_folder(folder)
}

fn find_note_path_by_id(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_note_id(id)?;
    let root = notes_dir(app)?;
    let mut stack = vec![root];

    while let Some(current) = stack.pop() {
        for entry in
            fs::read_dir(&current).map_err(|error| format!("failed to scan notes: {error}"))?
        {
            let entry = entry.map_err(|error| format!("failed to scan note entry: {error}"))?;
            let path = entry.path();

            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if path.is_file() && path.file_stem().and_then(|stem| stem.to_str()) == Some(id) {
                return Ok(path);
            }
        }
    }

    Err("note not found".to_string())
}

fn note_id_exists(app: &AppHandle, id: &str) -> bool {
    find_note_path_by_id(app, id).is_ok()
}

fn next_note_id(app: &AppHandle) -> String {
    loop {
        let candidate_seed = now_millis().max(NOTE_ID_SEED.fetch_add(1, Ordering::Relaxed) + 1);
        let candidate = format!("note-{candidate_seed}");

        if !note_id_exists(app, &candidate) {
            NOTE_ID_SEED.store(candidate_seed, Ordering::Relaxed);
            return candidate;
        }
    }
}

fn extract_plain_text(content: &str) -> String {
    let mut output = String::with_capacity(content.len());
    let mut in_tag = false;

    for ch in content.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            '&' if !in_tag => output.push(' '),
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }

    output
}

fn preview_from_content(content: &str) -> String {
    extract_plain_text(content)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Empty note")
        .chars()
        .take(120)
        .collect()
}

fn note_to_summary(
    app: &AppHandle,
    path: &Path,
    document: &NoteDocument,
) -> Result<NoteSummary, String> {
    let folder_path = folder_path_from_note_path(app, path)?;
    Ok(NoteSummary {
        id: document.id.clone(),
        title: document.title.clone(),
        relative_path: format!("notes/{folder_path}/{}.md", document.id),
        folder_path: folder_path.clone(),
        is_draft: is_draft_folder(&folder_path),
        is_trashed: is_trash_folder(&folder_path),
        updated_at: document.updated_at,
        preview: preview_from_content(&document.content),
        original_folder_path: document.original_folder_path.clone(),
        deleted_at: document.deleted_at,
    })
}

fn note_to_detail(
    app: &AppHandle,
    path: &Path,
    document: NoteDocument,
) -> Result<NoteDetail, String> {
    let folder_path = folder_path_from_note_path(app, path)?;
    Ok(NoteDetail {
        id: document.id.clone(),
        title: document.title.clone(),
        content: document.content.clone(),
        created_at: document.created_at,
        updated_at: document.updated_at,
        relative_path: format!("notes/{folder_path}/{}.md", document.id),
        folder_path: folder_path.clone(),
        is_draft: is_draft_folder(&folder_path),
        is_trashed: is_trash_folder(&folder_path),
        original_folder_path: document.original_folder_path,
        deleted_at: document.deleted_at,
    })
}

fn collect_notes(app: &AppHandle) -> Result<Vec<NoteSummary>, String> {
    let notes = notes_dir(app)?;
    let mut directories = vec![notes];
    let mut items = Vec::new();

    while let Some(current_dir) = directories.pop() {
        let entries = fs::read_dir(&current_dir)
            .map_err(|error| format!("failed to read notes dir: {error}"))?;

        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read note entry: {error}"))?;
            let path = entry.path();

            if path.is_dir() {
                directories.push(path);
                continue;
            }

            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }

            let document = load_note_document(&path)?;
            items.push(note_to_summary(app, &path, &document)?);
        }
    }

    items.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(items)
}

fn collect_folders(app: &AppHandle) -> Result<Vec<String>, String> {
    let root = notes_dir(app)?;
    let mut directories = vec![root.clone()];
    let mut folders = Vec::new();

    while let Some(current_dir) = directories.pop() {
        let entries = fs::read_dir(&current_dir)
            .map_err(|error| format!("failed to read folders dir: {error}"))?;

        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read folder entry: {error}"))?;
            let path = entry.path();

            if !path.is_dir() {
                continue;
            }

            let relative = path
                .strip_prefix(&root)
                .map_err(|error| format!("failed to resolve folder relative path: {error}"))?;

            let folder = relative.to_string_lossy().replace('\\', "/");
            if !folder.is_empty() {
                folders.push(folder);
            }

            directories.push(path);
        }
    }

    folders.sort_by(|left, right| {
        let rank = |value: &str| {
            if value == DRAFTS_FOLDER {
                0
            } else if value == INBOX_FOLDER {
                1
            } else if value == TRASH_FOLDER {
                3
            } else {
                2
            }
        };

        rank(left).cmp(&rank(right)).then_with(|| left.cmp(right))
    });
    folders.dedup();
    Ok(folders)
}

fn workspace_payload(app: &AppHandle) -> Result<WorkspacePayload, String> {
    Ok(WorkspacePayload {
        notes: collect_notes(app)?,
        folders: collect_folders(app)?,
    })
}

fn folder_contains_notes(app: &AppHandle, folder: &str) -> Result<bool, String> {
    let normalized = normalize_folder_path(folder)?;
    let target_dir = notes_dir(app)?.join(&normalized);
    if !target_dir.exists() {
        return Ok(false);
    }

    let mut directories = vec![target_dir];
    while let Some(current_dir) = directories.pop() {
        let entries = fs::read_dir(&current_dir)
            .map_err(|error| format!("failed to scan folder: {error}"))?;

        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read folder entry: {error}"))?;
            let path = entry.path();

            if path.is_dir() {
                directories.push(path);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

fn seed_default_note(app: &AppHandle) -> Result<(), String> {
    if !collect_notes(app)?.is_empty() {
        return Ok(());
    }

    let ts = now_ts();
    let note = NoteDocument {
        id: next_note_id(app),
        title: "Welcome".to_string(),
        content: DEFAULT_NOTE_BODY.to_string(),
        created_at: ts,
        updated_at: ts,
        original_folder_path: None,
        deleted_at: None,
    };

    let path = note_file_path_in_folder(app, INBOX_FOLDER, &note.id)?;
    write_utf8_file(&path, &serialize_note(&note))
        .map_err(|error| format!("failed to seed note: {error}"))
}

#[tauri::command]
pub(crate) fn bootstrap_app(app: AppHandle) -> Result<BootstrapPayload, String> {
    ensure_vault_layout(&app)?;
    seed_default_note(&app)?;

    Ok(BootstrapPayload {
        vault_path: vault_dir(&app)?.display().to_string(),
        notes: collect_notes(&app)?,
        folders: collect_folders(&app)?,
        settings: load_settings(&app)?,
    })
}

#[tauri::command]
pub(crate) fn update_notes_state(
    app: AppHandle,
    input: NotesStateInput,
) -> Result<AppSettings, String> {
    ensure_vault_layout(&app)?;
    let mut settings = load_settings(&app)?;
    settings.notes_state.selected_note_id = input.selected_note_id;
    save_settings_file(&app, &settings)
}

#[tauri::command]
pub(crate) fn list_notes(app: AppHandle) -> Result<Vec<NoteSummary>, String> {
    ensure_vault_layout(&app)?;
    collect_notes(&app)
}

#[tauri::command]
pub(crate) fn list_workspace(app: AppHandle) -> Result<WorkspacePayload, String> {
    ensure_vault_layout(&app)?;
    workspace_payload(&app)
}

#[tauri::command]
pub(crate) fn load_note(app: AppHandle, id: String) -> Result<NoteDetail, String> {
    let path = find_note_path_by_id(&app, &id)?;
    let document = load_note_document(&path)?;
    note_to_detail(&app, &path, document)
}

#[tauri::command]
pub(crate) fn create_note(app: AppHandle, input: CreateNoteInput) -> Result<NoteDetail, String> {
    ensure_vault_layout(&app)?;

    let ts = now_ts();
    let title = sanitize_title(input.title.as_deref().unwrap_or("Untitled Note"));
    let document = NoteDocument {
        id: next_note_id(&app),
        title,
        content: String::new(),
        created_at: ts,
        updated_at: ts,
        original_folder_path: None,
        deleted_at: None,
    };

    let path = note_file_path(&app, &document.id)?;
    write_utf8_file(&path, &serialize_note(&document))
        .map_err(|error| format!("failed to create note: {error}"))?;

    note_to_detail(&app, &path, document)
}

#[tauri::command]
pub(crate) fn create_folder(
    app: AppHandle,
    input: CreateFolderInput,
) -> Result<Vec<String>, String> {
    ensure_vault_layout(&app)?;
    let normalized = normalize_folder_path(&input.path)?;
    if is_inside_system_folder(&normalized) {
        return Err("cannot create inside system folder".to_string());
    }
    let path = notes_dir(&app)?.join(&normalized);
    fs::create_dir_all(path).map_err(|error| format!("failed to create folder: {error}"))?;
    collect_folders(&app)
}

#[tauri::command]
pub(crate) fn rename_folder(
    app: AppHandle,
    input: RenameFolderInput,
) -> Result<Vec<String>, String> {
    ensure_vault_layout(&app)?;
    let from_path = normalize_folder_path(&input.from_path)?;
    let to_path = normalize_folder_path(&input.to_path)?;

    if is_system_folder(&from_path) || is_system_folder(&to_path) {
        return Err("system folders cannot be renamed".to_string());
    }
    if is_inside_system_folder(&to_path) {
        return Err("cannot create inside system folder".to_string());
    }

    let root = notes_dir(&app)?;
    let source = root.join(&from_path);
    let target = root.join(&to_path);

    if !source.exists() {
        return Err("folder not found".to_string());
    }
    if target.exists() {
        return Err("target folder already exists".to_string());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to prepare target folder: {error}"))?;
    }

    fs::rename(source, target).map_err(|error| format!("failed to rename folder: {error}"))?;
    collect_folders(&app)
}

#[tauri::command]
pub(crate) fn delete_folder(
    app: AppHandle,
    input: DeleteFolderInput,
) -> Result<Vec<String>, String> {
    ensure_vault_layout(&app)?;
    let normalized = normalize_folder_path(&input.path)?;

    if is_system_folder(&normalized) {
        return Err("system folders cannot be deleted".to_string());
    }
    if folder_contains_notes(&app, &normalized)? {
        return Err("only empty folders can be deleted".to_string());
    }

    let target = notes_dir(&app)?.join(&normalized);
    if !target.exists() {
        return Err("folder not found".to_string());
    }

    fs::remove_dir_all(target).map_err(|error| format!("failed to delete folder: {error}"))?;
    collect_folders(&app)
}

#[tauri::command]
pub(crate) fn save_note(app: AppHandle, input: SaveNoteInput) -> Result<NoteDetail, String> {
    let current_path = find_note_path_by_id(&app, &input.id)?;
    let mut document = load_note_document(&current_path)?;
    let current_folder = folder_path_from_note_path(&app, &current_path)?;

    document.title = sanitize_title(&input.title);
    document.content = input.content;
    document.updated_at = now_ts();

    let next_folder = if input.mode == "commit" && is_draft_folder(&current_folder) {
        INBOX_FOLDER.to_string()
    } else {
        current_folder
    };

    if is_trash_folder(&next_folder) {
        document.deleted_at = Some(document.deleted_at.unwrap_or_else(now_ts));
    } else {
        document.original_folder_path = None;
        document.deleted_at = None;
    }

    let next_path = note_file_path_in_folder(&app, &next_folder, &document.id)?;
    if let Some(parent) = next_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create note folder: {error}"))?;
    }

    write_utf8_file(&next_path, &serialize_note(&document))
        .map_err(|error| format!("failed to save note: {error}"))?;

    if next_path != current_path && current_path.exists() {
        fs::remove_file(current_path)
            .map_err(|error| format!("failed to clean old note path: {error}"))?;
    }

    note_to_detail(&app, &next_path, document)
}

#[tauri::command]
pub(crate) fn trash_note(app: AppHandle, id: String) -> Result<Vec<NoteSummary>, String> {
    let path = find_note_path_by_id(&app, &id)?;
    let mut document = load_note_document(&path)?;
    let current_folder = folder_path_from_note_path(&app, &path)?;

    if is_trash_folder(&current_folder) {
        return collect_notes(&app);
    }

    document.original_folder_path = Some(current_folder);
    document.deleted_at = Some(now_ts());

    let target = note_file_path_in_folder(&app, TRASH_FOLDER, &id)?;
    write_utf8_file(&target, &serialize_note(&document))
        .map_err(|error| format!("failed to move note to trash: {error}"))?;
    if target != path && path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("failed to remove original note: {error}"))?;
    }

    collect_notes(&app)
}

#[tauri::command]
pub(crate) fn restore_note(app: AppHandle, id: String) -> Result<NoteDetail, String> {
    let path = find_note_path_by_id(&app, &id)?;
    let mut document = load_note_document(&path)?;
    let current_folder = folder_path_from_note_path(&app, &path)?;

    if !is_trash_folder(&current_folder) {
        return note_to_detail(&app, &path, document);
    }

    let requested_folder = document
        .original_folder_path
        .clone()
        .unwrap_or_else(|| INBOX_FOLDER.to_string());
    let target_folder = match normalize_folder_path(&requested_folder) {
        Ok(folder) if !is_trash_folder(&folder) => folder,
        _ => INBOX_FOLDER.to_string(),
    };

    let notes_root = notes_dir(&app)?;
    let target_folder = if notes_root.join(&target_folder).exists() {
        target_folder
    } else {
        INBOX_FOLDER.to_string()
    };

    if let Some(parent) = note_file_path_in_folder(&app, &target_folder, &id)?.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to prepare restore folder: {error}"))?;
    }

    let target = note_file_path_in_folder(&app, &target_folder, &id)?;

    document.original_folder_path = None;
    document.deleted_at = None;

    write_utf8_file(&target, &serialize_note(&document))
        .map_err(|error| format!("failed to restore note: {error}"))?;
    if target != path && path.exists() {
        fs::remove_file(path).map_err(|error| format!("failed to remove trashed note: {error}"))?;
    }

    note_to_detail(&app, &target, document)
}

#[tauri::command]
pub(crate) fn delete_note(app: AppHandle, id: String) -> Result<Vec<NoteSummary>, String> {
    let path = find_note_path_by_id(&app, &id)?;
    let current_folder = folder_path_from_note_path(&app, &path)?;

    if !can_delete_note_permanently(&current_folder) {
        return Err("note must be in trash before permanent deletion".to_string());
    }

    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("failed to delete note: {error}"))?;
    }

    let notes = collect_notes(&app)?;
    if notes.is_empty() {
        seed_default_note(&app)?;
    }

    collect_notes(&app)
}

#[tauri::command]
pub(crate) fn move_note(app: AppHandle, input: MoveNoteInput) -> Result<NoteDetail, String> {
    ensure_vault_layout(&app)?;

    let target_folder = normalize_folder_path(&input.folder_path)?;
    if matches!(target_folder.as_str(), DRAFTS_FOLDER | TRASH_FOLDER) {
        return Err("target folder is not allowed".to_string());
    }

    let target_dir = notes_dir(&app)?.join(&target_folder);
    if !target_dir.exists() {
        return Err("target folder not found".to_string());
    }

    let current_path = find_note_path_by_id(&app, &input.id)?;
    let mut document = load_note_document(&current_path)?;
    let current_folder = folder_path_from_note_path(&app, &current_path)?;

    if current_folder == target_folder {
        return note_to_detail(&app, &current_path, document);
    }

    document.original_folder_path = None;
    document.deleted_at = None;

    let target_path = note_file_path_in_folder(&app, &target_folder, &input.id)?;
    write_utf8_file(&target_path, &serialize_note(&document))
        .map_err(|error| format!("failed to move note: {error}"))?;
    if target_path != current_path && current_path.exists() {
        fs::remove_file(current_path)
            .map_err(|error| format!("failed to remove previous note path: {error}"))?;
    }

    note_to_detail(&app, &target_path, document)
}

#[tauri::command]
pub(crate) fn empty_trash(app: AppHandle) -> Result<Vec<NoteSummary>, String> {
    let trash = trash_dir(&app)?;
    match fs::remove_dir_all(&trash) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to empty trash: {error}")),
    }

    fs::create_dir_all(&trash).map_err(|error| format!("failed to recreate trash: {error}"))?;
    let notes = collect_notes(&app)?;
    if notes.is_empty() {
        seed_default_note(&app)?;
    }
    collect_notes(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_dir_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_nanos();
        std::env::temp_dir().join(format!("myvault-{label}-{unique}"))
    }

    #[test]
    fn utf8_file_roundtrip_is_explicit() {
        let dir = temp_dir_path("utf8");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");

        write_utf8_file(&path, "你好\nhello").unwrap();
        let content = read_utf8_file(&path).unwrap();

        assert_eq!(content, "你好\nhello");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn serialize_parse_roundtrip_keeps_trash_metadata() {
        let document = NoteDocument {
            id: "note-1".to_string(),
            title: "Roundtrip".to_string(),
            content: "<p>body</p>".to_string(),
            created_at: 10,
            updated_at: 20,
            original_folder_path: Some("projects/demo".to_string()),
            deleted_at: Some(30),
        };

        let raw = serialize_note(&document);
        let parsed = parse_note(document.id.clone(), &raw);

        assert_eq!(parsed.title, document.title);
        assert_eq!(parsed.content, document.content);
        assert_eq!(parsed.original_folder_path, document.original_folder_path);
        assert_eq!(parsed.deleted_at, document.deleted_at);
    }

    #[test]
    fn normalize_folder_path_rejects_invalid_segments() {
        assert_eq!(
            normalize_folder_path("projects/demo").unwrap(),
            "projects/demo"
        );
        assert!(normalize_folder_path("../escape").is_err());
        assert!(normalize_folder_path("a//b").is_err());
        assert!(normalize_folder_path("./drafts").is_err());
    }

    #[test]
    fn permanent_delete_requires_trash_folder() {
        assert!(can_delete_note_permanently(TRASH_FOLDER));
        assert!(!can_delete_note_permanently(INBOX_FOLDER));
        assert!(!can_delete_note_permanently(DRAFTS_FOLDER));
        assert!(!can_delete_note_permanently("projects/demo"));
    }

    #[test]
    fn file_system_smoke_flow_trash_restore_move_and_delete_empty_folder_tree() {
        let dir = temp_dir_path("flow");
        let notes_root = dir.join("notes");
        let inbox = notes_root.join(INBOX_FOLDER);
        let trash = notes_root.join(TRASH_FOLDER);
        let project = notes_root.join("projects").join("alpha");
        let empty_branch = notes_root.join("archive").join("2026");

        fs::create_dir_all(&inbox).unwrap();
        fs::create_dir_all(&trash).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&empty_branch).unwrap();

        let original = inbox.join("note-1.md");
        let mut document = NoteDocument {
            id: "note-1".to_string(),
            title: "Smoke".to_string(),
            content: "body".to_string(),
            created_at: 1,
            updated_at: 2,
            original_folder_path: None,
            deleted_at: None,
        };

        write_utf8_file(&original, &serialize_note(&document)).unwrap();
        assert!(original.exists());

        document.original_folder_path = Some(INBOX_FOLDER.to_string());
        document.deleted_at = Some(3);
        let trashed = trash.join("note-1.md");
        write_utf8_file(&trashed, &serialize_note(&document)).unwrap();
        fs::remove_file(&original).unwrap();
        assert!(trashed.exists());
        assert!(!original.exists());

        let mut restored = load_note_document(&trashed).unwrap();
        restored.original_folder_path = None;
        restored.deleted_at = None;
        let moved = project.join("note-1.md");
        write_utf8_file(&moved, &serialize_note(&restored)).unwrap();
        fs::remove_file(&trashed).unwrap();

        assert!(moved.exists());
        assert!(!trashed.exists());
        let loaded = load_note_document(&moved).unwrap();
        assert_eq!(loaded.title, "Smoke");
        assert_eq!(loaded.original_folder_path, None);
        assert_eq!(loaded.deleted_at, None);

        fs::remove_dir_all(notes_root.join("archive")).unwrap();
        assert!(!notes_root.join("archive").exists());

        fs::remove_dir_all(dir).unwrap();
    }
}
