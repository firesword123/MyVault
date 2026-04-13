$ErrorActionPreference = "Stop"

Write-Host "[smoke] frontend build"
npm run build | Out-Host

Write-Host "[smoke] backend tests"
cargo test --manifest-path src-tauri/Cargo.toml | Out-Host

Write-Host "[smoke] backend compile"
cargo check --manifest-path src-tauri/Cargo.toml | Out-Host

Write-Host "[smoke] completed"
