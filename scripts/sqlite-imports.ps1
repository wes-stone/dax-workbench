param(
    [Parameter(Mandatory = $true)][string]$Library,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$Linker
)
$ErrorActionPreference = 'Stop'
$bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Library).Path)
function Read-U32([long]$offset) {
    if ($offset -lt 0 -or $offset + 4 -gt $bytes.Length) { throw 'Invalid SQLite PE directory.' }
    return [BitConverter]::ToUInt32($bytes, [int]$offset)
}
function Read-U16([long]$offset) {
    if ($offset -lt 0 -or $offset + 2 -gt $bytes.Length) { throw 'Invalid SQLite PE header.' }
    return [BitConverter]::ToUInt16($bytes, [int]$offset)
}
if ((Read-U16 0) -ne 0x5a4d) { throw 'SQLite must be a Windows PE library.' }
$pe = Read-U32 0x3c
if ((Read-U32 $pe) -ne 0x4550 -or (Read-U16 ($pe + 4)) -ne 0x8664) { throw 'SQLite must target Windows x64.' }
$sections = Read-U16 ($pe + 6)
$optionalSize = Read-U16 ($pe + 20)
$optional = $pe + 24
if ((Read-U16 $optional) -ne 0x20b -or $sections -lt 1 -or $sections -gt 100) { throw 'Unsupported SQLite PE layout.' }
$sectionTable = $optional + $optionalSize
function Resolve-Rva([long]$rva) {
    for ($i = 0; $i -lt $sections; $i++) {
        $section = $sectionTable + $i * 40
        $address = Read-U32 ($section + 12)
        $size = Read-U32 ($section + 16)
        if ($rva -ge $address -and $rva -lt [long]$address + $size) {
            return [long](Read-U32 ($section + 20)) + $rva - $address
        }
    }
    throw 'SQLite export address is outside its PE sections.'
}
$directory = Resolve-Rva (Read-U32 ($optional + 112))
$count = Read-U32 ($directory + 24)
if ($count -lt 1 -or $count -gt 10000) { throw 'Invalid SQLite export count.' }
$names = Resolve-Rva (Read-U32 ($directory + 32))
$lines = [Collections.Generic.List[string]]::new()
$lines.Add('LIBRARY sqlite3.dll')
$lines.Add('EXPORTS')
for ($i = 0; $i -lt $count; $i++) {
    $start = Resolve-Rva (Read-U32 ($names + $i * 4))
    $end = $start
    while ($end -lt $bytes.Length -and $bytes[$end] -ne 0 -and $end - $start -le 256) { $end++ }
    if ($end -ge $bytes.Length -or $end - $start -gt 256) { throw 'Invalid SQLite export name.' }
    $name = [Text.Encoding]::ASCII.GetString($bytes, [int]$start, [int]($end - $start))
    if ($name -notmatch '^sqlite3[A-Za-z0-9_]+$') { throw 'Unexpected SQLite export name.' }
    $lines.Add("    $name")
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$definition = Join-Path $OutputDirectory 'sqlite3.def'
$archive = Join-Path $OutputDirectory 'libsqlite3.a'
[IO.File]::WriteAllLines($definition, $lines, [Text.Encoding]::ASCII)
& $Linker -flavor link /lib "/def:$definition" /machine:x64 "/out:$archive"
if ($LASTEXITCODE -ne 0) { throw 'SQLite import-library generation failed.' }
