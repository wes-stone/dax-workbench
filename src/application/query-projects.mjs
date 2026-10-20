import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail, safeError, validateParameters, validateQuery } from "./policy.mjs";
import { generateProject, hashProject, nativeParameterNames, PROJECT_TARGETS } from "../integrations/project-generation.mjs";
import { generateBuilderQuery, queryBuilderFiles } from "../integrations/libraries.mjs";
import { saveLibraryEntry, reusableQueryHash } from "./query-library.mjs";
import { ProjectRuntime } from "../extension/project-runtime.mjs";
import { safeProjectDirectory } from "../integrations/project-files.mjs";

const clone = structuredClone;
const text = (value, label, max = 180) => {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
        throw fail("INVALID_PROJECT", `${label} is required and must contain at most ${max} characters.`);
    return value.trim();
};
function filePath(directory, name) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name)
        || name.split("/").some(part => part === "." || part === ".."))
        throw fail("PROJECT_FILE", "Invalid generated file name.");
    return path.join(directory, ...name.split("/"));
}
export function projectFolderName(title) {
    const name = String(title ?? "").toLowerCase().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
    if (!name) return "dax-project";
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `${name}-project` : name;
}
const exists = async location => { try { await lstat(location); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

export class QueryProjects {
    constructor(wb, runtime) {
        this.wb = wb; this.revision = 0; this.entries = []; this.previews = new Map(); this.proposal = null;
        this.queue = Promise.resolve(); this.runtime = runtime ?? new ProjectRuntime(this);
    }
    async initialize() {
        const saved = await this.wb.native.request("store.read", { key: `projects:${this.wb.id}` });
        if (saved.value !== null) {
            if (saved.value.version !== 1 || !Array.isArray(saved.value.entries) || saved.value.entries.length > 50
                || Buffer.byteLength(JSON.stringify(saved.value)) > 768 * 1024
                || new Set(saved.value.entries.map(entry => entry?.id)).size !== saved.value.entries.length)
                throw fail("PROJECT_CORRUPT", "The project catalog cannot be restored. Existing files were not changed.");
            for (const entry of saved.value.entries) {
                if (!entry || !/^project:[a-f0-9-]+$/.test(entry.id) || !PROJECT_TARGETS.includes(entry.target)
                    || typeof entry.directory !== "string" || !path.isAbsolute(entry.directory)
                    || typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 180
                    || typeof entry.collectionId !== "string" || !Number.isFinite(Date.parse(entry.createdAt))
                    || !Array.isArray(entry.sources) || !entry.sources.length || entry.sources.length > 21
                    || new Set(entry.sources.map(source => source?.id)).size !== entry.sources.length
                    || entry.sources.some(source => !source || !/^query-\d+$/.test(source.id) || typeof source.title !== "string"
                        || typeof source.query !== "string" || typeof source.connectionId !== "string" || typeof source.connectionName !== "string"
                        || !/^[a-f0-9]{64}$/.test(source.connectionHash) || !Array.isArray(source.parameterNames)
                        || source.parameterNames.some(name => typeof name !== "string") || !source.parameters || typeof source.parameters !== "object"
                        || Array.isArray(source.parameters) || !source.evidence || typeof source.evidence.status !== "string")
                    || !Array.isArray(entry.files) || !entry.files.length || entry.files.length > 64
                    || entry.files.some(file => !/^[a-f0-9]{64}$/.test(file.sha256) || !filePath(entry.directory, file.name))
                    || new Set(entry.files.map(file => file.name)).size !== entry.files.length
                    || !Number.isSafeInteger(entry.revision) || entry.revision < 0 || !entry.activity
                    || !["created", "setting-up", "ready", "starting", "running", "completed", "stopped", "failed", "interrupted"].includes(entry.activity.status)
                    || typeof entry.activity.environmentReady !== "boolean" || typeof entry.activity.message !== "string")
                    throw fail("PROJECT_CORRUPT", "A saved project record is invalid. No project was started.");
            }
            this.entries = clone(saved.value.entries);
            for (const entry of this.entries) { delete entry.activity.url; delete entry.activity.log; }
            for (const entry of this.entries) if (["setting-up", "starting", "running"].includes(entry.activity.status))
                entry.activity = { ...entry.activity, status: "interrupted", message: "The previous process is no longer owned by this Workbench. Review before starting again.", url: undefined, log: undefined };
        }
        this.revision = saved.revision;
    }
    serial(operation) {
        const result = this.queue.then(operation);
        this.queue = result.catch(() => {});
        return result;
    }
    async commit(entries) {
        const value = { version: 1, entries };
        if (entries.length > 50 || Buffer.byteLength(JSON.stringify(value)) > 768 * 1024)
            throw fail("PROJECT_LIMIT", "The local catalog supports 50 projects and 768 KiB of project records. Use smaller query packs.");
        const result = await this.wb.native.request("store.write", { key: `projects:${this.wb.id}`, expectedRevision: this.revision, value });
        this.entries = entries; this.revision = result.revision; this.wb.publish();
    }
    get(id) {
        const entry = this.entries.find(item => item.id === id);
        if (!entry) throw fail("PROJECT_NOT_FOUND", "This project is not in the current Workbench.");
        return entry;
    }
    async activity(id, update) {
        return this.serial(async () => {
            const entries = clone(this.entries), entry = entries.find(item => item.id === id);
            if (!entry) throw fail("PROJECT_NOT_FOUND", "The project no longer exists.");
            entry.activity = { ...entry.activity, ...update, log: undefined };
            entry.revision++;
            await this.commit(entries);
        });
    }
    status(id) {
        const entry = this.get(id);
        return { id, revision: entry.revision, status: entry.activity.status, environmentReady: entry.activity.environmentReady };
    }
    catalog() {
        return this.entries.map(entry => ({
            id: entry.id, kind: "project", title: entry.title, description: `${entry.target} · ${entry.activity.status}`,
            collectionId: entry.collectionId, updatedAt: entry.createdAt, archived: entry.archived,
            connectionName: entry.sources.length === 1 ? entry.sources[0].connectionName : "Multiple query sources",
            modelScope: entry.sources.every(source => source.connectionId === this.wb.activeDocument().connectionId) ? "current" : "other",
        }));
    }
    guard(request) {
        const doc = this.wb.activeDocument();
        if (this.wb.closed || doc.id !== request.documentId || doc.connectionId !== request.connectionId
            || doc.revision !== request.revision || (doc.builderRevision ?? 0) !== request.builderRevision
            || this.wb.state.library.revision !== request.libraryRevision)
            throw fail("REVISION_CONFLICT", "The query, builder, or library changed. Refresh the file preview before creating anything.");
        const selected = request.documents ?? [];
        if (!Array.isArray(selected) || selected.length > 20)
            throw fail("PROJECT_LIMIT", "Choose at most 20 additional open or saved queries.");
        const documents = [doc], ids = new Set([doc.id]);
        for (const reference of selected) {
            if (!reference || typeof reference !== "object" || typeof reference.id !== "string" || !reference.id
                || typeof reference.connectionId !== "string" || !Number.isSafeInteger(reference.revision) || reference.revision < 0
                || !Number.isSafeInteger(reference.builderRevision) || reference.builderRevision < 0 || ids.has(reference.id))
                throw fail("INVALID_PROJECT", "Choose distinct open query tabs with their current model and revisions.");
            const selectedDoc = this.wb.state.documents.find(item => item.id === reference.id);
            if (!selectedDoc || selectedDoc.connectionId !== reference.connectionId || selectedDoc.revision !== reference.revision
                || (selectedDoc.builderRevision ?? 0) !== reference.builderRevision)
                throw fail("REVISION_CONFLICT", "A selected query tab changed or closed. Refresh the file preview before creating anything.");
            ids.add(reference.id); documents.push(selectedDoc);
        }
        return documents;
    }
    source(document, index, includeValues) {
        const connection = this.wb.state.connections.find(item => item.id === document.connectionId);
        if (!connection) throw fail("CONNECTION_NOT_FOUND", "Every selected query needs its exact configured connection. Open and reconnect unbound queries first.");
        validateQuery(document.query);
        const definitions = document.parameterDefinitions ? clone(document.parameterDefinitions) : undefined;
        if (!includeValues && definitions) for (const value of Object.values(definitions)) delete value.default;
        const run = this.wb.state.runs.find(item => item.connectionId === connection.id && item.resultConnectionKey === hashProject(connection)
            && (item.templateQuery ?? item.query) === document.query && hashProject(item.parameters) === hashProject(document.parameters ?? {}));
        const evidence = run && (includeValues || !Object.keys(document.parameters ?? {}).length)
            ? { status: run.status, runId: run.id, startedAt: run.startedAt, truncated: run.truncated }
            : { status: "not-run" };
        return {
            id: `query-${index + 1}`, title: document.title, query: document.query, revision: document.revision ?? 0,
            connectionId: connection.id, connectionName: connection.name, connectionKind: connection.kind, model: connection.model,
            connectionHash: hashProject(connection), parameters: includeValues ? clone(document.parameters ?? {}) : {},
            parameterNames: definitions ? Object.keys(definitions) : nativeParameterNames(document.query), parameterDefinitions: definitions, evidence,
        };
    }
    // Suggest new, non-existing folders under recently used project parents and the home folder; nothing is created here.
    async suggestDirectories(title, home = os.homedir(), warnings = []) {
        const parents = [...this.entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .map(entry => path.dirname(entry.directory));
        if (home) parents.push(home);
        const name = projectFolderName(title), seen = new Set(), suggestions = [];
        for (const parent of parents) {
            const key = path.resolve(parent).toLowerCase();
            if (seen.has(key) || seen.size >= 4) continue;
            seen.add(key);
            try {
                await safeProjectDirectory(parent);
                for (let index = 1; index <= 50; index++) {
                    const candidate = path.join(parent, index === 1 ? name : `${name}-${index}`);
                    if (!await exists(candidate)) { suggestions.push(candidate); break; }
                }
            } catch (error) {
                const message = `A suggested folder could not be checked. You can choose another parent folder. ${safeError(error).message}`;
                if (!warnings.includes(message)) warnings.push(message);
            }
        }
        return suggestions;
    }
    async prepare(request) {
        const documents = clone(this.guard(request)), doc = documents[0];
        const title = text(request.title, "Project name", request.target === "example" ? 120 : 180), target = request.target;
        if (!PROJECT_TARGETS.includes(target)) throw fail("INVALID_PROJECT", "Choose a supported destination.");
        for (const [name, max] of [["server", 2048], ["database", 512]]) if (request[name] !== undefined
            && (typeof request[name] !== "string" || request[name].length > max || /[\u0000-\u001f]/.test(request[name])))
            throw fail("INVALID_PROJECT", `Use a single-line ${name} of at most ${max} characters.`);
        if (!Array.isArray(request.entryIds ?? []) || (request.entryIds?.length ?? 0) + documents.length > 21
            || (request.entryIds ?? []).some(id => typeof id !== "string" || !id)
            || new Set(request.entryIds).size !== (request.entryIds?.length ?? 0))
            throw fail("PROJECT_LIMIT", "Choose at most 20 additional distinct open or saved queries.");
        if (!["python", "streamlit", "pack"].includes(target) && (documents.length > 1 || request.entryIds?.length))
            throw fail("INVALID_PROJECT", "Additional queries are supported for Python projects, Streamlit apps, and query packs only.");
        for (const id of request.entryIds ?? []) {
            const entry = this.wb.state.library.entries.find(item => item.id === id && !item.archived);
            if (!entry) throw fail("LIBRARY_ENTRY_NOT_FOUND", "A selected saved query is unavailable. Refresh the library.");
            documents.push(clone(entry));
        }
        const sources = documents.map((document, index) => this.source(document, index, request.includeValues === true));
        const modelsByName = new Map();
        for (const source of sources) {
            if (modelsByName.has(source.connectionName) && modelsByName.get(source.connectionName) !== source.connectionHash)
                throw fail("PROJECT_CONNECTION_AMBIGUOUS", "Selected queries use different profiles with the same name. Give those profiles distinct names before exporting a portable pack.");
            modelsByName.set(source.connectionName, source.connectionHash);
        }
        if (Buffer.byteLength(JSON.stringify(sources)) > 384 * 1024) throw fail("PROJECT_LIMIT", "These query sources exceed 384 KiB. Choose a smaller pack.");
        let output;
        if (target === "studio") {
            if (!doc.builder || doc.builderImport) throw fail("BUILDER_REQUIRED", "DAX Studio paired files require a resolved builder. Plain DAX remains available in Library > Files.");
            const built = generateBuilderQuery(doc.builder);
            if (doc.query.trim() !== built.query.trim() && doc.query.trim() !== `/* START QUERY BUILDER */\n${built.query}\n/* END QUERY BUILDER */`)
                throw fail("BUILDER_OUT_OF_SYNC", "The complete editor must match the builder before exporting paired DAX Studio files.");
            built.builder.connection_name = sources[0].connectionName;
            const pair = queryBuilderFiles({ name: "query", query: built.query, builder: built.builder, connectionName: sources[0].connectionName });
            output = { files: pair.files, warnings: ["Paired files use the verified canonical builder DAX; editor wrapper comments are omitted. Opening the pair does not execute DAX.", ...(pair.builderWarning ? [pair.builderWarning] : [])] };
        } else if (target === "example") {
            output = { files: [{ name: "query.dax", content: doc.query }], warnings: ["Execution evidence is not a certification of business correctness."] };
        } else output = await generateProject({ target, title, sources, server: request.server, database: request.database });
        this.guard(request);
        for (const [id, preview] of this.previews) if (preview.expires < Date.now()) this.previews.delete(id);
        if (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value);
        const suggestedDirectories = target === "example" ? [] : await this.suggestDirectories(title, os.homedir(), output.warnings);
        this.guard(request);
        const preview = { id: randomUUID(), target, title, sources, ...output, libraryRevision: request.libraryRevision, suggestedDirectories };
        this.previews.set(preview.id, { ...clone(preview), guard: clone(request), document: doc, expires: Date.now() + 20 * 60_000 });
        return preview;
    }
    preview(id) {
        const preview = this.previews.get(id);
        if (!preview || preview.expires < Date.now()) throw fail("PROJECT_PREVIEW_EXPIRED", "Preview the files again before saving.");
        this.guard(preview.guard);
        for (const source of preview.sources) if (hashProject(this.wb.state.connections.find(item => item.id === source.connectionId)) !== source.connectionHash)
            throw fail("CONNECTION_CHANGED", "A query connection changed. Create a fresh file preview.");
        return preview;
    }
    async create(request) {
        return this.serial(async () => {
            const preview = this.preview(request.previewId);
            if (!this.wb.state.library.collections.some(item => item.id === request.collectionId))
                throw fail("LIBRARY_COLLECTION_NOT_FOUND", "Choose an existing saved collection.");
            if (preview.target === "example") {
                const result = await this.wb.mutate(next => {
                    this.preview(request.previewId);
                    const result = saveLibraryEntry(next.library, {
                        collectionId: request.collectionId, expectedRevision: preview.libraryRevision, title: preview.title,
                        description: "Reusable query example",
                        documentation: `## Purpose\n\nPreserve the selected query as a reusable example; its business interpretation is not documented yet.\n\n## Scope\n\n| Setting | Value |\n|---|---|\n| Source | ${preview.sources[0].connectionName.replaceAll("|", "\\|")} |\n| Period | Not documented; inspect the pinned query. |\n| Grain | Not documented. |\n| Measure / units | Not documented; no units inferred. |\n\n## Filters\n\n| Field | Operator | Exact value(s) |\n|---|---|---|\n| Not documented | Not verified | Inspect the pinned query and parameter definitions. |\n\n**Excluded:** Not verified.\n\n**Filter assumptions:** No filters were inferred from execution evidence.\n\n## Caveats\n\nDocumentation is an incomplete draft. Review the query's period, grain, measures, units and filters before reuse. Execution does not certify business correctness.\n\n## Technical details\n\nCaptured execution status: ${preview.sources[0].evidence.status}.\n`,
                    }, { ...preview.document, parameters: preview.sources[0].parameters, parameterDefinitions: preview.sources[0].parameterDefinitions },
                    next.connections, this.wb.knowledgeIdentity());
                    const saved = next.library.entries.find(item => item.id === result.id);
                    saved.reusableEvidence = { ...clone(preview.sources[0].evidence), sourceHash: reusableQueryHash(saved) };
                    return { id: result.id, executed: false };
                });
                this.previews.delete(request.previewId);
                return result;
            }
            const directory = path.resolve(text(request.directory, "Destination", 2048));
            if (!path.isAbsolute(request.directory)) throw fail("PROJECT_PATH", "Enter an absolute destination path.");
            await safeProjectDirectory(path.dirname(directory));
            try { await lstat(directory); throw fail("PROJECT_EXISTS", "This destination already exists. Choose a new folder; existing files are never overwritten."); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            if (this.entries.length >= 50) throw fail("PROJECT_LIMIT", "At most 50 linked projects may be saved.");
            const entry = {
                id: `project:${randomUUID()}`, title: preview.title, target: preview.target, directory,
                collectionId: request.collectionId, revision: 0, createdAt: new Date().toISOString(),
                sources: clone(preview.sources), files: preview.files.map(file => ({ name: file.name, sha256: hashProject(file.content) })),
                activity: { status: "created", message: ["power-query", "studio"].includes(preview.target) ? "Files created. Open or copy them in the destination application." : "Files created. Set up the environment before running.", environmentReady: false },
            };
            if (Buffer.byteLength(JSON.stringify({ entries: [...this.entries, entry] })) > 768 * 1024)
                throw fail("PROJECT_LIMIT", "The project catalog is full; choose a smaller pack.");
            const created = [];
            await mkdir(directory);
            try {
                await safeProjectDirectory(directory);
                for (const file of preview.files) {
                    const output = filePath(directory, file.name), parent = path.dirname(output);
                    if (parent !== directory) {
                        try { await mkdir(parent); } catch (error) { if (error.code !== "EEXIST") throw error; }
                    }
                    await safeProjectDirectory(parent);
                    const handle = await open(output, "wx");
                    try { await handle.writeFile(file.content, "utf8"); } finally { await handle.close(); }
                    created.push(file.name);
                }
                this.preview(request.previewId);
                await this.commit([...this.entries, entry]);
            } catch (error) {
                throw fail(error.code ?? "PROJECT_CREATE_FAILED", `${error.message} Created files retained at ${directory}: ${created.join(", ") || "none"}. No files were overwritten; inspect this folder before retrying.`);
            }
            this.previews.delete(request.previewId); this.proposal = null; this.wb.publish();
            return { id: entry.id, directory, executed: false };
        });
    }
    async verify(entry) {
        await safeProjectDirectory(entry.directory);
        for (const file of entry.files) {
            const location = filePath(entry.directory, file.name);
            await safeProjectDirectory(path.dirname(location));
            const info = await lstat(location);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024
                || hashProject(await readFile(location)) !== file.sha256)
                throw fail("PROJECT_CHANGED", `${file.name} changed outside Workbench. Create a new reviewed project or run the edited project independently.`);
        }
        // Python startup customization in an otherwise reviewed directory can execute before the runner.
        const allowed = new Set([...entry.files.map(file => file.name.split("/")[0]), ".venv", "__pycache__", "uv.lock"]);
        for (const name of await readdir(entry.directory)) if (!allowed.has(name))
            throw fail("PROJECT_CHANGED", `${name} was added outside Workbench. Managed launch is blocked; review or use independent execution.`);
    }
    async execute(entry, queryId, values) {
        if (entry.archived || this.wb.closed) throw fail("PROJECT_UNAVAILABLE", "This project's managed connection is closed.");
        const source = entry.sources.find(item => item.id === queryId);
        if (!source) throw fail("PROJECT_QUERY", "The project connection only accepts its captured query IDs.");
        validateParameters(values, Boolean(source.parameterDefinitions));
        if (!source.parameterDefinitions && Object.keys(values).some(key => !source.parameterNames.includes(key)))
            throw fail("INVALID_PARAMETERS", "Only the captured native parameter names may be supplied.");
        const runSource = { ...clone(source), parameters: clone(values) };
        this.assertRun({ id: entry.id, source: runSource });
        const started = await this.wb.runQuery(undefined, "ui", undefined, undefined, undefined, undefined, { id: entry.id, source: runSource });
        this.runtime.trackRun(entry.id, started.runId);
        try {
            await this.wb.running.get(started.runId);
            const run = this.wb.state.runs.find(item => item.id === started.runId);
            if (run.status !== "completed") throw fail("PROJECT_QUERY_FAILED", run.error?.message ?? `Query ${run.status}.`);
            if (run.resultSets.length !== 1) throw fail("PROJECT_RESULT_SHAPE", "Managed projects require exactly one result table.");
            const set = run.resultSets[0], rows = [];
            let bytes = 0;
            for (let offset = 0; offset < set.rowCount;) {
                const page = await this.wb.page(run.id, set.id, offset, 1000);
                if (!page.rows.length) throw fail("PROJECT_RESULT_INCOMPLETE", "Captured result pages are incomplete.");
                bytes += Buffer.byteLength(JSON.stringify(page.rows));
                if (bytes > this.wb.state.limits.maxBytes) throw fail("PROJECT_RESULT_LIMIT", "The typed project response exceeds the byte limit.");
                rows.push(...page.rows); offset += page.rows.length;
            }
            return { runId: run.id, columns: set.columns, rows, rowCount: rows.length, truncated: run.truncated || set.truncated, mode: "workbench" };
        } finally {
            this.runtime.untrackRun(entry.id, started.runId);
            this.wb.resultLeases.delete(started.runId);
        }
    }
    assertRun(request) {
        const entry = this.get(request.id), source = entry.sources.find(item => item.id === request.source.id);
        if (entry.archived || !source || source.query !== request.source.query || source.connectionId !== request.source.connectionId
            || hashProject(source.parameterDefinitions) !== hashProject(request.source.parameterDefinitions)
            || source.connectionHash !== hashProject(this.wb.state.connections.find(item => item.id === source.connectionId)))
            throw fail("PROJECT_SCOPE_CHANGED", "The project's source or model changed. Create a new reviewed project.");
    }
    propose(request) {
        const doc = this.wb.activeDocument();
        if (doc.id !== request.documentId || doc.connectionId !== request.connectionId || doc.revision !== request.revision)
            throw fail("REVISION_CONFLICT", "Read fresh query context before preparing a project proposal.");
        if (!PROJECT_TARGETS.includes(request.target)) throw fail("INVALID_PROJECT", "Choose a supported output.");
        this.proposal = { id: randomUUID(), target: request.target, documentId: doc.id, revision: doc.revision,
            rationale: text(request.rationale || "Review the output and destination in Use queries.", "Rationale", 1000) };
        this.wb.publish();
        return { proposalId: this.proposal.id, executed: false, filesCreated: false };
    }
    async action(action, payload) {
        switch (action) {
            case "projects.prepare": return this.prepare(payload);
            case "projects.create": return this.create(payload);
            case "projects.get": {
                const entry = clone(this.get(payload.id));
                entry.activity = { ...entry.activity, ...this.runtime.details(entry.id) };
                return entry;
            }
            case "projects.file": {
                const entry = this.get(payload.id), file = entry.files.find(item => item.name === payload.name);
                if (!file) throw fail("PROJECT_FILE", "Choose a generated file.");
                await this.verify(entry);
                return { name: file.name, content: await readFile(filePath(entry.directory, file.name), "utf8") };
            }
            case "projects.setup": return this.runtime.start(this.get(payload.id), "setup");
            case "projects.run": return this.runtime.start(this.get(payload.id), "run", payload.queryId);
            case "projects.launch": return this.runtime.start(this.get(payload.id), "launch");
            case "projects.stop": return this.runtime.stop(payload.id);
            case "projects.openFolder": return this.runtime.openFolder(this.get(payload.id));
            case "projects.organize": return this.serial(async () => {
                const entry = this.get(payload.id);
                if (entry.revision !== payload.revision) throw fail("REVISION_CONFLICT", "Refresh this project's details before changing it.");
                if (typeof payload.archived !== "boolean") throw fail("INVALID_PROJECT", "Specify archive or restore.");
                if (this.runtime.active.has(entry.id)) throw fail("PROJECT_BUSY", "Stop the owned process before archiving this reference.");
                const entries = clone(this.entries), next = entries.find(item => item.id === entry.id);
                next.archived = payload.archived; next.revision++;
                if (payload.title !== undefined) next.title = text(payload.title, "Project name");
                if (payload.collectionId !== undefined) {
                    if (!this.wb.state.library.collections.some(item => item.id === payload.collectionId)) throw fail("LIBRARY_COLLECTION_NOT_FOUND", "Choose an existing collection.");
                    next.collectionId = payload.collectionId;
                }
                await this.commit(entries); return { id: next.id };
            });
            default: throw fail("UNKNOWN_ACTION", "Unsupported project action.");
        }
    }
    async close() { this.previews.clear(); this.proposal = null; await this.runtime.close(); await this.queue; }
}
