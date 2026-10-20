param([string]$Runtime = 'win-x64')
$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$root = Split-Path $PSScriptRoot -Parent
$local = Join-Path $root '.tools\dotnet\dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $local) { $local } else { (Get-Command dotnet -ErrorAction Stop).Source }
$project = Join-Path $root 'native\DaxWorkbench.Host\DaxWorkbench.Host.csproj'
$packages = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $root '.tools\nuget-packages' }
$output = Join-Path $root 'native\publish'
& $dotnet restore $project --configfile (Join-Path $root 'native\NuGet.Config') --packages $packages --runtime $Runtime --verbosity minimal
if ($LASTEXITCODE -ne 0) { throw 'Native dependency restore failed.' }
& $dotnet publish $project --configuration Release --runtime $Runtime --self-contained true --no-restore --output $output --verbosity minimal "-p:PathMap=$root=/_/workbench" -p:DebugType=None -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw 'Native publish failed.' }
& (Join-Path $PSScriptRoot 'build-rust.ps1') -NativeDirectory $output
Write-Output 'Native and WASM build completed.'
