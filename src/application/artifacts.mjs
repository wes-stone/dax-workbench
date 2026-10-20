import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fail, requireId } from "./policy.mjs";
import { validateResearchSession, researchContentVersion } from "./research.mjs";
import {
    ARTIFACT_LIMITS, artifactObject, artifactText, artifactId, artifactRevision, artifactCollection,
    payloadIdPattern, managedKinds, noteText, validateVisual, validateArtifactCreate, validateArtifactUpdate,
} from "./artifacts-validation.mjs";
import { classifyArtifact, safeFileName, rasterMime, filePreview } from "./artifacts-preview.mjs";
import { summarizeWriting } from "../shared/writing.mjs";

const MAGIC = Buffer.from("DAXA1"), HEADER = 33;
const metadataKeys = ["id", "kind", "collectionId", "title", "description", "updatedAt", "byteLength", "fileName", "mimeType", "archived", "researchEntryId", "session", "payloadId", "encoding", "versions", "researchUpdatedAt", "researchContentVersion"];
function metadata(value) {
    artifactObject(value, metadataKeys, ["id", "kind", "collectionId", "title", "description", "updatedAt", "byteLength", "fileName", "mimeType", "payloadId", "encoding"]);
    artifactId(value.id);
    if (!managedKinds.includes(value.kind) || !payloadIdPattern.test(value.payloadId)
        || !/^saved:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.collectionId)
        || !["file", "note", "visual"].includes(value.encoding) || (["note", "visual"].includes(value.kind) ? value.kind !== value.encoding : value.encoding !== "file"))
        throw fail("ARTIFACT_CORRUPT", "The artifact index contains unsupported metadata.");
    artifactText(value.title, "Title", 180); artifactText(value.description, "Description", 500, { empty: true, multiline: true });
    artifactText(value.updatedAt, "Timestamp", 30); safeFileName(value.fileName); artifactText(value.mimeType, "Content type", 120);
    if (!Number.isFinite(Date.parse(value.updatedAt)) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > ARTIFACT_LIMITS.maxFileBytes
        || (value.archived !== undefined && typeof value.archived !== "boolean"))
        throw fail("ARTIFACT_CORRUPT", "The artifact index has invalid sizes or timestamps.");
    if (value.researchEntryId !== undefined && !/^saved:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.researchEntryId))
        throw fail("ARTIFACT_CORRUPT", "Invalid saved research reference.");
    if (value.session !== undefined) validateResearchSession(value.session);
    if (value.researchUpdatedAt !== undefined && (!value.researchEntryId || typeof value.researchUpdatedAt !== "string" || !Number.isFinite(Date.parse(value.researchUpdatedAt))))
        throw fail("ARTIFACT_CORRUPT", "Invalid linked research revision.");
    if (value.researchContentVersion !== undefined && (!value.researchEntryId || !/^[a-f0-9]{64}$/.test(value.researchContentVersion)))
        throw fail("ARTIFACT_CORRUPT", "Invalid linked research content version.");
    if (value.versions !== undefined) {
        if (value.kind !== "note" || !Array.isArray(value.versions) || value.versions.length > 20
            || new Set(value.versions.map(item => item.payloadId)).size !== value.versions.length)
            throw fail("ARTIFACT_CORRUPT", "Invalid note version history.");
        value.versions.forEach(item => {
            artifactObject(item, ["payloadId", "byteLength", "updatedAt"], ["payloadId", "byteLength", "updatedAt"]);
            if (!payloadIdPattern.test(item.payloadId) || !Number.isSafeInteger(item.byteLength)
                || item.byteLength < 0 || item.byteLength > ARTIFACT_LIMITS.maxFileBytes || !Number.isFinite(Date.parse(item.updatedAt)))
                throw fail("ARTIFACT_CORRUPT", "Invalid previous note payload.");
        });
    }
    return structuredClone(value);
}
function restore(value, revision) {
    if (value === null && revision === 0) return { version: 1, revision: 0, entries: [] };
    artifactObject(value, ["version", "revision", "entries"], ["version", "revision", "entries"]);
    if (value.version !== 1 || value.revision !== revision || !Array.isArray(value.entries))
        throw fail("ARTIFACT_CORRUPT", "The saved artifact index is unsupported or corrupt.");
    artifactRevision(value.revision);
    const index = { version: 1, revision, entries: value.entries.map(metadata) };
    if (new Set(index.entries.map(entry => entry.id)).size !== index.entries.length) throw fail("ARTIFACT_CORRUPT", "Duplicate artifact identifiers.");
    boundedIndex(index);
    return index;
}
function boundedIndex(index) {
    if (index.entries.length > ARTIFACT_LIMITS.maxEntries || Buffer.byteLength(JSON.stringify(index), "utf8") > ARTIFACT_LIMITS.indexBytes)
        throw fail("ARTIFACT_LIMIT", "The separate artifact catalog supports at most 2,000 managed entries and 1 MiB of metadata.");
}
const summary = ({ payloadId: _payload, encoding: _encoding, versions, ...visible }) => structuredClone({
    ...visible, ...(versions?.length ? { previousVersions: versions.map(({ payloadId, updatedAt }) => ({ id: payloadId, updatedAt })) } : {}),
});

