import { decimalAdd, decimalCompare } from "./result-analysis.mjs";
import { isNumeric } from "./result-numbers.mjs";

export function validateAssertions(rules) {
    if (!Array.isArray(rules) || rules.length > 20) throw new Error("Choose at most twenty result assertions.");
    const ids = new Set();
    for (const rule of rules) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)
            || Object.keys(rule).some(key => !["id", "type", "columnId", "min", "max", "expectedType"].includes(key))
            || typeof rule.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id)
            || !["row-count", "non-null", "unique", "sum-range", "schema-type"].includes(rule.type))
            throw new Error("Use distinct, supported result assertion definitions.");
        ids.add(rule.id);
        if (rule.type !== "row-count" && (typeof rule.columnId !== "string" || !rule.columnId || rule.columnId.length > 512))
            throw new Error("Choose a column for this assertion.");
        if (["row-count", "sum-range"].includes(rule.type)) {
            if (rule.min === undefined && rule.max === undefined) throw new Error("An assertion range needs at least one bound.");
            for (const value of [rule.min, rule.max].filter(value => value !== undefined)) {
                if (typeof value !== "string" || value.length > 1000) throw new Error("Use exact numeric strings for assertion bounds.");
                if (rule.type === "row-count" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))
                    throw new Error("Row-count bounds must be nonnegative safe integers.");
                decimalCompare(value, "0");
            }
            if (rule.min !== undefined && rule.max !== undefined && decimalCompare(rule.min, rule.max) > 0)
                throw new Error("The assertion minimum cannot exceed its maximum.");
        } else if (rule.min !== undefined || rule.max !== undefined) throw new Error("Only count and sum ranges accept bounds.");
        if (rule.type === "schema-type" && (typeof rule.expectedType !== "string" || !/^[A-Za-z0-9_. ]{1,80}$/.test(rule.expectedType)))
            throw new Error("Supply the exact expected provider column type.");
        if (rule.type !== "schema-type" && rule.expectedType !== undefined) throw new Error("Only a schema-type assertion accepts an expected type.");
    }
    return structuredClone(rules);
}

export async function evaluateAssertions(data, rules, complete, signal) {
    validateAssertions(rules);
    if (typeof complete !== "boolean") throw new Error("Declare whether the captured result is complete.");
    const results = [];
    for (const rule of rules) {
        signal?.throwIfAborted();
        if (!complete) {
            results.push({ id: rule.id, status: "not-evaluated", message: "The source is partial or capped; no full-result assertion was made." }); continue;
        }
        const column = data.columns.find(column => column.id === rule.columnId), ci = data.columns.findIndex(column => column.id === rule.columnId);
        let actual, message;
        if (rule.type !== "row-count" && !column) {
            results.push({ id: rule.id, status: "failed", message: "The specified column is absent from this capture." }); continue;
        }
        if (rule.type === "schema-type") {
            actual = column.dataType;
            results.push({ id: rule.id, status: actual === rule.expectedType ? "passed" : "failed", actual, message: "Exact provider-reported column type." }); continue;
        }
        if (rule.type === "row-count") { actual = String(data.rows.length); message = "Total rows in the complete captured result."; }
        else {
            let count = 0, total = "0", nonnull = 0;
            const seen = new Set();
            if (rule.type === "sum-range" && !isNumeric(column)) {
                results.push({ id: rule.id, status: "failed", message: "A sum assertion requires a numeric provider column." }); continue;
            }
            for (let i = 0; i < data.rows.length; i++) {
                if (i % 512 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted(); }
                const value = data.rows[i][ci];
                if (rule.type === "non-null" && value === null) count++;
                if (rule.type === "unique") {
                    const key = isNumeric(column) && value !== null ? decimalAdd(value, "0") : JSON.stringify(value);
                    if (seen.has(key)) count++; else seen.add(key);
                }
                if (rule.type === "sum-range" && value !== null) { total = decimalAdd(total, value); nonnull++; }
            }
            if (rule.type === "sum-range" && !nonnull) {
                results.push({ id: rule.id, status: "failed", message: "No non-null numeric values; an empty sum was not treated as zero." }); continue;
            }
            actual = rule.type === "sum-range" ? total : String(count);
            message = rule.type === "sum-range" ? "Exact sum of returned numeric rows; additivity is the author's responsibility."
                : rule.type === "unique" ? "Duplicate values beyond their first occurrence; repeated nulls count." : "Null values; empty strings are not null.";
        }
        const passed = ["row-count", "sum-range"].includes(rule.type)
            ? (rule.min === undefined || decimalCompare(actual, rule.min) >= 0) && (rule.max === undefined || decimalCompare(actual, rule.max) <= 0)
            : actual === "0";
        results.push({ id: rule.id, status: passed ? "passed" : "failed", actual, message });
    }
    return { version: 1, rules: structuredClone(rules), status: results.some(result => result.status === "not-evaluated") ? "not-evaluated"
        : results.some(result => result.status === "failed") ? "failed" : "passed", results };
}
