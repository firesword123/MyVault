param(
  [switch]$Release
)

$ErrorActionPreference = "Stop"

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Join-Path $workspace "src-tauri\Cargo.toml"
$profile = if ($Release) { "release" } else { "debug" }
$cargoArgs = @("build", "--manifest-path", $manifest, "--bin", "myvault-dl-asmr")
if ($Release) {
  $cargoArgs += @("--release", "--features", "tauri/custom-protocol")
}

& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) {
  throw "Failed to build myvault-dl-asmr"
}

$targetTriple = (& rustc --print host-tuple).Trim()
if (-not $targetTriple) {
  throw "Failed to determine the Rust target triple"
}

$source = Join-Path $workspace "src-tauri\target\$profile\myvault-dl-asmr.exe"
$binaryDir = Join-Path $workspace "src-tauri\target\sidecars"
$destination = Join-Path $binaryDir "myvault-dl-asmr-$targetTriple.exe"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Missing DL_ASMR module binary at $source"
}

New-Item -ItemType Directory -Path $binaryDir -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force
Write-Host "Prepared DL_ASMR sidecar at $destination"
