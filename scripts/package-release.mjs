import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, unzipSync } from "fflate";
import { stageInstall } from "./stage-install.mjs";
import { verifyInstallation } from "./test-source-install.mjs";
import { collectNotices, requireRedistributable } from "./release/dependency-notices.mjs";
import { separateMicrosoftPrerequisites } from "./release/microsoft-prerequisites.mjs";
import { checkedPath, filesUnder, inventory, privacyMarkers, runtimeSources, sha256, verifyEntries, writeEntry } from "./release/release-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--review-only") || args.length > 1)
    throw new Error("Usage: node scripts/package-release.mjs [--review-only]");
const reviewOnly = args.includes("--review-only");
const stage = await mkdtemp(path.join(root, ".release-build-"));
const assetsRoot = path.join(stage, "assets"), buildDirectory = path.join(stage, "build");
const json = value => JSON.stringify(value, null, 2) + "\n";
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const run = (program, args) => new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${path.basename(program)} exited ${code}.`)));
});
async function sourceIdentity() {
    const names = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort();
    const inputs = [];
    for (const name of new Set(names)) {
        checkedPath(name);
        const bytes = await readFile(path.join(root, ...name.split("/")));
        inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return { baseCommit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])),
        fingerprint: sha256(Buffer.from(json(inputs))), files: inputs.length };
}
let candidate;
try {
    const source = await sourceIdentity();
    const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (metadata.name !== "dax-copilot-workbench" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.version))
        throw new Error("Unexpected product metadata.");
    const runtime = new Set(JSON.parse(await readFile(path.join(root, "runtime-files.json"), "utf8")));
    for (const name of (await runtimeSources(root)).keys())
        if (!runtime.has(name)) throw new Error(`Runtime source is missing from the approved source manifest: ${name}`);
    await mkdir(buildDirectory);
    console.log("Building a fresh generic package. No installed extension or personal state is read.");
    await run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
    await run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build",
        "--outDir", path.join(assetsRoot, "dist")]);
    await run("powershell", ["-NoProfile", "-File", path.join(root, "scripts", "build-native.ps1"),
        "-OutputDirectory", path.join(assetsRoot, "native", "publish"),
        "-CoreDirectory", path.join(assetsRoot, "engine", "artifacts"),
        "-BuildDirectory", buildDirectory, "-NoRestore"]);
    const release = await stageInstall(path.join(stage, "release"), { assetsRoot, finalize: false });
    const nugetRoot = process.env.NUGET_PACKAGES ?? path.join(root, ".tools", "nuget-packages");
    const prerequisites = await separateMicrosoftPrerequisites({ release, assetsRoot, nugetRoot });
    const sysroot = execFileSync("rustc", ["--print", "sysroot"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    const notices = await collectNotices({ root, release, assetsRoot, buildDirectory,
        nugetRoot, prerequisites, rustLicenseRoot: path.join(sysroot, "share", "doc", "rust", "licenses") });
    if (!reviewOnly) requireRedistributable(notices.packages);
    for (const name of ["README.md", "RELEASE-NOTES.md"])
        await writeEntry(release, name, await readFile(path.join(root, "scripts", "release", name)));
    await writeEntry(release, "distribution-review.json", json({
        reviewOnly, redistributionApproved: false, blockers: notices.blockers,
        humanApprovalRequired: ["project redistribution terms", "exact archive privacy review",
            "release audience and visibility", "organizational software trust policy"],
    }));
    const markers = privacyMarkers(root);
    const manifest = { version: 1, productVersion: metadata.version, profile: "generic", reviewOnly,
        source, prerequisites: "payload/microsoft-prerequisites.json",
        createdAt: new Date().toISOString(), files: await inventory(release, markers) };
    await writeEntry(release, "release-manifest.json", json(manifest));
    const entries = Object.fromEntries(await Promise.all((await filesUnder(release)).map(async name =>
        [name, await readFile(path.join(release, ...name.split("/")))])));
    verifyEntries(entries, manifest, markers);
    const zipped = zipSync(entries, { level: 6 }), reopened = unzipSync(zipped);
    const audit = verifyEntries(reopened, JSON.parse(Buffer.from(reopened["release-manifest.json"])), markers);
    const extracted = path.join(stage, "extracted");
    for (const [name, bytes] of Object.entries(reopened)) await writeEntry(extracted, name, bytes);
    console.log("Checking the actual ZIP contents in a temporary recipient home.");
    const verification = await verifyInstallation(extracted, { reviewOnly });
    if (JSON.stringify(source) !== JSON.stringify(await sourceIdentity()))
        throw new Error("Source changed while packaging; rebuild before recording an immutable candidate.");
    const tag = `dax-workbench-${metadata.version}-${reviewOnly ? "review" : "candidate"}-${new Date().toISOString().replace(/[-:.]/g, "")}`;
    const parent = path.join(root, "release-candidates");
    await mkdir(parent, { recursive: true });
    candidate = path.join(parent, tag);
    await mkdir(candidate);
    const archive = `${tag}-win-x64.zip`;
    await writeEntry(candidate, archive, zipped);
    await writeEntry(candidate, "SHA256SUMS.txt", `${sha256(zipped)}  ${archive}\n`);
    await writeEntry(candidate, "release-manifest.json", json(manifest));
    const report = { version: 1, passed: true, reviewOnly, published: false, redistributionApproved: false,
        source, archive, sha256: sha256(zipped), archiveBytes: zipped.length, ...audit, verification,
        dependencyRecords: notices.packages.length, externalPrerequisiteRecords: notices.externallyAcquired.length,
        redistributionBlockers: notices.blockers };
    await writeEntry(candidate, "verification.json", json(report));
    await writeEntry(candidate, "third-party-licenses.json", json(notices));
    console.log(json({ directory: candidate, ...report }));
} catch (error) {
    console.error(`No approved release was produced: ${error.message}`);
    if (candidate) console.error("A partial candidate directory exists; do not distribute it.");
    process.exitCode = 1;
} finally {
    await rm(stage, { recursive: true, force: true });
}
