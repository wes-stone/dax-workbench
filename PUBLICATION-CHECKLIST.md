# Release checklist

The generic source is published privately. No public visibility change, project
license or binary release is implied by local packaging.

The user approved publishing the reviewed Windows pilot and source updates to
the existing **private** repository, with no access, visibility or license
changes. Future releases still need their own review and authorization.

| Gate | Required evidence or decision |
|---|---|
| Source boundary | Build only this separately sanitized repository. Never copy the personal development folder, installed extension, model packs, connections, results or saved state. Record the base commit and exact current source fingerprint, including uncommitted changes. |
| Original dependency notices | Use actual frontend and runtime bundle inputs, published NuGet dependencies including the .NET runtime, and target-filtered Rust graphs. Preserve original notices and their hashes inside the installed payload. A license declaration alone is not a substitute. |
| Conditional redistribution | Resolve every blocker for bundled packages in `third-party-licenses.json`. ADOMD and NativeInterop must be absent from the ZIP and listed as recipient-acquired prerequisites with exact official source, package/member hashes and visible terms. This avoids bundling them; it does not assert redistribution rights. |
| Ownership and terms | Obtain the appropriate authority to redistribute the project and select terms. No project license or ownership claim has been assigned. |
| Installation | Verify the extracted ZIP and actual official prerequisite downloads in a temporary recipient home without compilation, source restaging, extension reload or real-model access. Also check exact local-package installation, explicit download choice, tamper/missing-file failures and atomic cleanup. Preserve overwrite refusal, separate state and off-by-default grants. |
| Host and model compatibility | Record and check an approved recipient Copilot host/channel and canvas API. Synthetic browser/native checks do not establish live-host compatibility or real-model authentication. |
| Privacy and images | Review the exact ZIP and approved nine images. Keep only the selected VS Code image. Existing images are synthetic preview captures, not fresh captures of every subsequent binary. No additional images are generated during packaging. |
| Trust | Decide code/script signing and organizational delivery policy. The current pilot is unsigned. SHA-256 is integrity evidence, not publisher authentication; never recommend bypassing warnings. |
| Audience and publication | Explicitly decide whether the release is restricted to existing private-repository access or whether visibility/access should change. Upload only the exact reviewed files after approval. |
| Download verification | After an authorized upload, download the GitHub assets, compare the recorded hashes, and repeat recipient installation checks. A local ZIP is not evidence of a GitHub download. |

## Local package commands

`npm run package:review` builds an explicitly non-distributable review candidate,
records unresolved conditions, round-trips the ZIP, and checks the actual
extracted package. `npm run package:release` fails on missing notices or
unresolved dependency terms. Neither command uploads anything or certifies
redistribution rights.

The prior review ZIP passed a separate empty-home SDK runtime 1.0.99-2 check,
including canvas registration/open, Contoso builder context and disabled agent
execution. Repeat that contract check against the final ZIP and retain its exact
archive hash in `host-contract-verification.json`; do not reuse earlier evidence
as certification of a changed archive.

The fresh build includes the current synchronized builder guidance and Python
`--format table` exporter. Four fixed Contoso recipes provide invented retail
data for immediate exploration; unsupported DAX fails rather than returning
invented results. The README retains the nine approved inline images, MSOLAP
prerequisite and DAX Studio comparison.
