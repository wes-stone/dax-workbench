import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { checkedPath, filesUnder, noticeFiles, sha256, writeEntry } from "./release-files.mjs";

const json = async file => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const key = ({ ecosystem, name, version }) => `${ecosystem}/${name}/${version}`;
const noticePrefix = (ecosystem, name, version) =>
    `payload/notices/${ecosystem}/${sha256(Buffer.from(key({ ecosystem, name, version }))).slice(0, 16)}`;

export async function readVendorEvidence(directory) {
    const records = await json(path.join(directory, "provenance.json"));
    const identities = new Set();
    for (const record of records) {
        if (!["npm", "nuget"].includes(record.ecosystem) || !record.name || !record.version
            || identities.has(key(record)) || !Array.isArray(record.sources) || !record.sources.length)
            throw new Error("Invalid or duplicate vendor provenance.");
        identities.add(key(record));
        for (const source of record.sources) {
            checkedPath(source.file);
            if (!/^https:\/\//.test(source.url) || !/^[a-f0-9]{64}$/.test(source.sha256)
                || sha256(await readFile(path.join(directory, ...source.file.split("/")))) !== source.sha256)
                throw new Error(`Vendor notice integrity failed: ${key(record)}`);
        }
    }
    return records;
}

export function releaseBlockers(packages) {
    return packages.flatMap(item => [
        ...(!item.notices.length ? [`${key(item)}: original license/notice text is missing.`] : []),
        ...(item.review ? [`${key(item)}: ${item.review}`] : []),
    ]);
}

export function requireRedistributable(packages) {
    const blockers = releaseBlockers(packages);
    if (blockers.length) throw new Error(`Redistribution gate failed:\n${blockers.join("\n")}`);
}

