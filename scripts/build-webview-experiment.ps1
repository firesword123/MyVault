param(
  [switch]$Launch,
  [switch]$Diagnostics
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $workspace
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
  & cargo build --manifest-path src-tauri/Cargo.toml --bin myvault-webviews --features tauri/custom-protocol
  if ($LASTEXITCODE -ne 0) { throw "WebView experiment build failed" }
  $binary = Join-Path $workspace "src-tauri\target\debug\myvault-webviews.exe"
  Write-Host "Test executable: $binary"
  Write-Host "Isolated library: $workspace\.test-data\single-window\MyVaultData"
  if ($Launch) {
    if (Get-Process myvault-webviews -ErrorAction SilentlyContinue) {
      throw "Close the existing experiment before starting another instance."
    }
    $previousDebug = $env:MYVAULT_WEBVIEW_TEST_DEBUG
    try {
      if ($Diagnostics) { $env:MYVAULT_WEBVIEW_TEST_DEBUG = "1" }
      else { Remove-Item Env:MYVAULT_WEBVIEW_TEST_DEBUG -ErrorAction SilentlyContinue }
      # This is the interactive test application requested by the user.
      Start-Process -FilePath $binary -WorkingDirectory $workspace
    } finally {
      if ($null -eq $previousDebug) { Remove-Item Env:MYVAULT_WEBVIEW_TEST_DEBUG -ErrorAction SilentlyContinue }
      else { $env:MYVAULT_WEBVIEW_TEST_DEBUG = $previousDebug }
    }
  }
} finally {
  Pop-Location
}
