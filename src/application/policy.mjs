import { MAX_LIMITS } from "../contracts/limits.mjs";
import { validateReadQuery } from "../engine/builder-core.mjs";
export { DEFAULT_LIMITS, MAX_LIMITS } from "../contracts/limits.mjs";
export const ACTIVE_STATUSES = new Set(["queued", "connecting", "executing", "streaming", "cancelling"]);
export function fail(code, message) {
    return Object.assign(new Error(message), { code });
}
export function requireId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw fail("INVALID_ID", "Invalid document identifier.");
    return value;
}
export function validateLimits(value) {
    for (const [key, min] of [["timeoutSeconds", 1], ["maxRows", 1], ["maxBytes", 1024]]) {
        const max = MAX_LIMITS[key];
        if (!Number.isInteger(value?.[key]) || value[key] < min || value[key] > max) throw fail("INVALID_LIMITS", `${key} must be an integer between ${min} and ${max}.`);
    }
    return { timeoutSeconds: value.timeoutSeconds, maxRows: value.maxRows, maxBytes: value.maxBytes };
}
export function validateParameters(value, allowLists = false) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 50) throw fail("INVALID_PARAMETERS", "Parameters must be an object with at most 50 named values.");
    for (const [key, cell] of Object.entries(value)) {
        const valid = isCell(cell) || (allowLists && Array.isArray(cell) && cell.length <= 1000 && cell.every(item => typeof item === "string" && item.length <= 10_000));
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key) || !valid || (typeof cell === "string" && cell.length > 10_000)) throw fail("INVALID_PARAMETERS", "Parameters must be named primitive values, or text lists for a typed query template.");
    }
    return value;
}
export function isCell(value) {
    return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}
export function validateQuery(query) {
    return validateReadQuery(query);
}
export function safeError(error) {
    return { code: typeof error?.code === "string" ? error.code : "WORKBENCH_ERROR", message: error instanceof Error ? error.message : "The operation failed." };
}
