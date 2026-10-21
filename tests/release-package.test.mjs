import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedPath, sha256, verifyEntries, writeEntry } from "../scripts/release/release-files.mjs";
import { readVendorEvidence, releaseBlockers, requireRedistributable } from "../scripts/release/dependency-notices.mjs";
import { zipSync } from "fflate";
import { microsoftPackages, separateMicrosoftPrerequisites } from "../scripts/release/microsoft-prerequisites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = value => JSON.stringify(value, null, 2) + "\n";
function manifestFor(entries, extra = {}) {
    return { version: 1, profile: "generic", ...extra,
        files: Object.entries(entries).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) })) };
}

test("portable release paths reject traversal, Windows aliases and device names", () => {
    for (const name of ["../x", "/x", "a//b", "a\\b", "C:x", "a/.", "a/..", "a/nul.txt",
        "a/COM1", "a/x.", "a/x ", "a/x:y", "a/x?y", "a/x*y", "a/\u007f"])
        assert.throws(() => checkedPath(name), /safe/);
    assert.equal(checkedPath("payload/native/windows-msolap/client.dll"), "payload/native/windows-msolap/client.dll");
});

test("prerequisites remain external and mismatched compiled versions fail closed", async () => {
const temp = await mkdtemp(path.join(tmpdir(), "dax-prerequisite-build-"));
try {
    await writeEntry(temp, "native/publish/DaxWorkbench.Host.deps.json", json({
        runtimeTarget: { name: "fixture" }, targets: { fixture: {} },
    }));
    await assert.rejects(separateMicrosoftPrerequisites({ release: temp, assetsRoot: temp, nugetRoot: temp }),
        /differs from compiled/);
} finally { await rm(temp, { recursive: true, force: true }); }
});

