use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    hash::Hash,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use sysinfo::{get_current_pid, System};
use tauri::AppHandle;

pub(crate) const DRAFTS_FOLDER: &str = "drafts";
pub(crate) const INBOX_FOLDER: &str = "inbox";
pub(crate) const TRASH_FOLDER: &str = "trash";
static RESOURCE_SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    #[serde(default = "default_language")]
    language: String,
    #[serde(default = "default_show_note_time")]
    show_note_time: bool,
    #[serde(default = "default_close_behavior")]
    pub(crate) close_behavior: String,
    #[serde(default)]
    http_proxy: String,
    #[serde(default)]
    https_proxy: String,
    #[serde(default)]
    all_proxy: String,
    #[serde(default)]
    no_proxy: String,
    #[serde(default = "default_notes_state")]
    pub(crate) notes_state: NotesWindowState,
    #[serde(default)]
    persistent_modules: Vec<String>,
    #[serde(default)]
    close_player_on_pause: bool,
    #[serde(default)]
    show_memory_in_titlebar: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotesWindowState {
    pub(crate) selected_note_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceUsage {
    app_memory_bytes: u64,
    webview_memory_bytes: u64,
    total_memory_bytes: u64,
    app_cpu_percent: f32,
    webview_cpu_percent: f32,
    total_cpu_percent: f32,
    app_processes: usize,
    webview_processes: usize,
    total_processes: usize,
}

fn default_language() -> String {
    "zh-CN".to_string()
}

fn default_show_note_time() -> bool {
    false
}

pub(crate) fn default_close_behavior() -> String {
    "quit".to_string()
}

fn default_notes_state() -> NotesWindowState {
    NotesWindowState {
        selected_note_id: String::new(),
    }
}

fn default_settings() -> AppSettings {
    AppSettings {
        language: default_language(),
        show_note_time: default_show_note_time(),
        close_behavior: default_close_behavior(),
        http_proxy: String::new(),
        https_proxy: String::new(),
        all_proxy: String::new(),
        no_proxy: String::new(),
        notes_state: default_notes_state(),
        persistent_modules: Vec::new(),
        close_player_on_pause: false,
        show_memory_in_titlebar: false,
    }
}

fn normalize_proxy_value(raw: &str) -> String {
    raw.trim().to_string()
}

fn apply_process_proxy(var: &str, value: &str) {
    if value.is_empty() {
        unsafe {
            std::env::remove_var(var);
        }
        return;
    }

    unsafe {
        std::env::set_var(var, value);
    }
}

pub(crate) fn apply_network_settings(settings: &AppSettings) {
    apply_process_proxy("HTTP_PROXY", &settings.http_proxy);
    apply_process_proxy("HTTPS_PROXY", &settings.https_proxy);
    apply_process_proxy("ALL_PROXY", &settings.all_proxy);
    apply_process_proxy("NO_PROXY", &settings.no_proxy);
    apply_process_proxy("http_proxy", &settings.http_proxy);
    apply_process_proxy("https_proxy", &settings.https_proxy);
    apply_process_proxy("all_proxy", &settings.all_proxy);
    apply_process_proxy("no_proxy", &settings.no_proxy);
}

pub(crate) fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn data_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage::data_root_dir(app)
}

pub(crate) fn vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    data_root_dir(app)
}

pub(crate) fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root_dir(app)?.join("Notes"))
}

pub(crate) fn asmr_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root_dir(app)?.join("DL_ASMR"))
}

#[allow(dead_code)]
pub(crate) fn gallery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root_dir(app)?.join("Gallery"))
}

#[allow(dead_code)]
pub(crate) fn gallery_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root_dir(app)?
        .join("_MyVault")
        .join("Cache")
        .join("Gallery"))
}

pub(crate) fn asmr_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(asmr_dir(app)?.join("_Library.json"))
}

pub(crate) fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(notes_dir(app)?.join("_Drafts"))
}

pub(crate) fn inbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(notes_dir(app)?.join("_Inbox"))
}

pub(crate) fn trash_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(notes_dir(app)?.join("_Trash"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root_dir(app)?.join("_MyVault").join("Settings.json"))
}

pub(crate) fn notes_folder_dir(app: &AppHandle, logical: &str) -> Result<PathBuf, String> {
    let mut parts = logical.split('/');
    let first = parts.next().unwrap_or(INBOX_FOLDER);
    let physical = match first {
        DRAFTS_FOLDER => "_Drafts",
        INBOX_FOLDER => "_Inbox",
        TRASH_FOLDER => "_Trash",
        value => value,
    };
    let mut path = notes_dir(app)?.join(physical);
    for part in parts {
        path.push(part);
    }
    Ok(path)
}

