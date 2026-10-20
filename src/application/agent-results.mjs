import { fail, isCell, requireId } from "./policy.mjs";
import { DEFAULT_AGENT_RESULT_ROWS, MAX_AGENT_RESULT_ROWS, MAX_AGENT_RESULT_BYTES, resultReadProperties } from "../contracts/agent-results.mjs";

export function validateResultRead(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !Object.hasOwn(resultReadProperties, key)))
        throw fail("INVALID_RESULT_READ", "Provide the active document, connection, revision, run and result set.");
    const { documentId, connectionId, revision, runId, resultSetId, offset = 0, limit = DEFAULT_AGENT_RESULT_ROWS } = input;
    requireId(documentId); requireId(runId); requireId(resultSetId);
    if (typeof connectionId !== "string" || !connectionId.length || connectionId.length > 512
        || !Number.isSafeInteger(revision) || revision < 0
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_RESULT_ROWS)
        throw fail("INVALID_RESULT_READ", "Use current context and request 1 to 200 rows at a nonnegative offset.");
    return { documentId, connectionId, revision, runId, resultSetId, offset, limit };
}

export function boundedResultPage({ workbenchId, run, set, page, offset, limit }) {
    if (!Number.isSafeInteger(set.rowCount) || set.rowCount < 0 || offset > set.rowCount
        || page.offset !== offset || page.total !== set.rowCount || !Array.isArray(page.rows)
        || page.rows.length > Math.min(limit, set.rowCount - offset)
        || (offset < set.rowCount && page.rows.length === 0))
        throw fail("RESULT_PROTOCOL_MISMATCH", "The retained page does not match the completed result metadata.");
    const reply = {
        workbenchId, runId: run.id, resultSetId: set.id,
        documentId: run.documentId, connectionId: run.connectionId,
        queryRevision: run.revision, querySource: run.querySource ?? "editor",
        builderRevision: run.builderRevision ?? null, startedAt: run.startedAt,
        columns: set.columns.map(({ id, name, dataType, formatString }) => ({
            id, name, dataType, ...(typeof formatString === "string" ? { formatString } : {}),
        })),
        rows: [], offset, totalRows: set.rowCount, returnedRowCount: 0,
        nextOffset: null, hasMore: false, pageLimitedByBytes: page.rows.length < Math.min(limit, set.rowCount - offset),
        queryTruncated: Boolean(run.truncated || set.truncated),
        warningsPresent: Boolean(run.warnings?.length),
        maxPageRows: MAX_AGENT_RESULT_ROWS, maxPageBytes: MAX_AGENT_RESULT_BYTES,
    };
    // Reserve the longest counters/flags so each row is serialized only once.
    let bytes = Buffer.byteLength(JSON.stringify({
        ...reply, returnedRowCount: MAX_AGENT_RESULT_ROWS, nextOffset: Number.MAX_SAFE_INTEGER, pageLimitedByBytes: false,
    }), "utf8");
    if (bytes > MAX_AGENT_RESULT_BYTES)
        throw fail("RESULT_PAGE_TOO_WIDE", "The column metadata exceeds the analysis page limit. Query fewer columns.");
    for (const row of page.rows) {
        if (!Array.isArray(row) || row.length !== set.columns.length || row.some(cell => !isCell(cell)))
            throw fail("RESULT_PROTOCOL_MISMATCH", "A retained row has an invalid shape or value.");
        const size = Buffer.byteLength(JSON.stringify(row), "utf8") + (reply.rows.length ? 1 : 0);
        if (bytes + size > MAX_AGENT_RESULT_BYTES) {
            if (!reply.rows.length)
                throw fail("RESULT_ROW_TOO_LARGE", "One row exceeds the 64 KiB analysis limit. Query a smaller projection or aggregate.");
            reply.pageLimitedByBytes = true;
            break;
        }
        bytes += size;
        reply.rows.push(row);
    }
    reply.returnedRowCount = reply.rows.length;
    reply.hasMore = offset + reply.rows.length < set.rowCount;
    reply.nextOffset = reply.hasMore ? offset + reply.rows.length : null;
    return reply;
}