test("Microsoft prerequisite installation is explicit, hash-pinned and atomic",
{ skip: process.platform !== "win32", timeout: 120000 }, async t => {
    const temp = await mkdtemp(path.join(tmpdir(), "dax-prerequisites-test-"));
    try {
        const scripts = Object.fromEntries(await Promise.all(["Install.ps1", "Install-MicrosoftPrerequisites.ps1"]
            .map(async name => [name, await readFile(path.join(root, "scripts", "release", name))])));
        async function scenario(name, mutate = () => {}, options = {}) {
            const directory = path.join(temp, name), cache = path.join(temp, `${name}-cache`);
            const packages = microsoftPackages.map((pin, index) => {
                const id = pin.name.toLowerCase(), filename = `${id}.${pin.version}.nupkg`;
                const bytes = Buffer.from(`Synthetic DLL fixture ${index}; never executed.`);
                const member = `lib/net8.0/fixture-${index}.dll`;
                const archive = Buffer.from(zipSync({ [member]: bytes }));
                return { archive, descriptor: { ...pin, filename, bytes: archive.length, sha256: sha256(archive),
                    url: `https://www.nuget.org/api/v2/package/${id}/${pin.version}`,
                    retainedPath: `prerequisites/${filename}`,
                    files: [{ member, path: `native/publish/fixture-${index}.dll`, bytes: bytes.length, sha256: sha256(bytes) }] } };
            });
            const spec = { version: 1, acquisition: "recipient-direct-from-nuget",
                packages: packages.map(pkg => pkg.descriptor) };
            const entries = { ...scripts, "payload/extension.mjs": Buffer.from("export {};") };
            mutate(spec, packages, entries);
            entries["payload/microsoft-prerequisites.json"] = Buffer.from(json(spec));
            const manifest = manifestFor(entries, { prerequisites: "payload/microsoft-prerequisites.json" });
            for (const [name, bytes] of Object.entries(entries)) await writeEntry(directory, name, bytes);
            await writeEntry(directory, "release-manifest.json", json(manifest));
            for (const pkg of packages) await writeEntry(cache, pkg.descriptor.filename, pkg.archive);
            const home = path.join(temp, `${name}-home`);
            const args = ["-NoProfile", "-File", path.join(directory, "Install.ps1"), "-CopilotHome", home];
            if (!options.noConsent) args.push("-PrerequisiteDirectory", cache);
            if (options.alsoDownload) args.push("-DownloadMicrosoftPrerequisites");
            const result = spawnSync("powershell", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
            return { home, spec, result };
        }
        await t.test("no download or installation without explicit choice", async () => {
            const { home, result } = await scenario("no-consent", undefined, { noConsent: true });
            assert.notEqual(result.status, 0);
            assert.match(result.stdout, /review Microsoft terms/);
            assert.match(result.stderr, /Nothing was installed or downloaded/);
            await assert.rejects(readdir(home), { code: "ENOENT" });
        });
        await t.test("original packages retained with exact installed members", async () => {
            const { home, spec, result } = await scenario("success");
            assert.equal(result.status, 0, result.stderr);
            for (const pkg of spec.packages) {
                const base = path.join(home, "extensions", "dax-copilot-workbench");
                assert.equal(sha256(await readFile(path.join(base, pkg.retainedPath))), pkg.sha256);
                for (const file of pkg.files)
                    assert.equal(sha256(await readFile(path.join(base, file.path))), file.sha256);
            }
        });
        for (const [name, mutate, pattern, options] of [
            ["ambiguous-source", () => {}, /not both/, { alsoDownload: true }],
            ["wrong-url", spec => { spec.packages[0].url = "https://example.invalid/package"; }, /source/],
            ["path-traversal", spec => { spec.packages[0].files[0].path = "native/publish/../../escape.dll"; }, /Unsafe/],
            ["member-traversal", spec => { spec.packages[0].files[0].member = "../escape.dll"; }, /Unsafe/],
            ["file-collision", spec => { spec.packages[1].files[0].path = spec.packages[0].files[0].path.toUpperCase(); }, /colliding|Unexpected/],
            ["base-collision", (spec, _packages, entries) => { entries[`payload/${spec.packages[0].files[0].path}`] = Buffer.from("existing"); }, /colliding/],
            ["package-tamper", (_spec, packages) => { packages[0].archive = Buffer.from("tampered"); }, /package integrity/],
            ["member-tamper", spec => { spec.packages[0].files[0].sha256 = "0".repeat(64); }, /member integrity/],
            ["missing-member", spec => { spec.packages[0].files[0].member = "lib/net8.0/missing.dll"; }, /Missing or invalid/],
            ["invalid-size", spec => { spec.packages[0].bytes = -1; }, /metadata/],
            ["missing-package", (_spec, packages) => { packages.splice(0, 1); }, /Missing prerequisite package/],
        ]) await t.test(name, async () => {
            const { home, result } = await scenario(name, mutate, options);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, pattern);
            await assert.rejects(readdir(path.join(home, "extensions", "dax-copilot-workbench")), { code: "ENOENT" });
            const children = await readdir(home).catch(error => {
                if (error.code === "ENOENT") return [];
                throw error;
            });
            assert(!children.some(child => child.startsWith(".dax-install-stage-")), "Failed installation must remove its owned staging.");
        });
    } finally { await rm(temp, { recursive: true, force: true }); }
});

test("manifest verification rejects tamper, missing, extra and case-colliding files", () => {
    const payload = { "payload/extension.mjs": Buffer.from("export {};") };
    const manifest = manifestFor(payload);
    const entries = { ...payload, "release-manifest.json": Buffer.from(json(manifest)) };
    assert.equal(verifyEntries(entries, manifest, []).files, 1);
    assert.throws(() => verifyEntries({ ...entries, "payload/extension.mjs": Buffer.from("tampered") }, manifest, []), /integrity/);
    assert.throws(() => verifyEntries({ ...entries, "extra.txt": Buffer.from("") }, manifest, []), /count/);
    assert.throws(() => verifyEntries({ "release-manifest.json": entries["release-manifest.json"] }, manifest, []), /count/);
    assert.throws(() => verifyEntries(entries, { ...manifest, files: [...manifest.files,
        { ...manifest.files[0], path: "PAYLOAD/extension.mjs" }] }, []), /Duplicate/);
    assert.throws(() => verifyEntries(entries, { ...manifest, files: [{ ...manifest.files[0], bytes: -1 }] }, []), /metadata/);
    assert.throws(() => verifyEntries(entries, manifest, [["test-marker", "export"]]), /blocked/);
});

test("strict distribution gate never substitutes declarations for original notices or approval", () => {
    const pkg = { ecosystem: "nuget", name: "Synthetic.Library", version: "1.0.0", declaration: "MIT", notices: [] };
    assert.equal(releaseBlockers([pkg]).length, 1);
    assert.throws(() => requireRedistributable([pkg]), /original license/);
    assert.throws(() => requireRedistributable([{ ...pkg, notices: ["original.txt"], review: "Conditional rights unresolved" }]), /Conditional rights/);
    assert.doesNotThrow(() => requireRedistributable([{ ...pkg, notices: ["original.txt"] }]));
});