pub(crate) fn logical_notes_folder(relative: &Path) -> String {
    let normalized = relative.to_string_lossy().replace('\\', "/");
    let mut parts = normalized.split('/');
    let first = parts.next().unwrap_or_default();
    let logical = match first {
        "_Drafts" => DRAFTS_FOLDER,
        "_Inbox" => INBOX_FOLDER,
        "_Trash" => TRASH_FOLDER,
        value => value,
    };
    std::iter::once(logical)
        .chain(parts)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn ensure_vault_layout(app: &AppHandle) -> Result<(), String> {
    let root = crate::storage::prepare_data_root(app)?;
    let vault = vault_dir(app)?;
    let notes = notes_dir(app)?;
    let drafts = drafts_dir(app)?;
    let inbox = inbox_dir(app)?;
    let trash = trash_dir(app)?;
    let settings = settings_path(app)?;

    fs::create_dir_all(&root).map_err(|error| format!("failed to create app root: {error}"))?;
    fs::create_dir_all(&vault).map_err(|error| format!("failed to create vault dir: {error}"))?;
    fs::create_dir_all(&notes).map_err(|error| format!("failed to create notes dir: {error}"))?;
    fs::create_dir_all(&drafts).map_err(|error| format!("failed to create drafts dir: {error}"))?;
    fs::create_dir_all(&inbox).map_err(|error| format!("failed to create inbox dir: {error}"))?;
    fs::create_dir_all(&trash).map_err(|error| format!("failed to create trash dir: {error}"))?;

    if !settings.exists() {
        let raw = serde_json::to_string_pretty(&default_settings())
            .map_err(|error| format!("failed to serialize default settings: {error}"))?;
        atomic_write_utf8_file(&settings, &raw)
            .map_err(|error| format!("failed to create settings file: {error}"))?;
    }

    Ok(())
}

pub(crate) fn ensure_asmr_layout(app: &AppHandle) -> Result<(), String> {
    let vault = crate::storage::prepare_data_root(app)?;
    let asmr = asmr_dir(app)?;
    fs::create_dir_all(&vault).map_err(|error| format!("failed to create vault dir: {error}"))?;
    fs::create_dir_all(&asmr).map_err(|error| format!("failed to create asmr dir: {error}"))
}

#[allow(dead_code)]
pub(crate) fn ensure_gallery_layout(app: &AppHandle) -> Result<(), String> {
    let root = crate::storage::prepare_data_root(app)?;
    let gallery = gallery_dir(app)?;
    fs::create_dir_all(&root).map_err(|error| format!("failed to create vault dir: {error}"))?;
    fs::create_dir_all(&gallery).map_err(|error| format!("failed to create gallery dir: {error}"))
}

pub(crate) fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    let raw = read_utf8_file(&path).map_err(|error| format!("failed to read settings: {error}"))?;
    let settings: AppSettings =
        serde_json::from_str(&raw).map_err(|error| format!("failed to parse settings: {error}"))?;
    save_settings_file(app, &settings)
}

pub(crate) fn save_settings_file(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<AppSettings, String> {
    let mut normalized = settings.clone();
    normalized.close_behavior = match normalized.close_behavior.as_str() {
        "tray" => "tray".to_string(),
        _ => "quit".to_string(),
    };

    normalized.http_proxy = normalize_proxy_value(&normalized.http_proxy);
    normalized.https_proxy = normalize_proxy_value(&normalized.https_proxy);
    normalized.all_proxy = normalize_proxy_value(&normalized.all_proxy);
    normalized.no_proxy = normalize_proxy_value(&normalized.no_proxy);

    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("failed to serialize settings: {error}"))?;
    atomic_write_utf8_file(&path, &raw)
        .map_err(|error| format!("failed to save settings: {error}"))?;
    apply_network_settings(&normalized);
    Ok(normalized)
}

pub(crate) fn read_utf8_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|error| format!("file is not valid UTF-8: {error}"))
}

pub(crate) fn write_utf8_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

pub(crate) fn atomic_write_utf8_file(path: &Path, content: &str) -> Result<(), String> {
    if fs::read(path)
        .map(|existing| existing == content.as_bytes())
        .unwrap_or(false)
    {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let tmp_path = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!("{extension}."))
            .unwrap_or_default()
    ));
    let backup_path = path.with_extension(format!(
        "{}bak",
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!("{extension}."))
            .unwrap_or_default()
    ));

    {
        let mut file = fs::File::create(&tmp_path).map_err(|error| error.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }

    if path.exists() {
        fs::copy(path, &backup_path).map_err(|error| error.to_string())?;
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp_path, path).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    ensure_vault_layout(&app)?;
    load_settings(&app)
}

