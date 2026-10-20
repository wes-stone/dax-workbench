param(
    [string]$NativeDirectory,
    [switch]$CoreOnly,
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:CARGO_ENCODED_RUSTFLAGS = @("--remap-path-prefix=$root=/_/workbench", "--remap-path-prefix=$env:USERPROFILE=/_/user") -join [char]31
$localCargo = Join-Path $root '.tools\cargo\bin\cargo.exe'
if (Test-Path -LiteralPath $localCargo) {
    $env:CARGO_HOME = Join-Path $root '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $root '.tools\rustup'
    $env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"
    $cargo = $localCargo
} else {
    $cargo = (Get-Command cargo -ErrorAction Stop).Source
}
$manifest = Join-Path $root 'Cargo.toml'
& $cargo build --manifest-path $manifest --locked --release --target wasm32-unknown-unknown -p dax-workbench-core
if ($LASTEXITCODE -ne 0) { throw 'Rust builder compilation failed. Install the pinned Rust toolchain and its WASM target.' }
$core = Join-Path $root 'engine\artifacts'
New-Item -ItemType Directory -Path $core -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'target\wasm32-unknown-unknown\release\dax_workbench_core.wasm') -Destination $core -Force
if (-not $CoreOnly) {
    $native = if ($NativeDirectory) { (Resolve-Path -LiteralPath $NativeDirectory).Path } elseif ($env:DAX_WORKBENCH_NATIVE_DIRECTORY) { (Resolve-Path -LiteralPath $env:DAX_WORKBENCH_NATIVE_DIRECTORY).Path } else { Join-Path $root 'native\publish' }
    $sqlite = Join-Path $native 'e_sqlite3.dll'
    if (-not (Test-Path -LiteralPath $sqlite)) { throw 'Build the Microsoft native adapters first; their SQLite library is required.' }
    $link = Join-Path $root '.tools\sqlite-link'
    New-Item -ItemType Directory -Path $link -Force | Out-Null
    Copy-Item -LiteralPath $sqlite -Destination (Join-Path $link 'sqlite3.dll') -Force
    $sysroot = & (Join-Path (Split-Path $cargo -Parent) 'rustc.exe') --print sysroot
    if ($LASTEXITCODE -ne 0) { throw 'Unable to locate the pinned Rust linker.' }
    $linker = Join-Path $sysroot 'lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe'
    & (Join-Path $PSScriptRoot 'sqlite-imports.ps1') -Library $sqlite -OutputDirectory $link -Linker $linker
    $env:SQLITE3_LIB_DIR = $link
    $env:PATH = "$link;$env:PATH"
    & $cargo build --manifest-path $manifest --locked --release --target x86_64-pc-windows-gnu -p dax-workbench-engine --bin dax-workbench-engine
    if ($LASTEXITCODE -ne 0) { throw 'Rust native engine compilation failed.' }
    Copy-Item -LiteralPath (Join-Path $root 'target\x86_64-pc-windows-gnu\release\dax-workbench-engine.exe') -Destination (Join-Path $native 'DaxWorkbench.Engine.exe') -Force
    Copy-Item -LiteralPath $sqlite -Destination (Join-Path $native 'sqlite3.dll') -Force
    if ($Test) {
        & $cargo build --manifest-path $manifest --locked --release --target x86_64-pc-windows-gnu -p dax-workbench-engine --bin fixture-provider
        if ($LASTEXITCODE -ne 0) { throw 'Synthetic result fixture compilation failed.' }
        & $cargo test --manifest-path $manifest --locked --release --target x86_64-pc-windows-gnu -p dax-workbench-engine --lib --bin dax-workbench-engine
        if ($LASTEXITCODE -ne 0) { throw 'Rust native tests failed.' }
    }
}
if ($Test) {
    & $cargo test --manifest-path $manifest --locked --release --target x86_64-pc-windows-gnu -p dax-workbench-core
    if ($LASTEXITCODE -ne 0) { throw 'Rust builder tests failed.' }
}
Write-Output 'Rust engine assets built successfully.'
