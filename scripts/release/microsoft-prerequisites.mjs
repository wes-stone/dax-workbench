import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { checkedPath, filesUnder, sha256, writeEntry } from "./release-files.mjs";

// Pins verified against the original packages served by NuGet, not rebuilt DLLs.
export const microsoftPackages = [
    { name: "Microsoft.AnalysisServices.AdomdClient", version: "19.117.0", bytes: 5848428,
        sha256: "94b2455d57447c720e106c7d7d78e3d71ffdb6ad1f44226d5121f3ce9a70b569",
        licenseUrl: "https://go.microsoft.com/fwlink/?linkid=852895" },
    { name: "Microsoft.Identity.Client.NativeInterop", version: "0.20.4", bytes: 20196864,
        sha256: "5b89bba3da0ba3c934e8ef441053717c635668c887bcbc62187ef2612f696ec2",
        licenseUrl: "https://licenses.nuget.org/MIT" },
];

export async function separateMicrosoftPrerequisites({ release, assetsRoot, nugetRoot }) {
    const deps = JSON.parse(await readFile(path.join(assetsRoot, "native", "publish", "DaxWorkbench.Host.deps.json"), "utf8"));
    const target = deps.targets[deps.runtimeTarget.name];
    if (!target) throw new Error("Missing compiled native target.");
    const destinations = new Set(), packages = [];
    for (const pin of microsoftPackages) {
        const dependency = target[`${pin.name}/${pin.version}`];
        if (!dependency) throw new Error(`Pinned Microsoft prerequisite differs from compiled dependency: ${pin.name}`);
        const id = pin.name.toLowerCase(), filename = `${id}.${pin.version}.nupkg`;
        const archive = await readFile(path.join(nugetRoot, id, pin.version, filename));
        if (archive.length !== pin.bytes || sha256(archive) !== pin.sha256)
            throw new Error(`Microsoft prerequisite differs from official package pin: ${pin.name}`);
        const members = unzipSync(archive), files = [];
        for (const kind of ["runtime", "native", "resources"]) {
            for (const [member, metadata] of Object.entries(dependency[kind] ?? {})) {
                checkedPath(member);
                const relative = kind === "resources" ? `${metadata.locale}/${path.posix.basename(member)}` : path.posix.basename(member);
                const destination = checkedPath(`native/publish/${relative}`);
                if (!destination.endsWith(".dll") || destinations.has(destination.toLowerCase()))
                    throw new Error("Unexpected or colliding Microsoft prerequisite file.");
                destinations.add(destination.toLowerCase());
                const bytes = members[member];
                const staged = await readFile(path.join(release, "payload", ...destination.split("/")));
                if (!bytes || !Buffer.from(bytes).equals(staged))
                    throw new Error(`Published Microsoft file differs from original NuGet member: ${member}`);
                files.push({ member, path: destination, bytes: bytes.length, sha256: sha256(bytes) });
            }
        }
        if (!files.length) throw new Error(`No runtime files found for ${pin.name}`);
        packages.push({ ...pin, filename, url: `https://www.nuget.org/api/v2/package/${id}/${pin.version}`,
            packageUrl: `https://www.nuget.org/packages/${pin.name}/${pin.version}`,
            retainedPath: `prerequisites/${filename}`, files });
    }
    for (const pkg of packages) for (const file of pkg.files)
        await rm(path.join(release, "payload", ...file.path.split("/")));
    // Catch any additional copy, even if a build changed its location.
    const excludedHashes = new Set(packages.flatMap(pkg => [pkg.sha256, ...pkg.files.map(file => file.sha256)]));
    for (const name of await filesUnder(release))
        if (excludedHashes.has(sha256(await readFile(path.join(release, ...name.split("/"))))))
            throw new Error(`A Microsoft prerequisite is still included in the release: ${name}`);
    const result = { version: 1, acquisition: "recipient-direct-from-nuget", packages };
    await writeEntry(release, "payload/microsoft-prerequisites.json", JSON.stringify(result, null, 2) + "\n");
    return result;
}