test("pinned vendor evidence verifies original bytes and exact package identities", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "dax-notice-test-"));
    try {
        const bytes = Buffer.from("Synthetic evidence fixture, not a license.");
        const evidence = [{ ecosystem: "npm", name: "fixture", version: "1.0.0",
            sources: [{ file: "notice.txt", sha256: sha256(bytes), url: "https://example.invalid/pinned/notice.txt" }] }];
        await writeEntry(temp, "notice.txt", bytes);
        await writeEntry(temp, "provenance.json", json(evidence));
        assert.equal((await readVendorEvidence(temp))[0].version, "1.0.0");
        await writeFile(path.join(temp, "notice.txt"), "changed");
        await assert.rejects(readVendorEvidence(temp), /integrity/);
    } finally { await rm(temp, { recursive: true, force: true }); }
});

test("all checked-in pinned vendor notices retain their recorded hashes", async () => {
    const records = await readVendorEvidence(path.join(root, "scripts", "release", "vendor-notices"));
    assert(records.length >= 16);
    assert.match(records.find(item => item.name === "Microsoft.AnalysisServices.AdomdClient").review, /REDIST|redistributable/i);
});

test("recipient installer validates the whole package and refuses destructive or unapproved installation",
    { skip: process.platform !== "win32", timeout: 120000 }, async t => {
        const temp = await mkdtemp(path.join(tmpdir(), "dax-installer-test-"));
        try {
            const installer = await readFile(path.join(root, "scripts", "release", "Install.ps1"));
            const base = { "Install.ps1": installer, "README.md": Buffer.from("Synthetic package."),
                "payload/extension.mjs": Buffer.from("export {};") };
            async function scenario(name, change, args = []) {
                const directory = path.join(temp, name), entries = { ...base };
                const manifest = manifestFor(entries);
                change?.(entries, manifest);
                for (const [name, bytes] of Object.entries(entries)) await writeEntry(directory, name, bytes);
                await writeEntry(directory, "release-manifest.json", json(manifest));
                const home = path.join(temp, `${name}-home`);
                const install = () => spawnSync("powershell", ["-NoProfile", "-File", path.join(directory, "Install.ps1"),
                    "-CopilotHome", home, ...args], { encoding: "utf8", windowsHide: true, timeout: 20000 });
                return { directory, home, install, result: install() };
            }
            await t.test("fresh install then overwrite refusal preserves installed bytes", async () => {
                const run = await scenario("fresh");
                assert.equal(run.result.status, 0, run.result.stderr);
                assert.notEqual(run.install().status, 0);
                assert.equal(await readFile(path.join(run.home, "extensions", "dax-copilot-workbench", "extension.mjs"), "utf8"), "export {};");
            });
            for (const [name, mutate, pattern] of [
                ["payload-tamper", entries => { entries["payload/extension.mjs"] = Buffer.from("changed"); }, /integrity/],
                ["top-level-tamper", entries => { entries["README.md"] = Buffer.from("changed"); }, /integrity/],
                ["extra", entries => { entries["unexpected.txt"] = Buffer.from("extra"); }, /Unexpected/],
                ["traversal", (_entries, manifest) => { manifest.files[2].path = "payload/../escape.mjs"; }, /Unsafe/],
                ["duplicate-case", (_entries, manifest) => { manifest.files.push({ ...manifest.files[0], path: "INSTALL.ps1" }); }, /duplicate/],
                ["review", (_entries, manifest) => { manifest.reviewOnly = true; }, /local review package/],
            ]) await t.test(name, async () => {
                const run = await scenario(name, mutate);
                assert.notEqual(run.result.status, 0);
                assert.match(run.result.stderr, pattern);
            });
            await t.test("explicit local-review flag is separate from distribution approval", async () => {
                const run = await scenario("explicit-review", (_entries, manifest) => { manifest.reviewOnly = true; }, ["-AllowReviewPackage"]);
                assert.equal(run.result.status, 0, run.result.stderr);
            });
        } finally { await rm(temp, { recursive: true, force: true }); }
    });
