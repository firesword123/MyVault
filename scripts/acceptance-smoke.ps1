$ErrorActionPreference = "Stop"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  & $Command | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

Write-Host "[smoke] frontend build"
Invoke-Checked { npm run build } "Frontend build"

Write-Host "[smoke] DL_ASMR sidecar build"
Invoke-Checked { npm run prepare:asmr } "DL_ASMR sidecar build"

Write-Host "[smoke] Gallery sidecar build"
Invoke-Checked { npm run prepare:gallery } "Gallery sidecar build"

Write-Host "[smoke] backend tests"
Invoke-Checked { cargo test --manifest-path src-tauri/Cargo.toml } "Backend tests"

Write-Host "[smoke] backend compile"
Invoke-Checked { cargo check --manifest-path src-tauri/Cargo.toml } "Backend compile"

Write-Host "[smoke] completed"