export async function collectNotices({ root, release, assetsRoot, buildDirectory, nugetRoot, rustLicenseRoot, prerequisites }) {
    const vendorRoot = path.join(root, "scripts", "release", "vendor-notices");
    const evidence = await readVendorEvidence(vendorRoot);
    const records = new Map();
    const externallyAcquired = [];
    async function add(ecosystem, name, version, directory, declaration, origin, usage) {
        const id = key({ ecosystem, name, version });
        if (records.has(id)) {
            const existing = records.get(id);
            if (!existing.usages.includes(usage)) existing.usages.push(usage);
            return;
        }
        const prefix = noticePrefix(ecosystem, name, version);
        const notices = [];
        for (const file of await noticeFiles(directory)) {
            const bytes = await readFile(path.join(directory, file));
            const output = `${prefix}/${file}`;
            await writeEntry(release, output, bytes);
            notices.push({ path: output.slice(8), sha256: sha256(bytes), source: "Supplied with the exact dependency." });
        }
        const vendor = evidence.find(item => key(item) === id);
        for (const [index, source] of (vendor?.sources ?? []).entries()) {
            const bytes = await readFile(path.join(vendorRoot, source.file));
            const output = `${prefix}/upstream-${index}${path.extname(source.file) || ".txt"}`;
            await writeEntry(release, output, bytes);
            notices.push({ path: output.slice(8), ...source, file: undefined });
        }
        records.set(id, { ecosystem, name, version, declaration: declaration ?? null, origin,
            usages: [usage], notices, ...(vendor?.review ? { review: vendor.review } : {}) });
    }

    const lock = await json(path.join(root, "package-lock.json"));
    const frontend = await json(path.join(assetsRoot, "dist", "build-dependencies.json"));
    const runtime = await json(path.join(release, "runtime-dependencies.json"));
    const npmLocations = new Map([["node_modules/yaml", new Set(["runtime"])]]);
    for (const [inputs, usage] of [[frontend.inputs, "frontend"], [runtime.inputs, "runtime-workbook"]]) {
        for (const input of inputs) {
            checkedPath(input);
            let location = path.posix.dirname(input);
            while (location !== "." && !lock.packages[location]) location = path.posix.dirname(location);
            if (!location.startsWith("node_modules/") || !lock.packages[location]?.version)
                throw new Error(`Untraceable bundled dependency: ${input}`);
            if (!npmLocations.has(location)) npmLocations.set(location, new Set());
            npmLocations.get(location).add(usage);
        }
    }
    for (const [location, usages] of [...npmLocations].sort()) {
        const directory = path.join(root, ...location.split("/"));
        const pkg = await json(path.join(directory, "package.json")), entry = lock.packages[location];
        if (pkg.version !== entry.version) throw new Error(`Installed dependency differs from lock: ${location}`);
        for (const usage of usages)
            await add("npm", pkg.name, pkg.version, directory, pkg.license,
                { lockPath: location, integrity: entry.integrity, resolved: entry.resolved }, usage);
    }

    const deps = await json(path.join(assetsRoot, "native", "publish", "DaxWorkbench.Host.deps.json"));
    for (const [id, dependency] of Object.entries(deps.libraries)) {
        if (!["package", "runtimepack"].includes(dependency.type)) continue;
        const [rawName, version] = id.split("/"), name = rawName.replace(/^runtimepack\./, "");
        const directory = path.join(nugetRoot, name.toLowerCase(), version);
        const nuspec = await readFile(path.join(directory, `${name.toLowerCase()}.nuspec`), "utf8");
        const declaration = nuspec.match(/<license\b[^>]*>([^<]+)<\/license>/)?.[1]
            ?? nuspec.match(/<licenseUrl>([^<]+)<\/licenseUrl>/)?.[1];
        const packageHash = (await readFile(path.join(directory, `${name.toLowerCase()}.${version}.nupkg.sha512`), "utf8")).trim();
        const restored = await json(path.join(directory, ".nupkg.metadata"));
        const archiveHash = createHash("sha512").update(await readFile(path.join(directory,
            `${name.toLowerCase()}.${version}.nupkg`))).digest("base64");
        if (packageHash !== archiveHash || dependency.sha512 && dependency.sha512 !== `sha512-${restored.contentHash}`)
            throw new Error(`Restored NuGet package differs from compiled dependency: ${name}`);
        const external = prerequisites?.packages.find(pkg => pkg.name === name && pkg.version === version);
        if (external) {
            for (const file of external.files)
                if ((await filesUnder(release)).includes(`payload/${file.path}`))
                    throw new Error(`Externally acquired dependency remains bundled: ${file.path}`);
            externallyAcquired.push({ ecosystem: "nuget", name, version, declaration,
                acquisition: "recipient-direct-from-nuget", includedInArchive: false,
                packageUrl: external.packageUrl, licenseUrl: external.licenseUrl, archiveSha256: external.sha256,
                review: "Recipient obtains the original package under Microsoft's terms. No redistribution rights are asserted." });
            continue;
        }
        await add("nuget", name, version, directory, declaration,
            { packageUrl: `https://www.nuget.org/packages/${name}/${version}`,
                contentHash: restored.contentHash, archiveSha512: archiveHash }, "native-win-x64");
    }
    const cargoChecksums = new Map();
    for (const block of (await readFile(path.join(root, "Cargo.lock"), "utf8")).split(/\r?\n\[\[package\]\]\r?\n/)) {
        const name = block.match(/^name = "([^"]+)"\r?$/m)?.[1];
        const version = block.match(/^version = "([^"]+)"\r?$/m)?.[1];
        const checksum = block.match(/^checksum = "([a-f0-9]{64})"\r?$/m)?.[1];
        if (name && version && checksum) cargoChecksums.set(`${name}/${version}`, checksum);
    }
    for (const platform of ["x86_64-pc-windows-gnu", "wasm32-unknown-unknown"]) {
        const graph = await json(path.join(buildDirectory, `rust-${platform}.json`));
        const packages = new Map(graph.packages.map(pkg => [pkg.id, pkg]));
        const nodes = new Map(graph.resolve.nodes.map(node => [node.id, node]));
        const entryName = platform.startsWith("wasm") ? "dax-workbench-core" : "dax-workbench-engine";
        const entry = graph.packages.find(pkg => pkg.name === entryName && !pkg.source);
        if (!entry) throw new Error("Missing Rust workspace entry in dependency graph.");
        const visited = new Set();
        async function visit(id) {
            if (visited.has(id)) return;
            visited.add(id);
            const pkg = packages.get(id), node = nodes.get(id);
            if (!pkg || !node) throw new Error("Incomplete Rust dependency graph.");
            if (pkg.source) {
                if (!pkg.source.startsWith("registry+")) throw new Error("Non-registry Rust dependency requires explicit provenance.");
                const directory = path.dirname(pkg.manifest_path);
                const checksum = cargoChecksums.get(`${pkg.name}/${pkg.version}`);
                const registry = path.dirname(directory);
                const archive = path.join(registry, "..", "..", "cache", path.basename(registry), `${pkg.name}-${pkg.version}.crate`);
                if (!checksum || sha256(await readFile(archive)) !== checksum)
                    throw new Error(`Rust registry archive differs from lock: ${pkg.name}/${pkg.version}`);
                await add("cargo", pkg.name, pkg.version, directory, pkg.license,
                    { registry: pkg.source, checksum }, `target-graph:${platform} (includes build dependencies)`);
            }
            for (const dependency of node.deps)
                if (dependency.dep_kinds.some(kind => kind.kind !== "dev")) await visit(dependency.pkg);
        }
        await visit(entry.id);
    }
    // Rust's standard library is linked into both native and WASM outputs.
    await add("toolchain", "rust-standard-library", "1.98.1", rustLicenseRoot, "MIT OR Apache-2.0",
        { source: "https://github.com/rust-lang/rust/tree/1.98.1" }, "native-and-wasm");
    const standard = records.get("toolchain/rust-standard-library/1.98.1");
    for (const file of [...(await filesUnder(rustLicenseRoot)).map(name => `licenses/${name}`),
        "COPYRIGHT-library.html"]) {
        const bytes = await readFile(path.join(path.dirname(rustLicenseRoot), ...file.split("/")));
        const output = `${noticePrefix("toolchain", "rust-standard-library", "1.98.1")}/${file}`;
        await writeEntry(release, output, bytes);
        standard.notices.push({ path: output.slice(8), sha256: sha256(bytes), source: "Pinned Rust toolchain distribution." });
    }
    const packages = [...records.values()].sort((a, b) => key(a).localeCompare(key(b)));
    if (prerequisites && externallyAcquired.length !== prerequisites.packages.length)
        throw new Error("External prerequisite inventory differs from compiled dependencies.");
    const report = { version: 1, scope: "Actual frontend/runtime input graph, compiled NuGet dependencies, target-filtered Cargo graph and linked Rust standard library. Cargo records conservatively include build dependencies. Recipient-acquired packages are listed separately and are not in this archive.",
        redistributionApproved: false, packages, externallyAcquired, blockers: releaseBlockers(packages) };
    await writeEntry(release, "payload/third-party-licenses.json", JSON.stringify(report, null, 2) + "\n");
    return report;
}
