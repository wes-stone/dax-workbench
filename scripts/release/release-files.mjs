import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const slash = value => value.split(path.sep).join("/");
export const profileReplacements = new Map();
const privateSource = /^(?:src\/application\/(?:starter-queries|model-context)\/|tests\/|scripts\/|artifacts\/)/;
const externalModules = new Set(["yaml", "@github/copilot-sdk/extension", "exceljs/dist/exceljs.min.js"]);
export function checkedPath(name) {
    if (typeof name !== "string" || !name || name.includes("\\") || name.includes(":") || /[\x00-\x1f\x7f]/.test(name)
        || name.split("/").some(part => !part || part === "." || part === ".."
            || /[<>|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
        throw new Error("Release entries must be safe, relative, slash-separated paths.");
    return name;
}
export async function filesUnder(root, prefix = "") {
    const result = [];
    for (const entry of await readdir(path.join(root, ...prefix.split("/")), { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        const info = await lstat(path.join(root, ...name.split("/")));
        if (info.isSymbolicLink()) throw new Error(`Linked release input is not allowed: ${name}`);
        if (info.isDirectory()) result.push(...await filesUnder(root, name));
        else if (info.isFile()) result.push(checkedPath(name));
        else throw new Error(`Unsupported release input: ${name}`);
    }
    return result.sort();
}
export async function writeEntry(root, name, bytes) {
    const file = path.join(root, ...checkedPath(name).split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx" });
}
export async function noticeFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (/^(?:licen[cs]e|notice|third[-_]?party|copying)/i.test(entry.name)
            && (/\.(?:txt|md|markdown|html|rtf|rst)$/i.test(entry.name) || !entry.name.includes("."))) {
            files.push(entry.name);
        } else if (/^readme(?:\.(?:md|markdown|txt))?$/i.test(entry.name)) {
            const text = await readFile(path.join(directory, entry.name), "utf8");
            if (/copyright/i.test(text) && /permission is hereby granted/i.test(text) && /THE SOFTWARE IS PROVIDED/i.test(text))
                files.push(entry.name);
        }
    }
    return files.sort();
}
export async function runtimeSources(root) {
    const sources = new Map();
    async function visit(name) {
        checkedPath(name);
        if (sources.has(name)) return;
        if (privateSource.test(name)) throw new Error(`A private or development module is reachable from the release: ${name}`);
        const input = profileReplacements.get(name) ?? name;
        const file = path.join(root, ...input.split("/"));
        if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error(`Runtime input must be a regular file: ${name}`);
        const code = await readFile(file, "utf8");
        sources.set(name, code);
        const syntax = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const imports = [];
        function walk(node) {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.push(node.moduleSpecifier);
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error(`Nonliteral runtime import requires release review: ${name}`);
                imports.push(node.arguments[0]);
            }
            ts.forEachChild(node, walk);
        }
        walk(syntax);
        for (const specifier of imports) {
            if (!ts.isStringLiteral(specifier)) throw new Error(`Unsupported runtime import: ${name}`);
            const value = specifier.text;
            if (value.startsWith(".")) {
                const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), value));
                if (!target.endsWith(".mjs")) throw new Error(`Review the runtime resource import in ${name}`);
                await visit(target);
            } else if (!value.startsWith("node:") && !externalModules.has(value))
                throw new Error(`Unapproved external runtime module in ${name}: ${value}`);
        }
    }
    await visit("extension.mjs");
    return sources;
}
export function privacyMarkers(root) {
    return [["local-user", userInfo().username], ["local-home", homedir()], ["source-directory", root]]
        .filter(([, value]) => value.length >= 4);
}
export function auditEntry(name, bytes, markers) {
    checkedPath(name);
    if (/\.(?:pdb|map|log|db|sqlite\d*|db-shm|db-wal|xlsx|csv|parquet|dax|pyc|dmp|bak|zip)$/i.test(name)
        || /(?:^|\/)(?:\.git|\.copilot|__pycache__|tests|test-results|playwright-report|screenshots|query-packs)(?:\/|$)/i.test(name)
        || /(?:^|\/)artifacts(?:\/|$)/i.test(name) && name !== "payload/engine/artifacts/dax_workbench_core.wasm"
        || /src\/application\/(?:starter-queries|model-context)\//.test(name))
        throw new Error(`Excluded data/development path in release: ${name}`);
    const text = bytes.toString("latin1").toLowerCase();
    const categories = new Set();
    for (const [category, value] of markers)
        if (["utf8", "utf16le"].some(encoding => text.includes(Buffer.from(value, encoding).toString("latin1").toLowerCase())))
            categories.add(category);
    if (/(?:gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{40,}|bearer\s+eyj[a-z0-9_.-]{40,}|-----begin (?:rsa |ec |openssh )?private key-----[\r\n]+[a-z0-9+/=\r\n]{80,})/i.test(text))
        categories.add("credential-pattern");
    if (categories.size) throw new Error(`Release content blocked: ${name} [${[...categories].join(", ")}]. Matched values are not printed.`);
}
export async function inventory(root, markers) {
    const files = [];
    for (const name of await filesUnder(root)) {
        const bytes = await readFile(path.join(root, ...name.split("/")));
        auditEntry(name, bytes, markers);
        files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return files;
}
export function verifyEntries(entries, manifest, markers) {
    if (manifest.version !== 1 || manifest.profile !== "generic" || !Array.isArray(manifest.files))
        throw new Error("Invalid release manifest.");
    const expected = new Map(manifest.files.map(file => [checkedPath(file.path), file]));
    if (new Set([...expected.keys()].map(name => name.toLowerCase())).size !== manifest.files.length
        || [...expected.keys()].some(name => name.toLowerCase() === "release-manifest.json"))
        throw new Error("Duplicate or self-referencing release manifest entries.");
    for (const file of expected.values())
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
            throw new Error("Invalid release file metadata.");
    const actual = Object.keys(entries).filter(name => name !== "release-manifest.json");
    if (actual.length !== expected.size) throw new Error("Release file count differs from the manifest.");
    for (const name of actual) {
        const bytes = Buffer.from(entries[name]), file = expected.get(name);
        if (!file || file.bytes !== bytes.length || file.sha256 !== sha256(bytes)) throw new Error(`Release integrity mismatch: ${name}`);
        auditEntry(name, bytes, markers);
    }
    auditEntry("release-manifest.json", Buffer.from(entries["release-manifest.json"]), markers);
    return { files: actual.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}
