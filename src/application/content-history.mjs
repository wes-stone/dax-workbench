import { createHash, randomUUID } from "node:crypto";
import { fail, requireId } from "./policy.mjs";

const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
function historyCatalog(saved) {
    const catalog = saved.value === null && saved.revision === 0 ? { version: 1, records: [] } : saved.value;
    if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.records) || Object.keys(catalog).some(key => !["version", "records"].includes(key))
        || catalog.records.length > 4000 || new Set(catalog.records.map(record => record?.id)).size !== catalog.records.length
        || catalog.records.some(record => !record || typeof record.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.id)
            || Object.keys(record).some(key => !["id", "bytes", "digest"].includes(key))
            || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > 80 * 1024
            || typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest))
        || catalog.records.reduce((sum, record) => sum + record.bytes, 0) > 64 * 1024 * 1024)
        throw fail("CONTENT_HISTORY_CORRUPT", "Content history metadata is invalid; no content was replaced.");
    return catalog;
}
export function contentHistoryReferences(value) {
    if (!Array.isArray(value) || value.length > 20 || new Set(value.map(item => item?.id)).size !== value.length)
        throw fail("CONTENT_HISTORY_CORRUPT", "Invalid content history references.");
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw fail("CONTENT_HISTORY_CORRUPT", "Invalid content history reference.");
        requireId(item.id);
        if (!["documentation", "analysis"].includes(item.field) || Object.keys(item).some(key => !["id", "field"].includes(key)))
            throw fail("CONTENT_HISTORY_CORRUPT", "Invalid content history field.");
    }
    return structuredClone(value);
}
export class ContentHistory {
    constructor(native, id) { this.native = native; this.key = `content-history:${id}`; }
    async write(key, expectedRevision, value) {
        try { return await this.native.request("store.write", { key, expectedRevision, value }); }
        catch (error) {
            if (["NATIVE_RESPONSE_TIMEOUT", "NATIVE_DISCONNECTED", "NATIVE_WRITE_FAILED", "NATIVE_UNAVAILABLE", "PROTOCOL_ERROR", "NATIVE_CLOSED"].includes(error.code)) {
                let saved;
                try { saved = await this.native.request("store.read", { key }); }
                catch { throw fail("CONTENT_COMMIT_UNCERTAIN", "Content history could not be reconciled. Original content was retained; reopen before retrying."); }
                if (saved.revision === expectedRevision + 1 && fingerprint(saved.value) === fingerprint(value)) return { revision: saved.revision };
                throw fail("CONTENT_COMMIT_UNCERTAIN", "Content history acknowledgement is uncertain. Reopen before retrying.");
            }
            throw error;
        }
    }
    async prepare(previous, next) {
        const changes = [];
        for (const entry of next.entries) {
            const old = previous.entries.find(item => item.id === entry.id);
            if (!old) continue;
            entry.contentHistory = structuredClone(old.contentHistory ?? []);
            for (const field of ["documentation", "analysis"]) {
                const text = field === "analysis" ? old.analysis?.content : old.documentation;
                const replacement = field === "analysis" ? entry.analysis?.content : entry.documentation;
                if (text === undefined || replacement === undefined || text === replacement) continue;
                const record = { version: 1, id: randomUUID(), entryId: entry.id, field, text, recordedAt: new Date().toISOString() };
                changes.push(record);
                entry.contentHistory = [{ id: record.id, field }, ...entry.contentHistory].slice(0, 20);
            }
            if (!entry.contentHistory.length) delete entry.contentHistory;
        }
        if (!changes.length) return;
        const saved = await this.native.request("store.read", { key: this.key });
        const catalog = historyCatalog(saved);
        const additions = changes.map(record => ({ id: record.id, bytes: bytes(record), digest: fingerprint(record) }));
        const records = [...catalog.records, ...additions];
        if (records.length > 4000 || records.reduce((sum, record) => sum + record.bytes, 0) > 64 * 1024 * 1024)
            throw fail("CONTENT_HISTORY_LIMIT", "Protected content history reached 4,000 revisions or 64 MiB. Content was not replaced.");
        await this.write(this.key, saved.revision, { version: 1, records });
        for (const record of changes) await this.write(`${this.key}:${record.id}`, 0, record);
        return true;
    }
    async read(entry, id) {
        if (!entry.contentHistory?.some(item => item.id === id)) throw fail("CONTENT_HISTORY_NOT_FOUND", "Choose a published revision belonging to this artifact.");
        requireId(id);
        const [catalog, saved] = await Promise.all([
            this.native.request("store.read", { key: this.key }),
            this.native.request("store.read", { key: `${this.key}:${id}` }),
        ]);
        const descriptor = historyCatalog(catalog).records.find(item => item.id === id), value = saved.value;
        if (!descriptor || !value || value.entryId !== entry.id || value.id !== id || value.version !== 1
            || value.field !== entry.contentHistory.find(item => item.id === id).field
            || typeof value.text !== "string" || value.text.length > 16384 || fingerprint(value) !== descriptor.digest
            || bytes(value) !== descriptor.bytes || typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt))
            || Object.keys(value).some(key => !["version", "id", "entryId", "field", "text", "recordedAt"].includes(key)))
            throw fail("CONTENT_HISTORY_CORRUPT", "This protected revision could not be verified. Nothing was replaced.");
        return structuredClone(value);
    }
}
