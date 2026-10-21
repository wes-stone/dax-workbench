import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filesUnder, writeEntry, inventory, privacyMarkers } from "./release/release-files.mjs";
import { bundleExcel } from "./release/bundle-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function stageInstall(destination, { assetsRoot = root, finalize = true } = {}) {
    const release = path.resolve(destination);
    await mkdir(release);
    const runtime = JSON.parse(await readFile(path.join(root, "runtime-files.json"), "utf8"));
    for (const name of runtime)
        await writeEntry(release, `payload/${name}`, await readFile(path.join(root, ...name.split("/"))));
    for (const [directory, allowed] of [
        ["dist", /\.(?:html|js|css|svg|woff2?|ttf|wasm)$/],
        ["native/publish", /\.(?:dll|exe|json|config)$/],
        ["engine/artifacts", /\.wasm$/],
    ]) {
        for (const name of await filesUnder(path.join(assetsRoot, ...directory.split("/")))) {
            if (!allowed.test(name)) continue;
            await writeEntry(release, `payload/${directory}/${name}`,
                await readFile(path.join(assetsRoot, ...directory.split("/"), ...name.split("/"))));
        }
    }
    for (const name of [
        "dist/index.html",
        "native/publish/DaxWorkbench.Host.exe",
        "native/publish/DaxWorkbench.Engine.exe",
        "native/publish/sqlite3.dll",
        "native/publish/windows-msolap/DaxWorkbench.WindowsMsolap.exe",
        "engine/artifacts/dax_workbench_core.wasm",
    ]) await readFile(path.join(release, "payload", ...name.split("/")));

    const yaml = JSON.parse(await readFile(path.join(root, "node_modules", "yaml", "package.json"), "utf8"));
    const dependencies = [
        ...["package.json", "LICENSE", ...(await filesUnder(path.join(root, "node_modules", "yaml", "dist")))
            .filter(name => name.endsWith(".js")).map(name => `dist/${name}`)].map(name => `yaml/${name}`),
        ...["package.json", "LICENSE"].map(name => `exceljs/${name}`),
    ];
    for (const name of dependencies)
        await writeEntry(release, `payload/node_modules/${name}`,
            await readFile(path.join(root, "node_modules", ...name.split("/"))));
    await bundleExcel(root, release);
    const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    await writeEntry(release, "payload/package.json", JSON.stringify({
        name: metadata.name, version: metadata.version, private: true, type: "module",
        engines: metadata.engines, dependencies: { yaml: yaml.version },
    }, null, 2) + "\n");
    for (const name of ["Install.ps1", "Install-MicrosoftPrerequisites.ps1"])
        await copyFile(path.join(root, "scripts", "release", name), path.join(release, name));
    if (finalize) {
        const files = await inventory(release, privacyMarkers(root));
        await writeEntry(release, "release-manifest.json", JSON.stringify({
            version: 1, profile: "generic", files,
            purpose: "Local installation from source; not a redistributable binary release.",
        }, null, 2) + "\n");
    }
    return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/stage-install.mjs <new-output-directory>");
    await stageInstall(process.argv[2]);
}
