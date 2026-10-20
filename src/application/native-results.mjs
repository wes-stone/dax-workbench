import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "./policy.mjs";

export class NativeResults {
    constructor({ native, id, artifactsRoot }) {
        this.native = native; this.id = id; this.artifactsRoot = artifactsRoot;
        this.nativeCache = true;
    }
    request(method, params = {}) {
        return this.native.request(`results.${method}`, { ...params, workbenchId: this.id }, 60_000);
    }
    beginSet() {}
    append() {
        throw fail("RESULT_PROTOCOL_MISMATCH", "The result engine sent uncached rows. Reinstall matching native and canvas components.");
    }
    page(run, set, offset, limit) { return this.request("page", { runId: run.id, resultSetId: set.id, offset, limit }); }
    restore(run) { return this.request("restore", { runId: run.id, sets: run.resultSets }); }
    pin(run) { return this.request("pin", { runId: run.id, sets: run.resultSets }); }
    async compare(left, right) {
        const result = await this.request("compare", {
            left: { runId: left.id, sets: left.resultSets }, right: { runId: right.id, sets: right.resultSets },
        });
        return result.equal;
    }
    async select(cells) { return (await this.request("select", { cells })).values; }
    trim(keep) { return this.request("trim", { keep }); }
    async export(run, set, format, { stream = false } = {}) {
        const output = await this.request("export", {
            runId: run.id, resultSetId: set.id, format,
            metadata: { runId: run.id, connectionKind: run.connectionKind, query: run.query, status: run.status,
                truncated: run.truncated, warnings: run.warnings, columns: set.columns },
        });
        const directory = path.resolve(this.artifactsRoot, "exports", this.id);
        if (typeof output.file !== "string" || path.dirname(path.resolve(output.file)) !== directory
            || !["application/json; charset=utf-8", "text/csv; charset=utf-8"].includes(output.contentType)) {
            throw fail("RESULT_PROTOCOL_MISMATCH", "The result engine returned an invalid export destination.");
        }
        const cleanup = () => this.request("export.release", { ticket: output.ticket });
        if (stream) return { contentType: output.contentType, file: output.file, cleanup };
        try { return { contentType: output.contentType, content: await readFile(output.file, "utf8") }; }
        finally { await cleanup(); }
    }
}
