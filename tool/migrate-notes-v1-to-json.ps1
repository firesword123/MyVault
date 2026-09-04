[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DataRoot
)

$ErrorActionPreference = "Stop"

function Convert-ToUnixSeconds {
    param([datetime]$Value)

    return ([DateTimeOffset]$Value.ToUniversalTime()).ToUnixTimeSeconds()
}

function Read-OldNote {
    param([System.IO.FileInfo]$File)

    $raw = [System.IO.File]::ReadAllText($File.FullName)
    $metadata = @{}
    $content = $raw
    $frontMatter = [regex]::Match(
        $raw,
        '\A---\r?\n(?<metadata>[\s\S]*?)\r?\n---(?:\r?\n)?(?<content>[\s\S]*)\z'
    )

    if ($frontMatter.Success) {
        foreach ($line in ($frontMatter.Groups["metadata"].Value -split '\r?\n')) {
            $separator = $line.IndexOf(":")
            if ($separator -lt 0) {
                continue
            }
            $key = $line.Substring(0, $separator).Trim()
            $value = $line.Substring($separator + 1).Trim()
            $metadata[$key] = $value
        }
        $content = $frontMatter.Groups["content"].Value
    }

    $title = if ($metadata.ContainsKey("title")) { $metadata["title"] } else { "Untitled Note" }
    $title = ($title -replace '[\r\n]', ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($title)) {
        $title = "Untitled Note"
    }

    [long]$createdAt = Convert-ToUnixSeconds $File.CreationTimeUtc
    [long]$updatedAt = Convert-ToUnixSeconds $File.LastWriteTimeUtc
    [long]$parsedTimestamp = 0
    if ($metadata.ContainsKey("created_at") -and
        [long]::TryParse($metadata["created_at"], [ref]$parsedTimestamp)) {
        $createdAt = $parsedTimestamp
    }
    if ($metadata.ContainsKey("updated_at") -and
        [long]::TryParse($metadata["updated_at"], [ref]$parsedTimestamp)) {
        $updatedAt = $parsedTimestamp
    }

    $originalFolderPath = $null
    if ($metadata.ContainsKey("original_folder_path") -and
        -not [string]::IsNullOrWhiteSpace($metadata["original_folder_path"])) {
        $originalFolderPath = $metadata["original_folder_path"]
    }

    $deletedAt = $null
    if ($metadata.ContainsKey("deleted_at") -and
        [long]::TryParse($metadata["deleted_at"], [ref]$parsedTimestamp)) {
        $deletedAt = $parsedTimestamp
    }

    if ([string]::IsNullOrWhiteSpace($content)) {
        $html = ""
    } elseif ($content -match '<[A-Za-z][\s\S]*>') {
        $html = $content
    } else {
        $encoded = [System.Net.WebUtility]::HtmlEncode($content)
        $paragraphs = $encoded -split '(?:\r?\n){2,}' | ForEach-Object {
            "<p>$($_ -replace '\r?\n', '<br>')</p>"
        }
        $html = $paragraphs -join ""
    }

    return [ordered]@{
        formatVersion       = 1
        id                  = $File.BaseName
        title               = $title
        blocks              = @(
            [ordered]@{
                type = "richText"
                id   = "block-$($File.BaseName)"
                html = $html
            }
        )
        createdAt           = $createdAt
        updatedAt           = $updatedAt
        originalFolderPath  = $originalFolderPath
        deletedAt           = $deletedAt
    }
}

$resolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$notesRoot = Join-Path $resolvedDataRoot "Notes"
$manifestPath = Join-Path $resolvedDataRoot "_MyVault\Manifest.json"

if (-not (Test-Path -LiteralPath $notesRoot -PathType Container)) {
    throw "Notes directory not found: $notesRoot"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "MyVault manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2) {
    throw "Unsupported data schema version: $($manifest.schemaVersion)"
}

$oldNotes = @(Get-ChildItem -LiteralPath $notesRoot -Recurse -File -Filter "*.md")
if ($oldNotes.Count -eq 0) {
    Write-Output "No legacy .md notes found under $notesRoot"
    exit 0
}

$duplicateIds = @($oldNotes | Group-Object BaseName | Where-Object Count -gt 1)
if ($duplicateIds.Count -gt 0) {
    throw "Duplicate note ids found: $($duplicateIds.Name -join ', ')"
}

foreach ($file in $oldNotes) {
    if ($file.BaseName -notmatch '^[A-Za-z0-9_-]+$') {
        throw "Invalid note id in file name: $($file.Name)"
    }
    $jsonPath = [System.IO.Path]::ChangeExtension($file.FullName, ".json")
    if (Test-Path -LiteralPath $jsonPath) {
        throw "Destination already exists: $jsonPath"
    }
}

$batch = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $resolvedDataRoot "_MyVault\Backups\Notes-v1\$batch"
$utf8 = [System.Text.UTF8Encoding]::new($false)
$migrated = 0

foreach ($file in $oldNotes) {
    $relativePath = $file.FullName.Substring($notesRoot.TrimEnd("\").Length).TrimStart("\")
    $backupPath = Join-Path $backupRoot $relativePath
    $jsonPath = [System.IO.Path]::ChangeExtension($file.FullName, ".json")
    $temporaryPath = "$jsonPath.migrating"
    $document = Read-OldNote $file
    $json = $document | ConvertTo-Json -Depth 6

    $backupParent = Split-Path -Parent $backupPath
    New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
    [System.IO.File]::WriteAllText($temporaryPath, "$json`n", $utf8)

    $verified = Get-Content -LiteralPath $temporaryPath -Raw | ConvertFrom-Json
    if ($verified.formatVersion -ne 1 -or
        $verified.id -ne $file.BaseName -or
        $verified.blocks.Count -ne 1 -or
        $verified.blocks[0].type -ne "richText") {
        throw "Generated note failed validation: $($file.FullName)"
    }

    Move-Item -LiteralPath $file.FullName -Destination $backupPath
    try {
        Move-Item -LiteralPath $temporaryPath -Destination $jsonPath
    } catch {
        Move-Item -LiteralPath $backupPath -Destination $file.FullName
        throw
    }
    $migrated += 1
}

Write-Output "Migrated $migrated note(s)."
Write-Output "Data root: $resolvedDataRoot"
Write-Output "Legacy backup: $backupRoot"
