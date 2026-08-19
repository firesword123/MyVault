[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('preview', 'import')]
  [string]$Command = 'preview',
  [Alias('data-root')] [string]$DataRoot,
  [string]$Source,
  [Alias('metadata-file')] [string]$MetadataFile,
  [Alias('metadata-json')] [string]$MetadataJson,
  [ValidateSet('skip', 'create')]
  [string]$Missing = 'skip',
  [switch]$Overwrite
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) { throw "asmr-agent: $Message" }

if ([string]::IsNullOrWhiteSpace($DataRoot)) { Fail '--DataRoot is required' }
if ([string]::IsNullOrWhiteSpace($Source)) { Fail '--Source is required' }
$root = [IO.Path]::GetFullPath($DataRoot)
$sourcePath = [IO.Path]::GetFullPath($Source)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { Fail "source directory not found: $sourcePath" }

function Path-IsWithin([string]$Candidate, [string]$Parent) {
  $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd([char[]]@('\','/'))
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd([char[]]@('\','/'))
  return $candidatePath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
    $candidatePath.StartsWith($parentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
if ((Path-IsWithin $sourcePath $root) -or (Path-IsWithin $root $sourcePath)) {
  Fail 'source and MyVault data root must not overlap'
}
$manifestPath = Join-Path $root '_MyVault\Manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail "schema-2 MyVault manifest not found: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2) { Fail "unsupported MyVault data schema: $($manifest.schemaVersion)" }

$hashProvider = [Security.Cryptography.SHA256]::Create()
try {
  $rootHash = -join ($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') })
} finally {
  $hashProvider.Dispose()
}
$agentMutex = [Threading.Mutex]::new($false, "Local\MyVault-ASMR-Agent-$rootHash")
$mutexAcquired = $false
try {
  $mutexAcquired = $agentMutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
  $mutexAcquired = $true
}
if (-not $mutexAcquired) { Fail 'another ASMR agent operation is already using this data root' }

function Write-Utf8NoBom([string]$Path, [object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function Read-Metadata {
  if ($MetadataFile) {
    if (-not (Test-Path -LiteralPath $MetadataFile -PathType Leaf)) { Fail "metadata file not found: $MetadataFile" }
    return (Get-Content -LiteralPath $MetadataFile -Raw -Encoding UTF8 | ConvertFrom-Json)
  }
  if ($MetadataJson) { return ($MetadataJson | ConvertFrom-Json) }
  $stdin = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($stdin)) { Fail 'metadata JSON is required via --MetadataJson, --MetadataFile, or stdin' }
  return ($stdin | ConvertFrom-Json)
}

function Text([object]$Value) {
  if ($null -eq $Value) { return '' }
  return ([string]$Value).Trim()
}
function String-List([object]$Value) {
  if ($null -eq $Value) { return @() }
  if ($Value -is [string]) { return @((Text $Value) | Where-Object { $_ }) }
  return @($Value | ForEach-Object { Text $_ } | Where-Object { $_ } | Select-Object -Unique)
}
function Property([object]$Object, [string]$Name) {
  $p = $Object.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}
function Has-Property([object]$Object, [string]$Name) {
  return $null -ne $Object.PSObject.Properties[$Name]
}
function Normalize-Rj([string]$Value) {
  $v = (Text $Value).ToUpperInvariant()
  if ($v -match '^RJ\d+$') { return $v }
  if ($v -match '^\d+$') { return "RJ$v" }
  Fail "RJ id is required (use --rjId in metadata or name the source RJxxxx)"
}

$metadata = Read-Metadata
$hasTitle = Has-Property $metadata 'title'
$hasCircle = Has-Property $metadata 'circle'
$hasTags = Has-Property $metadata 'tags'
$hasVoices = (Has-Property $metadata 'voiceActors') -or (Has-Property $metadata 'voice_actors')
$hasNote = Has-Property $metadata 'note'
$rjRaw = Text (Property $metadata 'rjId')
if (-not $rjRaw) { $rjRaw = [IO.Path]::GetFileName($sourcePath) }
$rjId = Normalize-Rj $rjRaw
$title = Text (Property $metadata 'title')
$circle = Text (Property $metadata 'circle')
$tags = String-List (Property $metadata 'tags')
$voices = String-List (Property $metadata 'voiceActors')
if (-not $voices.Count) { $voices = String-List (Property $metadata 'voice_actors') }
$note = Text (Property $metadata 'note')

$asmrDir = Join-Path $root 'DL_ASMR'
$indexPath = Join-Path $asmrDir '_Library.json'
$workDir = Join-Path $asmrDir $rjId
$index = if (Test-Path -LiteralPath $indexPath) { Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json } else {
  [pscustomobject]@{ version = 2; works = @(); dictionaries = [pscustomobject]@{ tags = @(); voiceActors = @(); circles = @() } }
}
if (-not $index.works) { $index.works = @() }
if (-not $index.dictionaries) { $index.dictionaries = [pscustomobject]@{ tags = @(); voiceActors = @(); circles = @() } }
foreach ($name in @('tags','voiceActors','circles')) { if ($null -eq $index.dictionaries.$name) { $index.dictionaries | Add-Member -NotePropertyName $name -NotePropertyValue @() } }

function Known([string]$Name, [string[]]$Values) { return $Values -contains $Name }
$skipped = [System.Collections.Generic.List[string]]::new()
if ($circle -and -not (Known $circle @($index.dictionaries.circles))) {
  if ($Missing -eq 'skip') { $skipped.Add("circle:$circle"); $circle = '' }
}
$tags = @($tags | ForEach-Object { if ((Known $_ @($index.dictionaries.tags)) -or $Missing -eq 'create') { $_ } else { $skipped.Add("tag:$_") } })
$voices = @($voices | ForEach-Object { if ((Known $_ @($index.dictionaries.voiceActors)) -or $Missing -eq 'create') { $_ } else { $skipped.Add("voiceActor:$_") } })

$existing = @($index.works | Where-Object { $_.rjId -eq $rjId }) | Select-Object -First 1
$targetExists = Test-Path -LiteralPath $workDir
if ($existing) {
  if (-not $hasTitle) { $title = Text (Property $existing 'title') }
  if (-not $hasCircle) { $circle = Text (Property $existing 'circle') }
  if (-not $hasTags) { $tags = String-List (Property $existing 'tags') }
  if (-not $hasVoices) { $voices = String-List (Property $existing 'voiceActors') }
  if (-not $hasNote) { $note = Text (Property $existing 'note') }
}
$files = @(Get-ChildItem -LiteralPath $sourcePath -File -Recurse)
$folders = @(Get-ChildItem -LiteralPath $sourcePath -Directory -Recurse)
$result = [ordered]@{ rjId = $rjId; source = $sourcePath; target = $workDir; alreadyExists = [bool]($existing -or $targetExists); fileCount = $files.Count; folderCount = $folders.Count; skipped = @($skipped); missingMode = $Missing }
if ($Command -eq 'preview') { $result | ConvertTo-Json -Depth 10; exit 0 }
if (($existing -or $targetExists) -and -not $Overwrite) { Fail "$rjId already exists; pass --Overwrite to replace files and metadata" }
New-Item -ItemType Directory -Force -Path $asmrDir | Out-Null

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$staging = Join-Path (Join-Path $root '_MyVault\Importing') ("agent-$rjId-" + [guid]::NewGuid().ToString('N'))
$backup = $null
$activated = $false
$indexCommitted = $false
try {
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $staging -Recurse -Force
  $work = [pscustomobject]@{ rjId=$rjId; title=($(if ($title) {$title} else {$rjId})); circle=$circle; voiceActors=@($voices); tags=@($tags); status=$(if ($existing.status) {$existing.status} else {'new'}); favorite=$(if ($null -ne $existing.favorite) {[bool]$existing.favorite} else {$false}); rating=$(if ($existing) {$existing.rating} else {$null}); note=$note; workDir="DL_ASMR/$rjId"; filesDir="DL_ASMR/$rjId"; coverPath=$null; thumbnailPath=$null; lastOpenedFolder=$null; lastPlayedAudioPath=$null; lastPositionMs=0; importedAt=$(if ($existing.importedAt) {$existing.importedAt} else {$stamp}); updatedAt=$stamp }
  Write-Utf8NoBom (Join-Path $staging '_Work.json') $work
  if (Test-Path -LiteralPath $workDir) {
    $backup = Join-Path (Join-Path $root '_MyVault\Backups\DL_ASMR') ("$rjId-$stamp-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Split-Path $backup) | Out-Null
    Move-Item -LiteralPath $workDir -Destination $backup
  }
  Move-Item -LiteralPath $staging -Destination $workDir
  $activated = $true
  $index.works = @($index.works | Where-Object { $_.rjId -ne $rjId }) + $work
  if ($Missing -eq 'create') {
    foreach ($value in $tags) { if (-not (Known $value @($index.dictionaries.tags))) { $index.dictionaries.tags += $value } }
    foreach ($value in $voices) { if (-not (Known $value @($index.dictionaries.voiceActors))) { $index.dictionaries.voiceActors += $value } }
    if ($circle -and -not (Known $circle @($index.dictionaries.circles))) { $index.dictionaries.circles += $circle }
  }
  $index.version = 2
  $tempIndex = "$indexPath.importing-" + [guid]::NewGuid().ToString('N')
  Write-Utf8NoBom $tempIndex $index
  if (Test-Path -LiteralPath $indexPath) {
    [IO.File]::Replace($tempIndex, $indexPath, "$indexPath.bak", $true)
  } else {
    Move-Item -LiteralPath $tempIndex -Destination $indexPath
  }
  $indexCommitted = $true
  $result.work = $work; $result.imported = $true
  $result | ConvertTo-Json -Depth 20
} catch {
  if ($activated -and -not $indexCommitted -and (Test-Path -LiteralPath $workDir)) {
    $failed = Join-Path (Join-Path $root '_MyVault\Backups\DL_ASMR') ("Failed-$rjId-$stamp-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Split-Path $failed) | Out-Null
    Move-Item -LiteralPath $workDir -Destination $failed
  }
  if (-not $indexCommitted -and $backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $workDir)) {
    Move-Item -LiteralPath $backup -Destination $workDir
  }
  throw
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  if ($mutexAcquired) { $agentMutex.ReleaseMutex() }
  $agentMutex.Dispose()
}
