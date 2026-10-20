param([string]$CopilotHome)
$ErrorActionPreference = 'Stop'
function Get-PackageHash([string]$File) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($File)
        try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose() }
    } finally { $algorithm.Dispose() }
}
if (-not $CopilotHome) { $CopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' } }
$homeRoot = [IO.Path]::GetFullPath($CopilotHome)
$payload = Join-Path $PSScriptRoot 'payload'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.profile -cne 'generic') { throw 'Unsupported release manifest.' }
$destination = Join-Path $homeRoot 'extensions\dax-copilot-workbench'
if (Test-Path -LiteralPath $destination) { throw 'DAX Workbench is already installed. This pilot installer will not overwrite or migrate existing software or saved data.' }
$entries = @($manifest.files | Where-Object { $_.path.StartsWith('payload/', [StringComparison]::Ordinal) })
if (-not $entries.Count) { throw 'The manifest contains no extension files.' }
$paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $entries) {
    $relative = $entry.path.Substring(8)
    if ($relative -match '[\\:\x00-\x1f]' -or @($relative.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -or -not $paths.Add($relative)) {
        throw 'Unsafe or duplicate package path.'
    }
    $file = Join-Path $payload $relative.Replace('/', '\')
    $item = Get-Item -LiteralPath $file
    if ($item.PSIsContainer -or $item.Length -ne $entry.bytes -or (Get-PackageHash $file) -ine $entry.sha256) {
        throw "Package integrity check failed: $relative"
    }
    $ancestor = $item
    while ($ancestor -and $ancestor.FullName.Length -ge $payload.Length) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked package files or folders are not permitted.' }
        $ancestor = if ($ancestor.PSIsContainer) { $ancestor.Parent } else { $ancestor.Directory }
    }
}
if (@(Get-ChildItem -LiteralPath $payload -File -Recurse -Force).Count -ne $entries.Count) { throw 'Unexpected files were added to the package.' }
New-Item -ItemType Directory -Path $homeRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $homeRoot 'extensions') -Force | Out-Null
$stage = Join-Path $homeRoot ('.dax-install-stage-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($entry in $entries) {
        $relative = $entry.path.Substring(8).Replace('/', '\')
        $target = Join-Path $stage $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $payload $relative) -Destination $target
        if ((Get-PackageHash $target) -ine $entry.sha256) { throw 'A file changed during installation.' }
    }
    [IO.Directory]::Move($stage, $destination)
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
Write-Output 'Installed the generic DAX Workbench pilot. Reload Copilot extensions, then ask to open DAX Workbench.'
Write-Output 'Saved state will be created outside the extension folder, under workbench-data\dax-copilot-workbench in your Copilot home.'
