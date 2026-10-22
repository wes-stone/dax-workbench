# Windows x64 pilot

**Experimental Windows x64 pilot.** Use only the reviewed GitHub release asset;
files labeled `review` remain local-review packages, not approved releases.

**[Start with the installation guide](https://github.com/wes-stone/dax-workbench/blob/main/GETTING-STARTED.md).**
For standard real-model use, install
[Microsoft MSOLAP x64 / amd64](https://go.microsoft.com/fwlink/?linkid=829576)
and .NET Framework 4.8 (or a compatible later version) first.
The extension's prerequisite-download option does not install MSOLAP.
Contoso-only exploration does not require the provider.

- Built extension, frontend, native companion and Rust/WASM engine; no
  compilation is required on the recipient installation path.
- Credential-free Contoso retail demo with four supported recipes, synchronized
  builder examples, result exploration and reusable Python handoffs.
- Generated Python projects support `--format table`; notebook and Streamlit
  dependencies remain available after ordinary `uv sync`.
- Fresh-only installation, separate user-state location, and agent query and
  result-analysis permissions off by default.
- Traceable runtime workbook bundle and original dependency notices retained
  inside the installed extension.
- Microsoft ADOMD and NativeInterop are obtained directly from official NuGet
  packages during setup, not redistributed in this ZIP. Downloads require an
  explicit option after terms review; package and member hashes are checked.
  Exact separately acquired packages also support offline installation.

Use the archive's manifest and verification report for its exact source
fingerprint, checks and unresolved redistribution conditions. Synthetic
native/browser checks alone do not certify a live Copilot-host installation or
real-model authentication. The pilot is unsigned.
