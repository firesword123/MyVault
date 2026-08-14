fn main() {
    ensure_sidecar_slot();
    tauri_build::build()
}

fn ensure_sidecar_slot() {
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let directory = std::path::Path::new(&manifest_dir)
        .join("target")
        .join("sidecars");
    std::fs::create_dir_all(&directory).expect("failed to create sidecar staging directory");
    for binary in ["myvault-dl-asmr", "myvault-gallery"] {
        let path = directory.join(format!("{binary}-{target}{extension}"));
        if !path.exists() {
            std::fs::File::create(path).expect("failed to create sidecar staging placeholder");
        }
    }
}
