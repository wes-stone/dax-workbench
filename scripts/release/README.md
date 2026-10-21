# DAX Workbench for Windows x64

This package contains the built Copilot extension. Recipients do not need npm,
Rust or the .NET SDK to install it.

**Review packages are not approved releases.** If this archive is labeled
`review`, do not distribute it. Its installer requires an explicit
`-AllowReviewPackage` flag for isolated local review. See
`distribution-review.json` for unresolved conditions.

## Install an approved release

1. Download the Windows x64 ZIP and `SHA256SUMS.txt` from the repository's
   release page. Compare the ZIP's SHA-256 with the published checksum.
2. Extract the ZIP to a new folder. Review the scripts, dependency notices and
   Microsoft terms linked below. Running `.\Install.ps1` without options displays
   the required downloads and stops without installing.
3. In PowerShell, from the extracted folder, run:

```powershell
.\Install.ps1 -DownloadMicrosoftPrerequisites
```

Follow your organization's installation policy. Do not bypass script,
executable or operating-system trust warnings. Checksums detect changes; they
do not authenticate the publisher.

Setup downloads ADOMD 19.117.0 and NativeInterop 0.20.4 from Microsoft's official
NuGet packages. They are not bundled in this ZIP. Review
[ADOMD's terms](https://go.microsoft.com/fwlink/?linkid=852895) and
[NativeInterop's declared terms](https://licenses.nuget.org/MIT) before use.
The flag permits downloading; the installer does not accept agreements for you.
Package sizes, SHA-256 hashes and every installed member are pinned in
`payload\microsoft-prerequisites.json`. HTTPS validation is never disabled.
No NuGet executable or compilation is needed.

For offline installation, obtain the two exact original `.nupkg` files
separately from their official NuGet package pages, then use
`.\Install.ps1 -PrerequisiteDirectory 'C:\approved-packages'` instead.
Use the filenames in the prerequisite descriptor. Missing, changed or
unavailable packages fail explicitly without a network fallback. The installer
retains the original packages inside the local extension's `prerequisites`
directory; do not redistribute that populated installation.

The installer refuses to overwrite an existing DAX Workbench. It neither
reloads Copilot nor changes credentials or saved state. After installation,
reload extensions in your compatible Copilot host and ask **"Open DAX
Workbench."** Click **Run Contoso sample** or visit **Library > Try Contoso**.

## Requirements

Windows x64, Node.js 24+ and a GitHub Copilot host with extension/canvas support
and appropriate Copilot access. Setup needs internet or the original prerequisite
packages acquired separately. This is not a standalone application; ordinary
CLI hosts without canvas rendering do not provide the complete experience.

For real-model Windows MSOLAP/OLE DB connections, install Microsoft's
[x64 MSOLAP provider](https://go.microsoft.com/fwlink/?linkid=829576) and
.NET Framework 4.8. Model permissions are required. MSOLAP is not bundled.
Contoso requires neither a provider installation nor model credentials.

## Privacy and limitations

The four Contoso recipes use invented retail data, not a general DAX evaluator.
Other DAX requires a real model. Agent query and result-analysis access start
off. Enable each separately only when needed.

The extension installs at `<CopilotHome>\extensions\dax-copilot-workbench`.
New state is stored separately at
`<CopilotHome>\workbench-data\dax-copilot-workbench`.
Do not share a populated installation or its state directory.

Original dependency notices remain installed in `notices`; the inventory is
`third-party-licenses.json`. Recipient-acquired packages are listed separately
from bundled dependencies. No project license or redistribution approval is
implied by this local package.
