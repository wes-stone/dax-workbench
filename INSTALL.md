# Install DAX Workbench

This repository shares the **extension that provides the canvas**, not a running
canvas, saved workspace or connection. Each recipient installs a local copy.
While the repository is private, only people granted repository access can clone it.

The Copilot app supports extension installation from repository folders and Gists.
Those routes require a complete, ready-to-run extension. **Do not point the app's
repository-folder installer at this unbuilt source tree.** DAX Workbench also
needs its compiled UI, Rust/WASM engine and Windows native companion.

## Download and install

Download the Windows x64 ZIP and `SHA256SUMS.txt` from the
[pilot release](https://github.com/wes-stone/dax-workbench/releases/tag/v0.1.0-pilot.1).
The repository is private, so downloads require repository access. Verify the
SHA-256, and extract to a new directory. Run `.\Install.ps1` first to see the
Microsoft prerequisite terms and download instructions; it makes no changes.
After reviewing the terms, run `.\Install.ps1 -DownloadMicrosoftPrerequisites`.
Then reload extensions in a compatible Copilot host and ask **"Open DAX
Workbench."** No npm, Rust or .NET SDK is needed on that installation path.

Do not use GitHub's automatically generated **Source code** ZIP as the built
extension. Do not distribute files labeled `review`; those retain unresolved
conditions and require `-AllowReviewPackage` for isolated local installation.
The installer does not bypass trust warnings or organizational policy.

Setup downloads **Microsoft.AnalysisServices.AdomdClient 19.117.0** and
**Microsoft.Identity.Client.NativeInterop 0.20.4** directly from their official
NuGet package pages. Those binaries are **not in the GitHub ZIP**. Review
[ADOMD's terms](https://go.microsoft.com/fwlink/?linkid=852895) and
[NativeInterop's declared terms](https://licenses.nuget.org/MIT) before use.
The download flag authorizes network access, not acceptance of a new agreement
on your behalf or a grant of redistribution rights.

Downloads require HTTPS and are checked against pinned package and individual
file hashes. Only declared runtime files are installed. The exact original
packages remain under `prerequisites` in the local installation. No compiler,
NuGet executable or npm restore is used.

For machines without internet access, obtain those exact original `.nupkg`
files from their official NuGet pages on an approved connected machine, then
use `.\Install.ps1 -PrerequisiteDirectory 'C:\approved-packages'`. The directory
must contain the original lower-case package filenames from
`payload\microsoft-prerequisites.json`. Missing or changed packages fail without
network fallback. Any failure removes only the new temporary installation;
an existing installation is never changed.

## Prerequisites

- Windows x64 and Node.js 24+. npm is needed only for source builds.
- Internet during first installation, or the exact separately acquired packages above.
- A GitHub Copilot host with extension/canvas support and appropriate access.
  The canvas API is experimental; a plain browser or CLI without canvas rendering
  does not provide the complete experience.
- **Source builds only:** [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- **Source builds only:** [Rustup](https://rustup.rs/) with the toolchain and targets pinned in
  `rust-toolchain.toml`. Run `rustup show` from the cloned directory to resolve them.
- Microsoft Edge for the optional isolated installation smoke check.

For real-model **Windows MSOLAP/OLE DB** connections, also install
[Microsoft Analysis Services OLE DB Provider (MSOLAP), x64/amd64](https://go.microsoft.com/fwlink/?linkid=829576)
and .NET Framework 4.8. Contoso needs no separate provider or model credentials.
Other connection modes have their own requirements.

## Build from source

Review the repository and scripts first. Follow your organization's software
installation policy; do not bypass unsigned-script or executable warnings.

```powershell
git clone https://github.com/wes-stone/dax-workbench.git
Set-Location dax-workbench
npm ci
rustup show
npm run build:native
npm run build
npm run install:user
```

Dependency restore and compilation happen locally. The SDK is supplied by the
Copilot host; it is not vendored into this repository.

The installer copies the built generic extension into
`<CopilotHome>\extensions\dax-copilot-workbench` and **refuses to overwrite an
existing installation**. It does not install or reload Copilot, migrate an
existing extension, configure credentials or change permissions.

Reload extensions in the Copilot host, then ask **"Open DAX Workbench."**
Click **Run Contoso sample** or open **Library > Try Contoso**.
Only four fixed synthetic recipes are supported; arbitrary DAX needs a real model.

Recipient data is stored separately under
`<CopilotHome>\workbench-data\dax-copilot-workbench`.
Agent query access and result-analysis access both start off.
Do not commit that data or redistribute an installation that has accumulated it.

## Optional local smoke check

After building:

```powershell
npm run test:install
```

This uses a fresh temporary Copilot home and a synthetic-only adapter. It checks
installation, overwrite refusal, the four Contoso recipes, the builder, generated
Python files and browser startup. It never reloads your installed extensions,
reads your saved Workbench state or queries real models. It is not a live-host
compatibility certification.

## Maintainer packaging

After restoring source-build dependencies, run:

```powershell
npm run test:release
npm run package:review
```

`package:review` performs a fresh build and creates a new immutable local
candidate only after the actual ZIP has passed installation and synthetic
checks. Its SHA-256, exact source fingerprint, dependency inventory and unresolved
conditions are recorded beside it. It never uploads, reloads extensions or
reads personal saved state.

`npm run package:release` rejects missing original notices and unresolved
conditions for **bundled** dependencies. The two recipient-acquired Microsoft
packages are inventoried separately, and packaging rejects any retained copy
of their runtime files. Passing this technical gate is **not** project ownership,
privacy, audience, licensing or publishing approval. No command publishes.
Original notices remain inside the installed payload.

## Copilot runtime compatibility

The Windows pilot has been exercised in a separate, empty Copilot SDK
runtime **1.0.99-2**, with no inherited credentials or model prompts. Extension
discovery, canvas opening, Contoso schema/builder context and disabled-by-default
agent execution worked. Copilot may request permission to register extension
hooks; inspect that request before allowing it. This is separate from the
Workbench's query and result-analysis switches.

See the release's `host-contract-verification.json` for the exact archive hash.
The check does not certify every desktop renderer or real-model authentication.

## Distribution status

The source tree contains project source and synthetic demo imagery, not personal
model packs or user data. The private release additionally contains compiled
components and the applicable bundled-dependency notices. No project license has
been assigned; dependency licenses remain separate. Installation does not grant
repository or model access. Build reports describe technical checks, not legal
certification or permission to redistribute a populated installation.
