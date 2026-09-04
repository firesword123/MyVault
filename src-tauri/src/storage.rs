use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub(crate) const DATA_SCHEMA_VERSION: u32 = 2;
pub(crate) const DATA_ROOT_NAME: &str = "MyVaultData";
pub(crate) const ROUTE_FILE_NAME: &str = "myvault.data-route.json";
pub(crate) const DATA_ROOT_ENV: &str = "MYVAULT_DATA_ROOT";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataRoute {
    data_root: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataManifest {
    schema_version: u32,
    app_version: String,
    created_at: u64,
    updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    migration: Option<Value>,
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn executable_dir(app: &AppHandle) -> Result<PathBuf, String> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| app.path().executable_dir().ok())
        .ok_or_else(|| "failed to resolve executable directory".to_string())
}

fn workspace_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn resolve_route_path(executable_dir: &Path, value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("data route is empty".to_string());
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        executable_dir.join(path)
    })
}

pub(crate) fn data_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(DATA_ROOT_ENV).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(format!("{DATA_ROOT_ENV} must be an absolute path"));
        }
        return Ok(path);
    }

    let executable_dir = executable_dir(app)?;
    let route_path = executable_dir.join(ROUTE_FILE_NAME);
    if route_path.is_file() {
        let raw = fs::read_to_string(&route_path)
            .map_err(|error| format!("failed to read data route: {error}"))?;
        let route: DataRoute = serde_json::from_str(&raw)
            .map_err(|error| format!("failed to parse data route: {error}"))?;
        return resolve_route_path(&executable_dir, &route.data_root);
    }

    if cfg!(debug_assertions) {
        Ok(workspace_dir().join(".dev-data").join(DATA_ROOT_NAME))
    } else {
        Ok(executable_dir
            .parent()
            .unwrap_or(&executable_dir)
            .join(DATA_ROOT_NAME))
    }
}

pub(crate) fn manifest_path(root: &Path) -> PathBuf {
    root.join("_MyVault").join("Manifest.json")
}

fn validate_manifest(root: &Path) -> Result<(), String> {
    let path = manifest_path(root);
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read data manifest: {error}"))?;
    let manifest: DataManifest = serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse data manifest: {error}"))?;
    if manifest.schema_version != DATA_SCHEMA_VERSION {
        return Err(format!(
            "unsupported data schema version {}; expected {}",
            manifest.schema_version, DATA_SCHEMA_VERSION
        ));
    }
    Ok(())
}

fn create_layout(root: &Path) -> Result<(), String> {
    for relative in [
        "Notes/_Drafts",
        "Notes/_Inbox",
        "Notes/_Trash",
        "DL_ASMR",
        "Gallery",
        "_MyVault/Importing",
        "_MyVault/Backups",
        "_MyVault/Migrations",
    ] {
        fs::create_dir_all(root.join(relative))
            .map_err(|error| format!("failed to create data directory {relative}: {error}"))?;
    }
    Ok(())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, raw.as_bytes()).map_err(|error| error.to_string())
}

fn ensure_destination_is_available(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut entries =
        fs::read_dir(path).map_err(|error| format!("failed to inspect data root: {error}"))?;
    if entries.next().is_some() {
        return Err(format!(
            "data root exists without a valid schema-2 manifest: {}",
            path.display()
        ));
    }
    fs::remove_dir(path).map_err(|error| format!("failed to remove empty data root: {error}"))
}

fn create_fresh_data_root(root: &Path) -> Result<(), String> {
    ensure_destination_is_available(root)?;
    let parent = root
        .parent()
        .ok_or_else(|| "data root has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = parent.join(format!("{DATA_ROOT_NAME}.creating-{}", Uuid::new_v4()));
    create_layout(&staging)?;
    let ts = now_ts();
    write_json(
        &manifest_path(&staging),
        &DataManifest {
            schema_version: DATA_SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            created_at: ts,
            updated_at: ts,
            migration: None,
        },
    )
    .map_err(|error| format!("failed to create data manifest: {error}"))?;
    validate_manifest(&staging)?;
    fs::rename(&staging, root).map_err(|error| {
        format!(
            "failed to activate new data root at {}: {error}",
            root.display()
        )
    })
}

pub(crate) fn prepare_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = data_root_dir(app)?;
    if manifest_path(&root).is_file() {
        validate_manifest(&root)?;
        return Ok(root);
    }

    create_fresh_data_root(&root)?;
    validate_manifest(&root)?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("myvault-storage-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn creates_a_v2_data_root() {
        let root = temp_path("fresh");
        create_fresh_data_root(&root).expect("fresh data root should be created");
        validate_manifest(&root).expect("manifest should be valid");
        assert!(root.join("Notes/_Inbox").is_dir());
        assert!(root.join("DL_ASMR").is_dir());
        assert!(root.join("Gallery").is_dir());
        assert!(!root.join("_MyVault/MigrationReports").exists());
        assert!(!root.join("_MyVault/RepairReports").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_nonempty_data_without_a_v2_manifest() {
        let root = temp_path("unmanifested");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("legacy.txt"), "do not adopt").unwrap();
        let error = create_fresh_data_root(&root).unwrap_err();
        assert!(error.contains("without a valid schema-2 manifest"));
        assert_eq!(
            fs::read_to_string(root.join("legacy.txt")).unwrap(),
            "do not adopt"
        );
        let _ = fs::remove_dir_all(root);
    }
}
