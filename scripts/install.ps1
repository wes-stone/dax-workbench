param([string]$CopilotHome)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $CopilotHome) { $CopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' } }
$homeRoot = [IO.Path]::GetFullPath($CopilotHome)
$destination = Join-Path $homeRoot 'extensions\dax-copilot-workbench'
if (Test-Path -LiteralPath $destination) { throw 'DAX Workbench is already installed. This source installer will not overwrite existing software or saved data.' }
$stage = Join-Path $root ('.source-install-' + [Guid]::NewGuid().ToString('N'))
try {
    & node (Join-Path $PSScriptRoot 'stage-install.mjs') $stage
    if ($LASTEXITCODE -ne 0) { throw 'Source installation staging failed. Run npm ci, npm run build:native, then npm run build first.' }
    & (Join-Path $stage 'Install.ps1') -CopilotHome $homeRoot
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
