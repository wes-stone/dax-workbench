# Publication decisions still required

**Private source pilot. Public visibility, project licensing and binary releases remain separate decisions.**

| Gate | Remaining decision or work |
|---|---|
| Ownership and project license | Confirm who can authorize source and binary redistribution. Obtain that authorization and then select appropriate terms. No project license or ownership claim has been assigned here. |
| Dependency redistribution | Review the exact candidate's `third-party-licenses.json` and supplied notices, including missing notices and nonstandard/proprietary terms. A detected declaration is not permission to redistribute. |
| Native runtime inventory | The current inventory combines production npm, published NuGet dependencies and Windows-scoped Rust metadata. Confirm bundled .NET runtime/native components, transitively bundled code and all required notices are completely covered; a package-record count alone cannot establish this. |
| Signing and trust | The pilot is unsigned. Decide on code/script signing, trusted delivery and organizational approval. Hashes are integrity checks, not publisher authentication. Do not tell recipients to bypass warnings. |
| Recipient host compatibility | Record the exact supported Copilot host/channel and extension/canvas API version; test in an approved clean recipient host. The isolated native/browser walkthrough is not evidence of an end-to-end live Copilot-host installation. |
| Source release | This repository is a separate generic source export, not the development workspace. Personal packs, user state, connection profiles and captured business results are excluded. |
| Repository and audience | The user selected wes-stone/dax-workbench and requested the extension upload. Keep the repository private; no visibility change, project license or prebuilt binary release is part of this upload. |
| User-selected images | Nine user-supplied retail-only snippets are staged, including only the latest selected VS Code notebook image. Duplicates and other VS Code captures are excluded. Review the exact images/captions before publication; they show the October 20 preview, not a fresh capture of the immutable October 14 ZIP. |
| Final review | Review the exact immutable ZIP and presentation hashes, inspect all images, assess the threat model and validate intended model/provider scenarios. Content checks do not certify security or business correctness. |

## What this preparation includes

- A new generic Windows x64 candidate, manifest, SHA-256 checksum and content-check
  report. It preserves fresh-only installation and off-by-default agent access.
- A credential-free Contoso first-run path with four distinct executable recipes
  for Desks, Chairs and Lamps, measured in revenue and units sold,
  and matching builder selections for the three summary starters.
  The native fixture rejects unsupported DAX instead of returning invented
  query results.
- Local README material with nine user-selected retail snippets and a media
  provenance/hash manifest. Only the newly selected VS Code notebook image is
  included. Packaging with `--no-media` still takes no screenshots and includes
  no images; `--reuse-media` accepts only recorded retail-domain captures.
  No personal canvas, state, connection registry or results are used.
- A differentiation-first README covering Copilot-connected authoring,
  result exploration and reusable analysis, with all nine selected images inline
  and short feature captions instead of a detailed manual.
  It distinguishes the isolated preview from live Copilot integration and the
  executed offline notebook. DAX Studio is credited as inspiration, without
  affiliation or feature-parity claims.
- A documented x64 MSOLAP prerequisite for Windows MSOLAP/OLE DB connections,
  linked to Microsoft's client-library download; Contoso needs no separate
  provider. A source-linked DAX Studio comparison distinguishes shared query
  building from DAX Studio's server diagnostics and Workbench's analysis workflow.
- Executable Python handoffs: plain `uv sync` installs the notebook kernel and
  Streamlit. Contoso projects carry the offline four-recipe retail fixture.
  The isolated package gate runs the generated CLI, notebook kernel and
  Streamlit query buttons and checks exact results against the native fixture.
  This does not validate real-model authentication or every editor's kernel picker.

The notice collector now recognizes `.markdown` license files and retains a
package README when it contains a full copyright/permission/warranty notice.
It does not substitute generic license text, infer missing rights or fetch
unverified notices. Use the candidate's report for exact counts.

## Safe staging boundary

This repository contains only the separately selected generic source and presentation. Do not add personal model packs, credentials, connections, generated results, compiled dependencies or saved Workbench state. The binary candidate must separately pass the remaining distribution gates.

This source upload includes the approved synthetic imagery. It does not publish a prebuilt binary release or change repository visibility.

The October 20 screenshot preview includes a later two-file Python exporter
overlay (`--format table` and generated README guidance). That overlay does not
modify or supersede the immutable October 14 candidate. Reconcile the final
binary, documentation and images before approving external distribution.
