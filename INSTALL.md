# Install from source

This repository shares the **extension that provides the canvas**, not a running
canvas, saved workspace or connection. Each recipient installs a local copy.
While the repository is private, only people granted repository access can clone it.

The Copilot app supports extension installation from repository folders and Gists.
Those routes require a complete, ready-to-run extension. **Do not point the app's
repository-folder installer at this unbuilt source tree.** DAX Workbench also
needs its compiled UI, Rust/WASM engine and Windows native companion.

## Prerequisites

- Windows x64 and Node.js 24+ with npm.
- A GitHub Copilot host with extension/canvas support and appropriate access.
  The canvas API is experimental; a plain browser or CLI without canvas rendering
  does not provide the complete experience.
- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- [Rustup](https://rustup.rs/) with the toolchain and targets pinned in
  `rust-toolchain.toml`. Run `rustup show` from the cloned directory to resolve them.
- Microsoft Edge for the optional isolated installation smoke check.

For real-model **Windows MSOLAP/OLE DB** connections, also install
[Microsoft Analysis Services OLE DB Provider (MSOLAP), x64/amd64](https://go.microsoft.com/fwlink/?linkid=829576)
and .NET Framework 4.8. Contoso needs no separate provider or model credentials.
Other connection modes have their own requirements.

## Build and install

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

## Distribution status

This repository contains project source and synthetic demo imagery, not bundled
third-party binaries, personal model packs or user data. No project license has
been assigned; dependency licenses remain separate. A prebuilt release is not
being published with this source upload. Its dependency notices and distribution
review must be completed before offering a ready-to-use binary package.
