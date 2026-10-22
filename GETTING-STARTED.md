# Get DAX Workbench

Install DAX Workbench for Windows and open it inside GitHub Copilot. You do not
need to clone the repository, compile code, or install Rust or the .NET SDK.

**Required for the standard real-model setup: install Microsoft's x64 MSOLAP
provider first.** Downloading the file is not enough; complete Microsoft's
installer. Workbench's `-DownloadMicrosoftPrerequisites` option does **not**
install this provider.

**[Download Microsoft MSOLAP (x64 / amd64)](https://go.microsoft.com/fwlink/?linkid=829576)**
| **[Download DAX Workbench](https://github.com/wes-stone/dax-workbench/releases/tag/v0.1.0-pilot.1)**

This guide is for Windows x64 pilot `v0.1.0-pilot.1`. The repository is currently
private: links require repository access, even when shared with Copilot.
You can also download this Markdown file and attach it to a Copilot conversation.

## Give this to GitHub Copilot

Copy this prompt, or attach this file with the same request:

```text
Help me install DAX Workbench using this guide:
https://github.com/wes-stone/dax-workbench/blob/main/GETTING-STARTED.md

First check Windows x64, Node.js 24+, a Copilot host with extension/canvas
support, and whether DAX Workbench is already installed. Stop if an existing
installation would be overwritten; do not delete or migrate it.
For the standard real-model setup, require Microsoft's x64 MSOLAP provider
and .NET Framework 4.8 or a compatible later version. Do not confuse MSOLAP
with the ADOMD and NativeInterop packages that Workbench downloads itself.
Ask before installing software or changing settings. Leave Microsoft license
acceptance, sign-in and Windows elevation prompts to me. Never bypass trust
warnings, execution policy, certificate checks or organization restrictions.
Use the built Windows ZIP from the release, not GitHub's Source code ZIP.
Verify its checksum, then follow the guide's installation and reload steps.
Finish by helping me open Contoso. Do not access my real models, saved results
or credentials, or enable agent query/result-analysis access automatically.
If the private link is inaccessible, ask me to attach the guide; do not request
passwords or access tokens in chat.
```

## 1. Install the required Microsoft provider

Use the official **[MSOLAP x64 / amd64 installer](https://go.microsoft.com/fwlink/?linkid=829576)**,
not the x86 installer. Review Microsoft's license and complete setup yourself;
your organization may require IT approval or administrator access.

Also have **[.NET Framework 4.8](https://dotnet.microsoft.com/download/dotnet-framework/net48)**
or a compatible later version installed. It may already be included with Windows.
If you need to install it, choose the **Runtime**, not the Developer Pack.
This is the Windows provider worker's requirement, not the .NET 10 SDK.

If MSOLAP is already installed, check that it is the x64 provider and an
appropriate current version rather than reinstalling blindly. Microsoft's
[client-library instructions](https://learn.microsoft.com/en-us/analysis-services/client-libraries)
explain how to check `msolap.dll` under
`C:\Program Files\Microsoft Analysis Services\AS OLEDB\`.
Having Power BI Desktop or Excel installed is not, by itself, confirmation that
the provider this extension needs is available and current.

**Why this step matters:** Workbench's Windows MSOLAP/OLE DB connection mode
requires this separately installed provider. Installing it does not grant access
to a model; you still need the appropriate account and model permissions.

**Contoso-only exception:** if you only want to try the synthetic demo, you may
skip MSOLAP and .NET Framework for now. A successful Contoso run does not prove
that real-model connections are ready. Other connection modes have their own
requirements; this guide uses Windows MSOLAP as the standard setup path.

## 2. Check the rest of your setup

| Required | What to check |
|---|---|
| Windows x64 | This pilot is not a macOS, Linux or native ARM64 package. |
| Node.js 24 or later | Run `node --version`. If missing or older, obtain an approved version from [nodejs.org](https://nodejs.org/en/download). npm is not needed to install the built ZIP. |
| GitHub Copilot with extension/canvas support | Use a host that supports both features and has appropriate Copilot access. A Copilot subscription, plain browser, or ordinary CLI alone does not guarantee canvas support. |
| Internet and repository access | Needed for the private release and setup's official NuGet downloads. See the [offline instructions](https://github.com/wes-stone/dax-workbench/blob/main/INSTALL.md#download-and-install) if necessary. |

## 3. Download and install Workbench

1. Open the **[pilot release](https://github.com/wes-stone/dax-workbench/releases/tag/v0.1.0-pilot.1)**.
   Download the asset ending in **`win-x64.zip`** and **`SHA256SUMS.txt`**.
   Do not download the automatically generated **Source code** archive.
2. Compare the ZIP's SHA-256 with its entry in `SHA256SUMS.txt`. In PowerShell,
   use `Get-FileHash -LiteralPath '<path-to-downloaded-ZIP>' -Algorithm SHA256`,
   replacing the placeholder with your actual ZIP path. Stop if it differs.
   A matching checksum detects changes; it is not a publisher signature.
3. Extract the ZIP into a **new, empty folder**. Keep separately downloaded
   checksums, reports and this guide **outside** that folder: the installer
   rejects extra files not listed in the archive's manifest.
4. Open PowerShell in the extracted folder and run `.\Install.ps1`.
   For this release, it displays the Microsoft prerequisite terms and stops
   without installing or downloading. Review those terms and the scripts.
5. When ready, run:

```powershell
.\Install.ps1 -DownloadMicrosoftPrerequisites
```

The installer downloads **ADOMD 19.117.0** and **NativeInterop 0.20.4** directly
from official NuGet sources and verifies the package and installed-file hashes.
**These are not the MSOLAP provider from step 1.** You need both for the
standard Windows MSOLAP setup. The flag permits these downloads; it does not
accept Microsoft agreements on your behalf.

The pilot is unsigned. If your organization or Windows blocks it, stop and
follow the approved software-installation process. Do not change execution
policy, disable certificate checks or bypass trust warnings to force it through.

An existing Workbench installation is never overwritten. The extension goes in
`<CopilotHome>\extensions\dax-copilot-workbench`; saved work stays separately in
`<CopilotHome>\workbench-data\dax-copilot-workbench`.
`CopilotHome` defaults to `$HOME\.copilot` unless `COPILOT_HOME` is configured.

## 4. Open the example

Reload extensions using your compatible Copilot host's supported action, then
ask **"Open DAX Workbench."** If Copilot requests permission to register extension
hooks, inspect the request before approving it.

Click **Run Contoso sample**, or open **Library > Try Contoso**. You should see
invented retail data for Desks, Chairs and Lamps. Explore the results with a
pivot or chart. Contoso supports four fixed recipes, not arbitrary DAX.

Agent query access and result-analysis access start **off**. Leave them off
until you explicitly want those capabilities. Real-model connection setup,
authentication and query execution are separate choices, not installation steps.

## If setup stops

| Symptom | What to do |
|---|---|
| GitHub link returns 404 | Sign in with an account that has repository access; contact the repository owner if needed. |
| MSOLAP is missing or not registered | Complete the official x64 provider installation from step 1. Do not substitute the ADOMD download or a random DLL. |
| Installer reports an existing Workbench | Stop. Do not remove the existing extension or its saved data to make the installer succeed. |
| Checksum mismatch or unexpected files | Stop and obtain a fresh official ZIP; extract into a new folder without adding separately downloaded files. |
| NuGet download fails | Check approved network access to NuGet, or use the exact-package offline instructions. Do not disable HTTPS checks. |
| Copilot cannot open a canvas | Confirm host support. Installing MSOLAP does not add canvas support to Copilot. |

See [detailed installation and source-build instructions](https://github.com/wes-stone/dax-workbench/blob/main/INSTALL.md)
for the offline path and additional technical details.
