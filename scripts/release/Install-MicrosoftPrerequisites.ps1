function Assert-SafeRelativePath([string]$Relative) {
    if (-not $Relative -or $Relative -match '[\\:<>\|?*\x00-\x1f\x7f]' -or
        @($Relative.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$|^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)' }).Count) {
        throw 'Unsafe prerequisite path.'
    }
}
function Assert-FileMetadata($Entry) {
    if ($null -eq $Entry.bytes -or $Entry.bytes -le 0 -or $Entry.bytes -gt 104857600 -or
        $Entry.bytes -ne [Math]::Truncate($Entry.bytes) -or $Entry.sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Invalid prerequisite metadata.'
    }
}
function Read-MicrosoftPrerequisites($Manifest, $PackagePaths) {
    if ($Manifest.prerequisites -cne 'payload/microsoft-prerequisites.json' -or -not $PackagePaths.Contains($Manifest.prerequisites)) {
        throw 'Unsupported prerequisite descriptor.'
    }
    $spec = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'payload\microsoft-prerequisites.json') -Raw | ConvertFrom-Json
    if ($spec.version -ne 1 -or $spec.acquisition -cne 'recipient-direct-from-nuget' -or @($spec.packages).Count -ne 2) {
        throw 'Unsupported Microsoft prerequisites.'
    }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $outputs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($pkg in $spec.packages) {
        if ($pkg.name -cnotin @('Microsoft.AnalysisServices.AdomdClient', 'Microsoft.Identity.Client.NativeInterop') -or
            -not $names.Add($pkg.name) -or $pkg.version -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected Microsoft prerequisite identity.' }
        $id = $pkg.name.ToLowerInvariant()
        $filename = "$id.$($pkg.version).nupkg"
        $license = if ($id -eq 'microsoft.analysisservices.adomdclient') { 'https://go.microsoft.com/fwlink/?linkid=852895' } else { 'https://licenses.nuget.org/MIT' }
        if ($pkg.filename -cne $filename -or $pkg.url -cne "https://www.nuget.org/api/v2/package/$id/$($pkg.version)" -or
            $pkg.licenseUrl -cne $license -or $pkg.retainedPath -cne "prerequisites/$filename") { throw 'Unexpected Microsoft prerequisite source.' }
        Assert-FileMetadata $pkg
        if (-not @($pkg.files).Count) { throw 'Microsoft prerequisite has no runtime files.' }
        $members = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($file in $pkg.files) {
            Assert-SafeRelativePath $file.member
            Assert-SafeRelativePath $file.path
            Assert-FileMetadata $file
            if (-not $file.path.StartsWith('native/publish/', [StringComparison]::Ordinal) -or -not $file.path.EndsWith('.dll', [StringComparison]::Ordinal) -or
                -not $outputs.Add($file.path) -or -not $members.Add($file.member) -or $PackagePaths.Contains("payload/$($file.path)")) {
                throw 'Unexpected or colliding prerequisite output.'
            }
        }
        if (-not $outputs.Add($pkg.retainedPath) -or $PackagePaths.Contains("payload/$($pkg.retainedPath)")) { throw 'Colliding retained prerequisite package.' }
    }
    return $spec
}
function Save-OfficialNuGetPackage($Package, [string]$Destination) {
    $uri = [Uri]$Package.url
    for ($redirect = 0; $redirect -le 3; $redirect++) {
        $validPath = ($uri.Host -ceq 'www.nuget.org' -and $uri.AbsolutePath -ceq ([Uri]$Package.url).AbsolutePath) -or
            ($uri.Host -ceq 'globalcdn.nuget.org' -and $uri.AbsolutePath -ceq "/packages/$($Package.filename)")
        if ($uri.Scheme -cne 'https' -or $uri.Port -ne 443 -or $uri.UserInfo -or -not $validPath) { throw 'NuGet redirected to an unapproved location.' }
        $request = [Net.HttpWebRequest]::Create($uri)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 90000
        $request.ReadWriteTimeout = 90000
        $response = $request.GetResponse()
        try {
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                $uri = [Uri]::new($uri, $response.Headers['Location'])
                continue
            }
            if ($status -ne 200 -or ($response.ContentLength -ge 0 -and $response.ContentLength -ne $Package.bytes)) { throw 'Unexpected NuGet download response.' }
            $input = $response.GetResponseStream()
            $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
            try {
                $buffer = New-Object byte[] 65536
                $total = 0L
                while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt $Package.bytes) { throw 'NuGet download exceeds its pinned size.' }
                    $output.Write($buffer, 0, $count)
                }
                if ($total -ne $Package.bytes) { throw 'NuGet download is incomplete.' }
            } finally { $output.Dispose(); $input.Dispose() }
            return
        } finally { $response.Dispose() }
    }
    throw 'Too many NuGet redirects.'
}
function Install-MicrosoftPrerequisites($Spec, [string]$Stage, [string]$PrerequisiteDirectory) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    foreach ($pkg in $Spec.packages) {
        $archivePath = Join-Path $Stage $pkg.retainedPath.Replace('/', '\')
        New-Item -ItemType Directory -Path (Split-Path $archivePath -Parent) -Force | Out-Null
        if ($PrerequisiteDirectory) {
            $source = Join-Path $PrerequisiteDirectory $pkg.filename
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing prerequisite package: $($pkg.filename). No network fallback is performed." }
            Copy-Item -LiteralPath $source -Destination $archivePath
        } else {
            Write-Output "Downloading $($pkg.name) $($pkg.version) from NuGet."
            Save-OfficialNuGetPackage $pkg $archivePath
        }
        if ((Get-Item -LiteralPath $archivePath).Length -ne $pkg.bytes -or (Get-PackageHash $archivePath) -ine $pkg.sha256) { throw "Prerequisite package integrity check failed: $($pkg.name)" }
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            $members = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($member in $archive.Entries) {
                if ($member.FullName.EndsWith('/')) { continue }
                Assert-SafeRelativePath $member.FullName
                if ($members.ContainsKey($member.FullName)) { throw 'Duplicate prerequisite archive member.' }
                $members.Add($member.FullName, $member)
            }
            foreach ($file in $pkg.files) {
                $member = $members[$file.member]
                if (-not $member -or $member.FullName -cne $file.member -or $member.Length -ne $file.bytes) { throw 'Missing or invalid prerequisite archive member.' }
                $target = Join-Path $Stage $file.path.Replace('/', '\')
                New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
                $input = $member.Open()
                $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
                try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
                if ((Get-PackageHash $target) -ine $file.sha256) { throw 'Prerequisite member integrity check failed.' }
            }
        } finally { $archive.Dispose() }
    }
}