#[tauri::command]
pub(crate) fn update_settings(
    app: AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    ensure_vault_layout(&app)?;
    save_settings_file(&app, &settings)
}

#[tauri::command]
pub(crate) fn get_resource_usage() -> Result<ResourceUsage, String> {
    let system = RESOURCE_SYSTEM.get_or_init(|| Mutex::new(System::new_all()));
    let mut system = system
        .lock()
        .map_err(|_| "failed to lock resource sampler".to_string())?;
    system.refresh_processes();

    let current_pid =
        get_current_pid().map_err(|error| format!("failed to resolve pid: {error}"))?;
    let mut app_memory_bytes = 0;
    let mut app_cpu_percent = 0.0;
    let mut webview_memory_bytes = 0;
    let mut webview_cpu_percent = 0.0;
    let mut app_processes = 0;
    let mut webview_processes = 0;

    // Build one bounded child index from the current process snapshot, then walk only the
    // MyVault-owned tree. Do not repeatedly chase parent PIDs: Windows can reuse PIDs and a
    // snapshot can therefore contain parent cycles that would otherwise spin forever.
    let owned_processes = collect_descendant_processes(&system, current_pid);

    for pid in &owned_processes {
        let Some(process) = system.process(*pid) else {
            continue;
        };
        let name = process.name().to_ascii_lowercase();
        if name == "msedgewebview2.exe" || name == "msedgewebview2" {
            webview_memory_bytes += process.memory();
            webview_cpu_percent += process.cpu_usage();
            webview_processes += 1;
        } else {
            app_memory_bytes += process.memory();
            app_cpu_percent += process.cpu_usage();
            app_processes += 1;
        }
    }

    let total_processes = app_processes + webview_processes;

    Ok(ResourceUsage {
        app_memory_bytes,
        webview_memory_bytes,
        total_memory_bytes: app_memory_bytes + webview_memory_bytes,
        app_cpu_percent,
        webview_cpu_percent,
        total_cpu_percent: app_cpu_percent + webview_cpu_percent,
        app_processes,
        webview_processes,
        total_processes,
    })
}

const MAX_OWNED_PROCESSES: usize = 512;

fn collect_descendant_processes(system: &System, root: sysinfo::Pid) -> HashSet<sysinfo::Pid> {
    collect_descendants(
        root,
        system
            .processes()
            .iter()
            .filter_map(|(pid, process)| process.parent().map(|parent| (parent, *pid))),
        MAX_OWNED_PROCESSES,
    )
}

fn collect_descendants<T, I>(root: T, parent_child_pairs: I, limit: usize) -> HashSet<T>
where
    T: Copy + Eq + Hash,
    I: IntoIterator<Item = (T, T)>,
{
    let mut children = HashMap::<T, Vec<T>>::new();
    for (parent, child) in parent_child_pairs {
        children.entry(parent).or_default().push(child);
    }

    let mut owned = HashSet::with_capacity(16);
    let mut pending = VecDeque::with_capacity(16);
    owned.insert(root);
    pending.push_back(root);

    while let Some(parent) = pending.pop_front() {
        let Some(direct_children) = children.get(&parent) else {
            continue;
        };
        for child in direct_children {
            if owned.len() >= limit {
                return owned;
            }
            if owned.insert(*child) {
                pending.push_back(*child);
            }
        }
    }

    owned
}

#[cfg(test)]
mod resource_usage_tests {
    use super::collect_descendants;

    #[test]
    fn descendant_collection_stops_on_cycles() {
        let owned = collect_descendants(1_u32, [(1, 2), (2, 3), (3, 2)], 512);
        assert_eq!(owned.len(), 3);
        assert!(owned.contains(&1));
        assert!(owned.contains(&2));
        assert!(owned.contains(&3));
    }

    #[test]
    fn descendant_collection_ignores_unrelated_process_trees() {
        let owned = collect_descendants(1_u32, [(1, 2), (8, 9), (9, 8)], 512);
        assert_eq!(owned, [1, 2].into_iter().collect());
    }

    #[test]
    fn descendant_collection_is_bounded() {
        let owned = collect_descendants(1_u32, (1..1_000).map(|pid| (pid, pid + 1)), 32);
        assert_eq!(owned.len(), 32);
    }
}
