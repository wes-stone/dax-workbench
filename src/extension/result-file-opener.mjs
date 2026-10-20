import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fail, requireId, safeError } from "../application/policy.mjs";
import { launchExcel } from "./excel-launcher.mjs";

const opening = new WeakSet();

export async function openResultInExcel(workbench, payload, launch = launchExcel) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some(key => !["runId", "resultSetId", "format"].includes(key))
        || !["xlsx", "csv"].includes(payload.format))
        throw fail("INVALID_EXPORT", "Choose a captured result and XLSX or CSV. File paths and uploaded content are not accepted.");
    const { runId, resultSetId, format } = payload;
    requireId(runId); requireId(resultSetId);
    if (workbench.closed) throw fail("WORKBENCH_CLOSED", "Reopen DAX Workbench before exporting.");
    if (opening.has(workbench)) throw fail("EXPORT_BUSY", "Wait for the current Excel export to finish before opening another.");
    opening.add(workbench);
    try {
        const output = await workbench.exportResult(runId, resultSetId, format, { stream: true });
        let file;
        try {
            const directory = path.resolve(workbench.artifactsRoot, "exported-files", requireId(workbench.id));
            await mkdir(directory, { recursive: true });
            const root = await realpath(workbench.artifactsRoot), actual = await realpath(directory);
            const relative = path.relative(root, actual);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw fail("INVALID_EXPORT", "The local export folder points outside Workbench storage.");
            file = path.join(actual, `dax-${randomUUID()}.${format}`);
            if (output.file) await copyFile(output.file, file, constants.COPYFILE_EXCL);
            else await writeFile(file, output.content, { flag: "wx", mode: 0o600 });
        } finally { await output.cleanup?.(); }
        try {
            if (workbench.closed) throw fail("WORKBENCH_CLOSED", "The workbench closed before Excel could be opened.");
            await launch(file);
        } catch (error) {
            const failure = safeError(error);
            throw fail(failure.code, `The ${format.toUpperCase()} export was saved to ${file}, but Excel did not launch. ${failure.message}`);
        }
        return { status: "opening", filePath: file, format, rowCount: output.rowCount, partial: output.partial,
            ...(format === "xlsx" ? { preservedNumbers: output.preservedNumbers } : {}) };
    } finally { opening.delete(workbench); }
}
