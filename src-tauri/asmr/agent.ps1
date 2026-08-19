[CmdletBinding()]
param(
  [Parameter(Position = 0)] [ValidateSet('preview', 'import')] [string]$Command = 'preview',
  [Alias('data-root')] [string]$DataRoot,
  [string]$Source,
  [Alias('metadata-file')] [string]$MetadataFile,
  [Alias('metadata-json')] [string]$MetadataJson,
  [ValidateSet('skip', 'create')] [string]$Missing = 'skip',
  [switch]$Overwrite
)

# The implementation lives with the repository scripts; this module-local entrypoint
# makes the agent tool part of DL_ASMR without placing any executable/config in data.
$tool = Join-Path $PSScriptRoot '..\..\scripts\asmr-agent.ps1'
& $tool @PSBoundParameters
exit $LASTEXITCODE
