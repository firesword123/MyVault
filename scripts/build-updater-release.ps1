$ErrorActionPreference = "Stop"

$keyPath = Join-Path $PSScriptRoot "..\\updater.key"
$passwordPath = Join-Path $PSScriptRoot "..\\updater.password"
$resolvedKeyPath = (Resolve-Path $keyPath).Path
$repoUrl = "https://github.com/firesword123/MyVault"

if (-not (Test-Path $resolvedKeyPath)) {
  throw "Missing updater private key at $resolvedKeyPath"
}
if (-not (Test-Path $passwordPath)) {
  throw "Missing updater password file at $passwordPath"
}

$password = (Get-Content -LiteralPath $passwordPath -Raw).Trim()
if (-not $password) {
  throw "Updater password file is empty: $passwordPath"
}

$configPath = Join-Path $PSScriptRoot "..\\src-tauri\\tauri.conf.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$version = $config.version
$nsisDir = Join-Path $PSScriptRoot "..\\src-tauri\\target\\release\\bundle\\nsis"
$assetName = "myvault_${version}_x64-setup.exe"
$assetPath = Join-Path $nsisDir $assetName
$signaturePath = "${assetPath}.sig"
$latestJsonPath = Join-Path $nsisDir "latest.json"
$releaseTag = "v$version"

try {
  npm run tauri build

  if (-not (Test-Path $assetPath)) {
    throw "Missing NSIS installer at $assetPath"
  }

  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
  npm run tauri signer sign -- -f $resolvedKeyPath $assetPath

  if (-not (Test-Path $signaturePath)) {
    throw "Missing signature file at $signaturePath"
  }

  $signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
  $manifest = [ordered]@{
    version = $version
    notes = "Release $version"
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
      "windows-x86_64" = [ordered]@{
        signature = $signature
        url = "$repoUrl/releases/download/$releaseTag/$assetName"
      }
    }
  }

  $manifestJson = $manifest | ConvertTo-Json -Depth 5
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($latestJsonPath, $manifestJson, $utf8NoBom)
  Write-Host "Prepared updater manifest at $latestJsonPath"
}
finally {
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