export class ArtifactsStore {
    #key = null;
    #index = { version: 1, revision: 0, entries: [] };
    #queue = Promise.resolve();
    #ready = false;
    #writing = new Map();
    constructor({ native, artifactsRoot, id }) {
        this.native = native; this.id = requireId(id);
        if (id.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id))
            throw fail("ARTIFACT_PATH_UNSAFE", "Choose a workbench identifier that is not a reserved Windows path name.");
        this.directory = path.resolve(artifactsRoot, "workspace", id);
        this.indexKey = `artifacts:${id}`; this.secretKey = `artifacts-key:${id}`;
    }
    get revision() { return this.#index.revision; }
    async initialize() {
        if (this.#ready) return;
        const saved = await this.native.request("store.read", { key: this.indexKey });
        const secret = await this.native.request("store.read", { key: this.secretKey });
        const index = restore(saved.value, saved.revision);
        if (secret.value !== null) this.#key = this.#decodeKey(secret.value);
        if (index.entries.length && !this.#key) throw fail("ARTIFACT_CORRUPT", "The protected artifact encryption key is missing. Existing files were not modified.");
        this.#index = index; this.#ready = true;
    }
    #decodeKey(value) {
        if (!value || value.version !== 1 || typeof value.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.key) || Object.keys(value).length !== 2)
            throw fail("ARTIFACT_CORRUPT", "The protected artifact encryption key is invalid.");
        const key = Buffer.from(value.key, "base64");
        if (key.length !== 32) throw fail("ARTIFACT_CORRUPT", "The protected artifact encryption key is invalid.");
        return key;
    }
    async #ensureKey() {
        if (this.#key) return;
        const key = randomBytes(32);
        try {
            await this.native.request("store.write", { key: this.secretKey, expectedRevision: 0, value: { version: 1, key: key.toString("base64") } });
            this.#key = key;
        } catch (error) {
            key.fill(0);
            if (!["REVISION_CONFLICT", "STORE_CONFLICT"].includes(error.code)) throw error;
            const existing = await this.native.request("store.read", { key: this.secretKey });
            this.#key = this.#decodeKey(existing.value);
        }
    }
    #assertReady() { if (!this.#ready) throw fail("ARTIFACT_UNAVAILABLE", "Reopen the workbench to initialize the artifact catalog."); }
    #assertRevision(expected) {
        this.#assertReady(); artifactRevision(expected);
        if (expected !== this.revision) throw fail("REVISION_CONFLICT", "The artifact catalog changed. Reload it before saving.");
    }
    assertRevision(expected) { this.#assertRevision(expected); }
    #serialize(operation) {
        const pending = this.#queue.then(operation);
        this.#queue = pending.then(() => {}, () => {});
        return pending;
    }
    async #safeDirectory(create = false) {
        const root = path.parse(this.directory).root;
        let current = root;
        for (const part of path.relative(root, this.directory).split(path.sep)) {
            current = path.join(current, part);
            let info;
            try { info = await lstat(current); }
            catch (error) {
                if (error.code !== "ENOENT" || !create) throw error;
                try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
                info = await lstat(current);
            }
            if (info.isSymbolicLink() || !info.isDirectory()) throw fail("ARTIFACT_PATH_UNSAFE", "Artifact storage cannot use symbolic links, junctions or non-directory paths.");
        }
        return this.directory;
    }
    #file(payloadId, suffix = ".bin") {
        if (!payloadIdPattern.test(payloadId) || ![".bin", ".stage"].includes(suffix)) throw fail("ARTIFACT_PATH_UNSAFE", "Invalid generated artifact path.");
        return path.join(this.directory, `${payloadId}${suffix}`);
    }
    async #removePrepared(payloadId, owned) {
        // Never recurse or remove a caller-supplied path. If an ancestor changed,
        // leave the unreachable staged file rather than following a substituted link.
        try {
            await this.#safeDirectory();
            for (const suffix of [".stage", ".bin"]) {
                if (!owned[suffix]) continue;
                const file = this.#file(payloadId, suffix);
                try {
                    const info = await lstat(file);
                    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.ino === owned.ino && info.dev === owned.dev) await unlink(file);
                } catch (error) { if (error.code !== "ENOENT") throw error; }
            }
        } catch { /* An unsafe or unavailable directory must not redirect cleanup. */ }
    }
    async #prepare(entry, bytes, owned) {
        await this.#ensureKey();
        await this.#safeDirectory(true);
        const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, iv);
        cipher.setAAD(Buffer.from(`${this.id}:${entry.id}:${entry.payloadId}`));
        const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
        const staged = this.#file(entry.payloadId, ".stage"), prepared = this.#file(entry.payloadId);
        const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
            const info = await handle.stat();
            Object.assign(owned, { ".stage": true, ino: info.ino, dev: info.dev });
            await handle.writeFile(Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]));
            await handle.sync();
        } finally { await handle.close(); }
        await this.#safeDirectory();
        const stagedInfo = await lstat(staged);
        if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink() || stagedInfo.nlink !== 1
            || stagedInfo.ino !== owned.ino || stagedInfo.dev !== owned.dev || stagedInfo.size !== bytes.length + HEADER)
            throw fail("ARTIFACT_PATH_UNSAFE", "The generated staged payload changed before publication.");
        try { await lstat(prepared); throw fail("ARTIFACT_PATH_UNSAFE", "Generated payload path already exists."); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await rename(staged, prepared);
        owned[".stage"] = false; owned[".bin"] = true;
    }
    async #read(entry) {
        this.#assertReady();
        try {
            await this.#safeDirectory();
            const file = this.#file(entry.payloadId), info = await lstat(file);
            if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size !== entry.byteLength + HEADER)
                throw fail("ARTIFACT_CORRUPT", "The artifact payload is missing, unsafe or has an invalid size.");
            const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let bytes;
            try {
                const actual = await handle.stat();
                if (!actual.isFile() || actual.nlink !== 1 || actual.size !== info.size || actual.ino !== info.ino || actual.dev !== info.dev)
                    throw fail("ARTIFACT_CORRUPT", "The artifact payload changed during read.");
                await this.#safeDirectory();
                bytes = Buffer.alloc(actual.size);
                let offset = 0;
                while (offset < bytes.length) {
                    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
                    if (!bytesRead) throw fail("ARTIFACT_CORRUPT", "The artifact payload was truncated.");
                    offset += bytesRead;
                }
                if ((await handle.stat()).size !== bytes.length) throw fail("ARTIFACT_CORRUPT", "The artifact payload changed during read.");
            } finally { await handle.close(); }
            if (!bytes.subarray(0, 5).equals(MAGIC) || !this.#key) throw fail("ARTIFACT_CORRUPT", "The artifact envelope is invalid.");
            const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(5, 17));
            decipher.setAAD(Buffer.from(`${this.id}:${entry.id}:${entry.payloadId}`)); decipher.setAuthTag(bytes.subarray(17, 33));
            return Buffer.concat([decipher.update(bytes.subarray(HEADER)), decipher.final()]);
        } catch (error) {
            if (error.code === "ARTIFACT_PATH_UNSAFE") throw error;
            throw fail("ARTIFACT_CORRUPT", "This encrypted artifact cannot be authenticated or read. Existing files were not modified.");
        }
    }
    #entry(id) {
        this.#assertReady(); artifactId(id);
        const entry = this.#index.entries.find(item => item.id === id);
        if (!entry) throw fail("ARTIFACT_NOT_FOUND", "This managed artifact is not in the current workspace.");
        return structuredClone(entry);
    }
    async catalog(libraryCatalog) {
        this.#assertReady();
        await this.#serialize(async () => {
            const saved = await this.native.request("store.read", { key: this.indexKey });
            const index = restore(saved.value, saved.revision);
            if (index.entries.length && !this.#key) {
                const secret = await this.native.request("store.read", { key: this.secretKey });
                this.#key = this.#decodeKey(secret.value);
            }
            this.#index = index;
        });
        return {
            revision: this.revision, libraryRevision: libraryCatalog.revision,
            collections: structuredClone(libraryCatalog.collections.filter(collection => collection.source === "saved")),
            entries: [...libraryCatalog.entries.filter(entry => entry.source === "saved").map(({ source: _source, model: _model, ...entry }) => ({
                ...entry, kind: entry.hasAnalysis ? "research" : "query",
            })), ...this.#index.entries.map(entry => {
                const cached = this.#writing.get(entry.id);
                return { ...summary(entry), ...(cached?.payloadId === entry.payloadId ? { writing: cached.summary } : {}),
                    ...(entry.researchEntryId ? { researchChanged: !entry.researchContentVersion
                        || entry.researchContentVersion !== libraryCatalog.entries.find(item => item.id === entry.researchEntryId)?.researchContentVersion } : {}) };
            })],
            limits: { maxFileBytes: ARTIFACT_LIMITS.maxFileBytes, maxEntries: ARTIFACT_LIMITS.maxEntries },
        };
    }
    async get(id) {
        const entry = this.#entry(id), bytes = await this.#read(entry);
        const detail = { ...summary(entry), downloadable: true };
        if (entry.encoding === "note") {
            detail.text = noteText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            detail.writing = summarizeWriting([{ text: detail.text, kind: "note" }]);
            this.#writing.set(entry.id, { payloadId: entry.payloadId, summary: detail.writing });
        }
        else if (entry.encoding === "visual") {
            try { detail.visual = validateVisual(JSON.parse(bytes.toString("utf8"))); }
            catch { throw fail("ARTIFACT_CORRUPT", "The saved visual payload is invalid."); }
            detail.previewMessage = "Caller-provided typed data and descriptive provenance, not certified execution evidence.";
        } else Object.assign(detail, filePreview(entry, bytes));
        return detail;
    }
    async noteVersion(id, versionId) {
        const entry = this.#entry(id), version = entry.versions?.find(item => item.payloadId === versionId);
        if (entry.kind !== "note" || !version) throw fail("CONTENT_HISTORY_NOT_FOUND", "Choose a prior version belonging to this managed note.");
        const bytes = await this.#read({ ...entry, ...version });
        return { id: versionId, field: "note", recordedAt: version.updatedAt,
            text: noteText(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
    }
    checkWriting(payload) {
        artifactObject(payload, ["expectedRevision", "ids"], ["expectedRevision", "ids"]);
        artifactRevision(payload.expectedRevision);
        if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 25 || new Set(payload.ids).size !== payload.ids.length)
            throw fail("INVALID_ARTIFACT", "Check one to 25 distinct managed Markdown notes at a time.");
        const ids = payload.ids.map(id => artifactId(id));
        return this.#serialize(async () => {
            this.#assertRevision(payload.expectedRevision);
            const entries = ids.map(id => this.#entry(id));
            if (entries.some(entry => entry.encoding !== "note"))
                throw fail("INVALID_ARTIFACT", "Only managed Markdown notes support local template checks. Imported files need their native viewer.");
            const reports = [];
            for (const entry of entries) {
                const bytes = await this.#read(entry);
                const text = noteText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                reports.push({ id: entry.id, payloadId: entry.payloadId, summary: summarizeWriting([{ text, kind: "note" }]) });
            }
            this.#assertRevision(payload.expectedRevision);
            for (const report of reports) this.#writing.set(report.id, { payloadId: report.payloadId, summary: report.summary });
            return { checkedCount: reports.length, reports: reports.map(({ id, summary }) => ({ id, writing: summary })), changed: false, shared: false };
        });
    }
    async content(id, inline = false) {
        const entry = this.#entry(id), bytes = await this.#read(entry), raster = inline ? rasterMime(bytes) : null;
        if (inline && !raster) throw fail("ARTIFACT_INLINE_UNSUPPORTED", "Inline content is restricted to validated PNG, JPEG, GIF and WebP raster images.");
        return { bytes, fileName: entry.fileName, mimeType: inline ? raster : "application/octet-stream", inline };
    }
    async #commit(entry, bytes, expectedRevision, beforeCommit) {
        this.#assertRevision(expectedRevision);
        const index = structuredClone(this.#index);
        const position = index.entries.findIndex(item => item.id === entry.id);
        if (position < 0) index.entries.push(metadata(entry)); else index.entries[position] = metadata(entry);
        index.revision++; boundedIndex(index);
        const owned = {};
        let committing = false;
        try {
            if (bytes) await this.#prepare(entry, bytes, owned);
            await beforeCommit?.();
            this.#assertRevision(expectedRevision);
            if (bytes) {
                await this.#safeDirectory();
                const prepared = await lstat(this.#file(entry.payloadId));
                if (!prepared.isFile() || prepared.isSymbolicLink() || prepared.nlink !== 1
                    || prepared.ino !== owned.ino || prepared.dev !== owned.dev || prepared.size !== bytes.length + HEADER)
                    throw fail("ARTIFACT_PATH_UNSAFE", "The generated payload changed before index publication.");
            }
            committing = true;
            await this.native.request("store.write", { key: this.indexKey, expectedRevision, value: index });
            // Metadata and revision publish only after the protected CAS succeeds.
            this.#index = index;
            return { id: entry.id, revision: index.revision };
        } catch (error) {
            if (committing && ["NATIVE_RESPONSE_TIMEOUT", "NATIVE_DISCONNECTED", "NATIVE_WRITE_FAILED", "NATIVE_UNAVAILABLE", "PROTOCOL_ERROR", "NATIVE_CLOSED"].includes(error.code)) {
                // A lost acknowledgement is not proof of a failed commit. Never
                // delete a payload that a successfully committed index may reference.
                try {
                    const saved = await this.native.request("store.read", { key: this.indexKey });
                    const recovered = restore(saved.value, saved.revision);
                    if (recovered.revision > expectedRevision && recovered.entries.some(item => item.id === entry.id && item.payloadId === entry.payloadId)) {
                        this.#index = recovered;
                        return { id: entry.id, revision: recovered.revision };
                    }
                } catch {
                    throw fail("ARTIFACT_COMMIT_UNCERTAIN", "The artifact save acknowledgement was lost. Its encrypted payload and any new folders were retained safely; reopen the workspace to reconcile the protected catalog before retrying.");
                }
            }
            if (bytes) await this.#removePrepared(entry.payloadId, owned);
            if (error.code === "STORE_CONFLICT") throw fail("REVISION_CONFLICT", "The saved artifact catalog changed in another process. Reload its catalog before saving.");
            throw error;
        }
    }
    create(value, library, beforeCommit) {
        const request = validateArtifactCreate(value, library);
        return this.#serialize(async () => {
            this.#assertRevision(request.expectedRevision);
            const bytes = Buffer.from(request.kind === "note" ? request.text : JSON.stringify(request.visual), "utf8");
            const entry = {
                id: `artifact:${randomUUID()}`, payloadId: randomUUID(), kind: request.kind, encoding: request.kind,
                collectionId: request.collectionId, title: request.title, description: request.description, updatedAt: new Date().toISOString(),
                byteLength: bytes.length, fileName: request.kind === "note" ? "note.md" : "visual.json",
                mimeType: request.kind === "note" ? "text/markdown; charset=utf-8" : "application/json",
                ...(request.researchEntryId === undefined ? {} : { researchEntryId: request.researchEntryId,
                    researchUpdatedAt: library.entries.find(entry => entry.id === request.researchEntryId).updatedAt,
                    researchContentVersion: researchContentVersion(library.entries.find(entry => entry.id === request.researchEntryId)) }),
                ...(request.session === undefined ? {} : { session: request.session }),
            };
            const result = await this.#commit(entry, bytes, request.expectedRevision, beforeCommit);
            if (request.kind === "note") this.#writing.set(entry.id, { payloadId: entry.payloadId, summary: summarizeWriting([{ text: request.text, kind: "note" }]) });
            return result;
        });
    }
    update(value, library, beforeCommit) {
        const request = validateArtifactUpdate(value, library);
        return this.#serialize(async () => {
            this.#assertRevision(request.expectedRevision);
            const entry = this.#entry(request.id);
            if (request.text !== undefined && entry.kind !== "note") throw fail("INVALID_ARTIFACT", "Only managed Markdown notes support text editing. Historical research uses existing library operations.");
            const bytes = request.text === undefined ? undefined : Buffer.from(request.text, "utf8");
            if (bytes) entry.versions = [{ payloadId: entry.payloadId, byteLength: entry.byteLength, updatedAt: entry.updatedAt }, ...(entry.versions ?? [])].slice(0, 20);
            for (const key of ["title", "description", "collectionId", "archived", "session"]) if (request[key] !== undefined) entry[key] = request[key];
            if (request.researchEntryId === null) { delete entry.researchEntryId; delete entry.researchUpdatedAt; delete entry.researchContentVersion; }
            else if (request.researchEntryId !== undefined && request.researchEntryId !== entry.researchEntryId) {
                entry.researchEntryId = request.researchEntryId;
                entry.researchUpdatedAt = library.entries.find(item => item.id === request.researchEntryId).updatedAt;
                entry.researchContentVersion = researchContentVersion(library.entries.find(item => item.id === request.researchEntryId));
            }
            if (bytes) { entry.payloadId = randomUUID(); entry.byteLength = bytes.length; }
            entry.updatedAt = new Date().toISOString();
            const result = await this.#commit(entry, bytes, request.expectedRevision, beforeCommit);
            if (request.text !== undefined) this.#writing.set(entry.id, { payloadId: entry.payloadId, summary: summarizeWriting([{ text: request.text, kind: "note" }]) });
            return result;
        });
    }
    upload({ collectionId, expectedRevision, name }, bytes, library, beforeCommit) {
        artifactRevision(expectedRevision); artifactCollection(library, collectionId); safeFileName(name);
        if (!Buffer.isBuffer(bytes) || bytes.length > ARTIFACT_LIMITS.maxFileBytes)
            throw fail("ARTIFACT_TOO_LARGE", "Upload at most 64 MiB per file.");
        const captured = Buffer.from(bytes);
        return this.#serialize(async () => {
            this.#assertRevision(expectedRevision);
            const entry = {
                id: `artifact:${randomUUID()}`, payloadId: randomUUID(), encoding: "file", ...classifyArtifact(name, captured),
                collectionId, title: name, description: "", fileName: name,
                updatedAt: new Date().toISOString(), byteLength: captured.length,
            };
            return this.#commit(entry, captured, expectedRevision, beforeCommit);
        });
    }
    async close() { await this.#queue; this.#key?.fill(0); this.#key = null; this.#ready = false; this.#writing.clear(); }
}
