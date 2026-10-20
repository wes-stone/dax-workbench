import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fail } from "../application/policy.mjs";

export async function safeProjectDirectory(directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > 2048)
        throw fail("PROJECT_PATH", "Choose an absolute local folder path.");
    const resolved = path.resolve(directory);
    if (process.platform === "win32" && (resolved.startsWith("\\\\") || resolved.slice(3).includes(":")))
        throw fail("PROJECT_PATH", "Choose a local folder without alternate data streams.");
    let current = path.parse(resolved).root;
    for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
        if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
            throw fail("PROJECT_PATH", "Reserved or redirected paths cannot contain managed projects.");
        current = path.join(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw fail("PROJECT_PATH", "Project folders cannot contain symlinks or junctions.");
    }
    if (path.relative(path.resolve(await realpath(resolved)), resolved)) throw fail("PROJECT_PATH", "The project folder resolves to a different location.");
    return resolved;
}
