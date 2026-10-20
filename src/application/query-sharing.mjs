import { randomUUID } from "node:crypto";
import { fail } from "./policy.mjs";
import { hashProject, nativeParameterNames, projectSlug } from "../integrations/project-generation.mjs";
import { loadShareModelSources } from "../integrations/libraries.mjs";
import { modelKnowledgeRecords } from "./model-context.mjs";

export const SHARE_LIMITS = Object.freeze({ queries: 20, bytes: 1024 * 1024, modelQueries: 250, modelBytes: 8 * 1024 * 1024,
    previews: 4, ageMs: 15 * 60_000, notes: 10 });
const modelKeys = ["starters", "tabs", "saved", "modelContext", "validatedQueries", "skill"];
const json = value => JSON.stringify(value, null, 2) + "\n";
const copy = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
const fieldKeys = ["id", "kind", "table", "name", "dataType", "caption", "expression", "isCustom"];
const objectKeys = ["id", "kind", "table", "name", "dataType", "nativeDataType", "qualifiedName", "description", "expression",
    "formatString", "isHidden", "displayFolder", "source", "measureGroup", "sortByColumnId"];
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const md = value => String(value ?? "").replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/[\r\n]/g, " ");
function definitions(value, includeValues) {
    return Object.fromEntries(Object.entries(value ?? {}).map(([name, definition]) => [name,
        copy(definition, ["type", "required", "description", "allowed_values", ...(includeValues ? ["default"] : [])])]));
}
function builder(value) {
    if (!value) return undefined;
    return {
        ...copy(value, ["version", "format"]),
        fields: (value.fields ?? []).map(field => copy(field, fieldKeys)),
        filters: (value.filters ?? []).map(filter => ({ ...copy(filter, ["id", "operator", "value", "value2", "enabled", "isParameter", "isParameter2"]),
            field: copy(filter.field, fieldKeys) })),
        orderBy: (value.orderBy ?? []).map(order => copy(order, ["fieldId", "direction"])),
    };
}
function selection(values, max, label) {
    if (!Array.isArray(values) || values.length > max || values.some(id => typeof id !== "string" || !id || id.length > 136)
        || new Set(values).size !== values.length)
        throw fail("INVALID_SHARE", `Choose at most ${max} distinct ${label}.`);
}
export class QuerySharing {
    constructor(wb) { this.wb = wb; this.previews = new Map(); this.loadSources = loadShareModelSources; }
    captureState(request) {
        const keys = ["documentId", "connectionId", "revision", "builderRevision", "libraryRevision", "documents", "entryIds", "title",
            "note", "schemaScope", "includeDocumentation", "includeResearch", "includeValues", "knowledgeRefs", "identity", "scope", "modelOptions"];
        if (!plain(request) || Object.keys(request).some(key => !keys.includes(key))
            || typeof request.title !== "string" || !request.title.trim() || request.title.length > 120 || /[\u0000-\u001f]/.test(request.title)
            || typeof request.note !== "string" || request.note.length > 8000 || request.note.includes("\0")
            || !["none", "selected", "loaded"].includes(request.schemaScope)
            || ["includeDocumentation", "includeResearch", "includeValues"].some(key => typeof request[key] !== "boolean")
            || !Array.isArray(request.documents) || request.documents.some(ref => !plain(ref)
                || Object.keys(ref).some(key => !["id", "revision", "builderRevision"].includes(key))
                || !Number.isSafeInteger(ref.revision) || !Number.isSafeInteger(ref.builderRevision)))
            throw fail("INVALID_SHARE", "Use the supported query selections and sharing options.");
        const modelKit = request.scope === "model";
        if (request.scope !== undefined && !["queries", "model"].includes(request.scope)
            || modelKit && (!plain(request.modelOptions) || Object.keys(request.modelOptions).length !== modelKeys.length
                || modelKeys.some(key => typeof request.modelOptions[key] !== "boolean"))
            || !modelKit && request.modelOptions !== undefined)
            throw fail("INVALID_SHARE", "Choose a model starter kit or explicit query selections.");
        selection(request.documents.map(ref => ref.id), SHARE_LIMITS.queries, "open queries");
        selection(request.entryIds, SHARE_LIMITS.queries, "saved queries");
        if (!Array.isArray(request.knowledgeRefs) || request.knowledgeRefs.length > SHARE_LIMITS.notes
            || request.knowledgeRefs.some(ref => !plain(ref) || Object.keys(ref).some(key => !["id", "version"].includes(key))
                || typeof ref.id !== "string" || !Number.isSafeInteger(ref.version)))
            throw fail("INVALID_SHARE", "Choose at most ten available model notes.");
        selection(request.knowledgeRefs.map(ref => ref.id), SHARE_LIMITS.notes, "model notes");
        const { state } = this.wb, active = this.wb.activeDocument();
        if (this.wb.closed || active.id !== request.documentId || active.connectionId !== request.connectionId
            || active.revision !== request.revision || (active.builderRevision ?? 0) !== request.builderRevision
            || state.library.revision !== request.libraryRevision)
            throw fail("REVISION_CONFLICT", "The active query, builder or library changed. Refresh the share preview.");
        if (!modelKit && (!request.documents.some(ref => ref.id === active.id) || request.documents.length + request.entryIds.length > SHARE_LIMITS.queries))
            throw fail("INVALID_SHARE", "Include the active query and at most twenty explicitly selected queries in total.");
        const connection = state.connections.find(item => item.id === active.connectionId);
        if (modelKit && !connection) throw fail("INVALID_SHARE", "Choose a model before gathering a model starter kit.");
        const coverage = [];
        let sources = modelKit ? [] : request.documents.map(ref => {
            const doc = state.documents.find(doc => doc.id === ref.id);
            if (!doc || doc.revision !== ref.revision || (doc.builderRevision ?? 0) !== ref.builderRevision)
                throw fail("REVISION_CONFLICT", "A selected query tab changed. Refresh the share preview.");
            return { kind: "tab", doc };
        });
        for (const id of modelKit ? [] : request.entryIds) {
            const doc = state.library.entries.find(entry => entry.id === id && !entry.archived && entry.source === "saved");
            if (!doc) throw fail("LIBRARY_ENTRY_NOT_FOUND", "A selected saved query is unavailable. Refresh the share preview.");
            sources.push({ kind: "saved", doc });
        }
        const records = modelKit ? modelKnowledgeRecords(connection) : [];
        if (modelKit) {
            const options = request.modelOptions;
            const groups = [
                ["Open and recoverable tabs", options.tabs, [
                    ...state.documents.filter(doc => doc.connectionId === connection.id).map(doc => ({ kind: "tab", doc })),
                    ...(state.closedDocuments ?? []).filter(doc => doc.connectionId === connection.id).map(doc => ({ kind: "closed-tab", doc })),
                ]],
                ["Saved model queries", options.saved, state.library.entries.filter(doc => doc.source === "saved" && !doc.archived
                    && doc.connectionId === connection.id && doc.model === connection.model).map(doc => ({ kind: "saved", doc }))],
                ["Bundled starter queries", options.starters, records.filter(record => record.kind === "starter").map(record => ({
                    kind: "starter", doc: { id: record.id, title: record.title, query: record.query, builder: record.builder,
                        description: record.summary, documentation: record.body, connectionId: connection.id },
                }))],
            ];
            for (const [label, enabled, items] of groups) {
                const selected = enabled ? items.filter(({ doc }) => typeof doc.query === "string" && doc.query.trim()) : [];
                sources.push(...selected);
                coverage.push({ source: label, status: enabled ? selected.length ? "included" : "missing" : "excluded", count: selected.length,
                    detail: enabled ? `${items.length - selected.length} empty drafts omitted. Exact active connection/model only.` : "Not selected." });
            }
        }
        for (const { doc } of sources) if (typeof doc.query !== "string" || !doc.query.trim() || Buffer.byteLength(doc.query) > 256 * 1024)
            throw fail("INVALID_SHARE", "Each selected query must contain DAX and be at most 256 KiB. Nothing was exported.");
        const notes = modelKit ? records.filter(record => record.kind === "note" && request.modelOptions.modelContext)
            .map(record => copy(record, ["id", "version", "title", "body", "caveats", "unknowns", "provenance"])) : request.knowledgeRefs.map(ref => {
            const record = this.wb.getKnowledge({ identity: request.identity, ...ref });
            if (record.kind !== "note" || record.version !== ref.version)
                throw fail("SHARE_CONTEXT_CHANGED", "A selected model note changed or is not a note. Refresh the preview.");
            return copy(record, ["id", "version", "title", "body", "caveats", "unknowns", "provenance"]);
        });
        const schema = request.schemaScope !== "none" && state.schema?.connectionId === active.connectionId ? state.schema : null;
        const selected = new Set(state.selectedObjects);
        const fields = sources.filter(({ doc }) => doc.connectionId === active.connectionId)
            .flatMap(({ doc }) => [...(doc.builder?.fields ?? []), ...(doc.builder?.filters ?? []).map(filter => filter.field)]);
        const objects = (schema?.objects ?? []).filter(object => request.schemaScope === "loaded" || selected.has(object.id)
            || fields.some(field => field.kind === object.kind && field.name === object.name && (field.table ?? "") === (object.table ?? "")));
        const tables = new Set(objects.map(object => object.kind === "table" ? object.name : object.table).filter(Boolean));
        const context = {
            model: copy(state.connections.find(connection => connection.id === active.connectionId), ["name", "model", "kind"]),
            scope: request.schemaScope, available: Boolean(schema), fetchedAt: schema?.fetchedAt ?? null,
            origin: schema?.origin ?? null, coverage: schema?.coverage ? copy(schema.coverage, ["status", "scope", "source"]) : null,
            objects: objects.map(object => copy(object, objectKeys)),
            relationships: (schema?.relationships ?? []).filter(item => request.schemaScope === "loaded"
                || tables.has(item.fromTable) && tables.has(item.toTable)).map(item => copy(item,
                ["id", "name", "source", "fromTable", "fromColumn", "toTable", "toColumn", "isActive", "fromCardinality", "toCardinality", "crossFilteringBehavior"])),
            hierarchies: (schema?.hierarchies ?? []).filter(item => request.schemaScope === "loaded" || tables.has(item.table))
                .map(item => ({ ...copy(item, ["id", "name", "table", "qualifiedName", "source", "isHidden", "displayFolder", "description"]),
                    levels: item.levels.map(level => copy(level, ["id", "name", "ordinal", "columnId"])) })),
            notes,
        };
        if (modelKit) coverage.push(
            { source: "Bundled model notes", status: request.modelOptions.modelContext ? notes.length ? "included" : "missing" : "excluded",
                count: notes.length, detail: request.modelOptions.modelContext ? "Notes for the active model only." : "Not selected." },
            { source: "Loaded model schema", status: request.schemaScope === "none" ? "excluded" : schema ? "included" : "unavailable",
                count: objects.length, detail: "Already-loaded metadata only; no live refresh or completeness guarantee." },
        );
        const fingerprint = hashProject({
            sources: sources.map(({ kind, doc }) => ({ kind, doc })), context,
            connections: sources.map(({ doc }) => state.connections.find(connection => connection.id === doc.connectionId)),
            identity: this.wb.knowledgeIdentity(),
        });
        return { sources, context, fingerprint, coverage, connection };
    }
    async capture(request) {
        const captured = this.captureState(request);
        if (request.scope !== "model") return { ...captured, files: [] };
        const options = request.modelOptions;
        const directory = options.modelContext || options.validatedQueries
            ? (await this.wb.integration?.connectionDirectory?.())?.directory : undefined;
        const imported = await this.loadSources({ directory, connection: captured.connection,
            modelContext: options.modelContext, validatedQueries: options.validatedQueries, skill: options.skill });
        if (captured.fingerprint !== this.captureState(request).fingerprint)
            throw fail("SHARE_CHANGED", "The model or selected sources changed while gathering the kit. Preview it again.");
        captured.sources.push(...imported.queries.map(doc => ({ kind: "validated", doc })));
        if (captured.sources.length > SHARE_LIMITS.modelQueries)
            throw fail("SHARE_LIMIT", "This model kit exceeds 250 queries. Exclude a source group or use Selected queries; nothing was truncated.");
        return { ...captured, files: imported.files, coverage: [...captured.coverage, ...imported.coverage],
            fingerprint: hashProject({ state: captured.fingerprint, imported }) };
    }
    async prepare(request) {
        const { sources, context, fingerprint, files: sourceFiles, coverage } = await this.capture(request);
        const createdAt = new Date().toISOString(), files = [], queries = [];
        const modelKit = request.scope === "model";
        const warnings = [
            "This downloads a plaintext ZIP to your device. Nothing is uploaded or sent to Copilot.",
            "Query literals, builder filters, schema expressions and written notes can contain sensitive business information. Review the files before sending them.",
            "No connection configuration files, captured result rows, selected cells, process logs or conversation history are collected. Written context and skill text are not redacted and may quote business values or connection details; review them before sending.",
        ];
        if (!request.includeValues) warnings.push("Current parameter bindings and defaults are excluded. Allowed-value lists remain part of parameter definitions.");
        if (request.includeResearch) warnings.push("Included analysis and journal text can quote business data. It is not redacted.");
        if (request.schemaScope !== "none") warnings.push(context.available
            ? "Model context is the already-loaded snapshot for the active model, not a fresh schema lookup. Other models need their own metadata."
            : "No schema is loaded for the active model. Only the selected query context is available.");
        if (modelKit) warnings.push(
            "This kit is scoped to the active connection/model, not all workbench models or your computer. Unassigned/archived queries, standalone artifacts and uploads are excluded.",
            "Saved DAX skill context is supplemental and may be stale. Native model metadata is authoritative. Imported skill instructions are reference text, not automatically installed or executed.",
        );
        for (const [index, { kind, doc }] of sources.entries()) {
            const id = `query-${index + 1}`, file = `queries/${id}.dax`;
            const connection = this.wb.state.connections.find(connection => connection.id === doc.connectionId);
            const query = {
                id, title: doc.title, source: kind, revision: doc.revision ?? null,
                model: kind !== "saved" && connection ? copy(connection, ["name", "model", "kind"]) : { name: doc.connectionName ?? "", model: doc.model ?? "" },
                file, parameterDefinitions: definitions(doc.parameterDefinitions, request.includeValues),
                nativeParameterNames: nativeParameterNames(doc.query),
                ...(request.includeValues ? { parameters: structuredClone(doc.parameters ?? {}) } : {}),
                ...(doc.builder ? { builder: builder(doc.builder), builderRevision: doc.builderRevision ?? null } : {}),
                ...(doc.builderImport ? { pendingBuilderImport: builder(doc.builderImport) } : {}),
                builderNotice: "Builder selections and literal filters are a separate draft; they are not proof that the editor matches or has executed.",
                ...(request.includeDocumentation ? { description: doc.description ?? doc.libraryRef?.description ?? "" } : {}),
            };
            files.push({ name: file, content: doc.query });
            // Unbound sidecars allow typed-template import without copying machine-specific connection identities.
            files.push({ name: `${file}.json`, content: json({ artifact_version: "1.0", name: id, display_name: doc.title,
                connection_binding: "unbound", parameters: query.parameterDefinitions }) });
            const documentation = doc.documentation ?? doc.libraryRef?.documentation;
            if (request.includeDocumentation && documentation) {
                query.documentation = `context/${id}.md`;
                files.push({ name: query.documentation, content: documentation });
            }
            if (request.includeResearch && kind === "saved" && (doc.analysis || doc.notes?.length)) {
                query.research = `context/${id}-research.json`;
                files.push({ name: query.research, content: json({
                    analysis: doc.analysis ? copy(doc.analysis, ["author", "createdAt", "question", "content", "limitations"]) : null,
                    journal: (doc.notes ?? []).map(note => copy(note, ["author", "createdAt", "content", "correctionOf", "id"])),
                    notice: "Saved narrative only; execution evidence and current business correctness have not been verified.",
                }) });
            }
            queries.push(query);
        }
        files.unshift({ name: "README.md", content: `# ${md(request.title)}\n\nA DAX Workbench handoff created ${createdAt}. Exporting did not run any queries.\n\n## Queries\n\n| Query | Model | File |\n|---|---|---|\n${queries.map(query => `| ${md(query.title)} | ${md(query.model.name || "Unbound")} | \`${query.file}\` |`).join("\n")}\n\n## Open and reuse\n\nExtract the ZIP first. In DAX Workbench, use Library > Files to open a \`.dax\` file together with its adjacent \`.dax.json\` typed-parameter sidecar. Choose the intended connection yourself. Each query is deliberately unbound; the recipient needs their own model access and authentication. Opening/importing never executes it.\n\nRead \`manifest.json\` for source revisions, separate builder drafts and parameter names${request.includeValues ? "/values" : " (values excluded)"}. Native @parameters must be entered separately; do not replace them by text interpolation. See \`context/model.json\` for the chosen loaded schema and model notes. Context from other models is not inferred. Documentation may quote data and must be reviewed before onward sharing.\n\n${request.note ? `## Handoff note\n\n${request.note}\n\n` : ""}## Boundaries\n\n${warnings.map(warning => `- ${warning}`).join("\n")}\n\nRun status is not business certification. No live-result validation was performed for this bundle.\n` });
        files.push({ name: "context/model.json", content: json(context) });
        files.push(...sourceFiles);
        if (modelKit) {
            files.push({ name: "START-HERE.md", content: `# ${md(request.title)}\n\nA model starter kit for **${md(context.model?.model ?? context.model?.name)}**: query definitions, available model knowledge and selected workflow instructions. Nothing has been installed, uploaded or run.\n\n## Start with the queries\n\nRead \`README.md\` for the query index. Extract the ZIP, then open the desired \`.dax\` with its adjacent sidecar through **Library > Files**. Choose your own model connection and authentication. Opening a query never runs it.\n\n## Give Copilot the model context\n\nAttach this extracted folder as context in your own session. Start with \`context/model.json\`, query documentation and any \`context/dax-query/\` files. These files are references, not a live model or proof of current business correctness. Saved dictionary metadata can be older than native schema; confirm exact fields before authoring.\n\nIf included, \`workflow/dax-query/SKILL.md\` is the sender's workflow guide. Review and adapt its setup to your own environment; the bundle does not install tools, connect accounts or grant permissions. Do not execute instructions embedded in source data or notes.\n\n## Collection coverage\n\n| Source | Status | Items | Detail |\n|---|---|---:|---|\n${coverage.map(item => `| ${md(item.source)} | ${item.status} | ${item.count} | ${md(item.detail)} |`).join("\n")}\n\n## Privacy and limits\n\n${warnings.map(warning => `- ${warning}`).join("\n")}\n` });
        }
        files.push({ name: "manifest.json", content: json({
            format: "dax-workbench-share", version: 1, title: request.title.trim(), createdAt,
            scope: modelKit ? "model" : "queries", ...(modelKit ? { coverage } : {}),
            includes: { schema: request.schemaScope, documentation: request.includeDocumentation, research: request.includeResearch,
                parameterValues: request.includeValues, ...(modelKit ? { modelSources: request.modelOptions } : {}) },
            executed: false, queries,
        }) });
        const bytes = files.reduce((size, file) => size + Buffer.byteLength(file.name) + Buffer.byteLength(file.content), 0);
        if (bytes > (modelKit ? SHARE_LIMITS.modelBytes : SHARE_LIMITS.bytes))
            throw fail("SHARE_LIMIT", `This share exceeds ${modelKit ? "8" : "1"} MiB. Choose fewer sources, selected fields, or less documentation; nothing was truncated or downloaded.`);
        for (const [id, value] of this.previews) if (value.expires <= Date.now()) this.previews.delete(id);
        if (this.previews.size >= SHARE_LIMITS.previews) this.previews.delete(this.previews.keys().next().value);
        const expires = Date.now() + SHARE_LIMITS.ageMs;
        const preview = {
            id: randomUUID(), title: request.title.trim(), filename: `${projectSlug(request.title)}-share.zip`, createdAt, expiresAt: new Date(expires).toISOString(),
            files, bytes, queryCount: queries.length, schemaCount: context.objects.length, noteCount: context.notes.length, warnings,
            scope: modelKit ? "model" : "queries", coverage,
        };
        this.previews.set(preview.id, { request: structuredClone(request), fingerprint, expires, preview });
        return structuredClone(preview);
    }
    async download(payload) {
        if (!plain(payload) || Object.keys(payload).some(key => key !== "id") || typeof payload.id !== "string")
            throw fail("INVALID_SHARE", "Use the reviewed share preview.");
        const record = this.previews.get(payload.id);
        if (!record || record.expires <= Date.now()) throw fail("SHARE_EXPIRED", "The share preview expired. Preview the bundle again.");
        if (record.fingerprint !== (await this.capture(record.request)).fingerprint)
            throw fail("SHARE_CHANGED", "The selected queries, models or context changed. Preview the bundle again before downloading.");
        return structuredClone(record.preview);
    }
    action(name, payload) {
        if (name === "share.prepare") return this.prepare(payload);
        if (name === "share.download") return this.download(payload);
        throw fail("UNKNOWN_ACTION", "Unsupported share action.");
    }
    clear() { this.previews.clear(); }
}
