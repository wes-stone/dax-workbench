import { decimalParts, isNumeric, isVariant } from "./result-numbers.mjs";

const MAX_DIGITS = 1000;
const typedKey = value => JSON.stringify(value);
function decimal(value) {
    if (value === null || typeof value === "boolean") throw new Error("An exact numeric value is required.");
    if (String(value).length > MAX_DIGITS + 24) throw new Error("Exact arithmetic supports at most 1,000 digits.");
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
        throw new Error("A numeric cell is outside JavaScript's safe integer range. Return exact numeric strings from the provider.");
    const parts = decimalParts(value);
    if (!parts) throw new Error("A numeric cell is not a finite decimal.");
    const power = parts.zero ? 0n : parts.magnitude - BigInt(parts.digits.length);
    if (parts.digits.length > MAX_DIGITS || power < -MAX_DIGITS || power > MAX_DIGITS)
        throw new Error("Exact arithmetic supports at most 1,000 digits.");
    return { value: parts.zero ? 0n : BigInt(parts.digits) * (parts.negative ? -1n : 1n), power: Number(power) };
}
function format({ value, power }) {
    if (!value) return "0";
    let digits = (value < 0n ? -value : value).toString();
    if (digits.length + Math.max(power, 0) > MAX_DIGITS) throw new Error("Exact arithmetic supports at most 1,000 digits.");
    if (power >= 0) digits += "0".repeat(power);
    else {
        digits = digits.padStart(1 - power, "0");
        digits = `${digits.slice(0, power)}.${digits.slice(power)}`.replace(/0+$/, "").replace(/\.$/, "");
    }
    return (value < 0n ? "-" : "") + digits;
}
export function decimalAdd(left, right, subtract = false) {
    const a = decimal(left), b = decimal(right), power = Math.min(a.power, b.power);
    if (Math.max(a.power - power, b.power - power) > MAX_DIGITS) throw new Error("Exact arithmetic supports at most 1,000 digits.");
    return format({ value: a.value * 10n ** BigInt(a.power - power) + b.value * 10n ** BigInt(b.power - power) * (subtract ? -1n : 1n), power });
}
export function decimalCompare(left, right) {
    const difference = decimalAdd(left, right, true);
    return difference === "0" ? 0 : difference.startsWith("-") ? -1 : 1;
}
export function decimalDivide(value, divisor, places = 12) {
    if (!Number.isSafeInteger(divisor) || divisor < 1 || !Number.isInteger(places) || places < 0 || places > 12)
        throw new Error("Exact division requires a positive integer divisor and 0-12 decimal places.");
    const a = decimal(value), shift = a.power + places;
    const numerator = a.value * (shift > 0 ? 10n ** BigInt(shift) : 1n);
    const denominator = BigInt(divisor) * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
    let quotient = numerator / denominator;
    const remainder = numerator % denominator;
    if ((remainder < 0n ? -remainder : remainder) * 2n >= denominator) quotient += numerator < 0n ? -1n : 1n;
    return format({ value: quotient, power: -places });
}
const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));
function validate(data) {
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows) || data.rows.length > 100000 || data.columns.length > 64)
        throw new Error("Local analysis supports up to 100,000 rows and 64 columns. Refine the query; no data is sampled.");
    if (data.rows.some(row => !Array.isArray(row) || row.length !== data.columns.length))
        throw new Error("The captured result has inconsistent row widths.");
    if (data.rows.some(row => row.some(cell => cell !== null && !["number", "string", "boolean"].includes(typeof cell)
        || typeof cell === "number" && !Number.isFinite(cell))))
        throw new Error("The captured result contains an invalid cell.");
}
export function numericColumn(data, columnId) {
    const index = data.columns.findIndex(column => column.id === columnId), column = data.columns[index];
    if (!column) return { numeric: false, inferred: false, empty: false, reason: "Choose an existing value field." };
    if (isNumeric(column)) return { numeric: true, inferred: false, empty: false, reason: "" };
    if (!isVariant(column))
        return { numeric: false, inferred: false, empty: false, reason: "" };
    let found = false;
    for (let i = 0; i < data.rows.length; i++) {
        const value = data.rows[i][index];
        if (value === null) continue;
        try { decimal(value); }
        catch (error) {
            return { numeric: false, inferred: false, empty: false,
                reason: `${column.name} has a nonnumeric or unsafe value at captured row ${i + 1}. ${error.message} Use None or Count, or return a numeric measure in DAX.` };
        }
        found = true;
    }
    return { numeric: found, inferred: found, empty: !found,
        reason: found ? `Provider type: ${column.dataType}. Numeric interpretation is validated against every non-null captured value, not model metadata.`
            : "Only null values were captured; a numeric type cannot be inferred. Sum keeps these cells null." };
}
export async function profileResult(data, columnId, signal) {
    validate(data);
    const index = data.columns.findIndex(column => column.id === columnId);
    if (index < 0) throw new Error("Choose an existing profile column.");
    await yieldControl(); signal?.throwIfAborted();
    const column = data.columns[index], interpretation = numericColumn(data, columnId), { numeric } = interpretation, counts = new Map(), rowKeys = new Set();
    let nulls = 0, emptyStrings = 0, duplicates = 0, minimum = null, maximum = null, total = "0", numericCount = 0;
    for (let i = 0; i < data.rows.length; i++) {
        if (i % 512 === 0) { await yieldControl(); signal?.throwIfAborted(); }
        const row = data.rows[i], value = row[index], key = typedKey(value), rowKey = typedKey(row);
        if (rowKeys.has(rowKey)) duplicates++; else rowKeys.add(rowKey);
        const count = counts.get(key) ?? { value, count: 0 }; count.count++; counts.set(key, count);
        if (value === null) nulls++;
        else if (value === "") emptyStrings++;
        if (numeric && value !== null) {
            decimal(value);
            if (minimum === null || decimalCompare(value, minimum) < 0) minimum = value;
            if (maximum === null || decimalCompare(value, maximum) > 0) maximum = value;
            total = decimalAdd(total, value); numericCount++;
        }
    }
    return { rowCount: data.rows.length, column, numeric, inferredNumeric: interpretation.inferred, numericReason: interpretation.reason,
        nulls, emptyStrings, distinct: counts.size, duplicateRows: duplicates,
        minimum, maximum, sum: numericCount ? total : null,
        frequencies: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 20),
        omittedDistinct: Math.max(0, counts.size - 20) };
}
export async function compareKeyed(left, right, keys, signal) {
    validate(left); validate(right);
    if (left.rows.length > 20000 || right.rows.length > 20000) throw new Error("Keyed comparison supports 20,000 complete rows per side. Refine the queries; rows are never sampled.");
    if (!Array.isArray(keys) || !keys.length || keys.length > 8 || new Set(keys).size !== keys.length)
        throw new Error("Choose one to eight distinct business key columns.");
    const names = data => data.columns.map(column => column.name);
    if (new Set(names(left)).size !== left.columns.length || new Set(names(right)).size !== right.columns.length)
        throw new Error("Comparison requires unique column names. Alias duplicate names in the query.");
    const indices = keys.map(name => {
        const l = left.columns.findIndex(column => column.name === name), r = right.columns.findIndex(column => column.name === name);
        if (l < 0 || r < 0 || left.columns[l].dataType !== right.columns[r].dataType) throw new Error(`Key column ${name} must exist with the same type on both sides.`);
        return [l, r];
    });
    const index = async (data, side) => {
        const map = new Map();
        for (let i = 0; i < data.rows.length; i++) {
            if (i % 512 === 0) { await yieldControl(); signal?.throwIfAborted(); }
            const row = data.rows[i], values = indices.map(pair => row[pair[side]]);
            if (values.some(value => value === null)) throw new Error(`${side ? "Comparison" : "Baseline"} has a null business key at row ${i + 1}. Choose complete keys.`);
            const key = typedKey(values.map((value, index) => isNumeric(data.columns[indices[index][side]]) ? format(decimal(value)) : value));
            if (map.has(key)) throw new Error(`${side ? "Comparison" : "Baseline"} has duplicate business keys. Add key columns; no many-to-many pairing was inferred.`);
            map.set(key, { row, values });
        }
        return map;
    };
    const a = await index(left, 0), b = await index(right, 1);
    const columns = [...new Set([...names(left), ...names(right)])].filter(name => !keys.includes(name));
    const fields = columns.map(name => ({ name, l: names(left).indexOf(name), r: names(right).indexOf(name) }));
    const changes = []; let unchanged = 0, added = 0, removed = 0, changed = 0, visited = 0;
    for (const key of new Set([...a.keys(), ...b.keys()])) {
        if (++visited % 512 === 0) { await yieldControl(); signal?.throwIfAborted(); }
        const previous = a.get(key), current = b.get(key);
        const cells = fields.flatMap(field => {
            const before = previous && field.l >= 0 ? previous.row[field.l] : undefined;
            const after = current && field.r >= 0 ? current.row[field.r] : undefined;
            const numeric = field.l >= 0 && field.r >= 0 && isNumeric(left.columns[field.l]) && isNumeric(right.columns[field.r]);
            const sameType = field.l >= 0 && field.r >= 0 && left.columns[field.l].dataType === right.columns[field.r].dataType;
            const same = sameType && (numeric && before !== null && after !== null && before !== undefined && after !== undefined
                ? decimalCompare(before, after) === 0 : typedKey(before) === typedKey(after));
            if (previous && current && same) return [];
            return [{ column: field.name, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }),
                ...(numeric && before !== undefined && after !== undefined && before !== null && after !== null ? { delta: decimalAdd(after, before, true) } : {}) }];
        });
        const status = !previous ? "added" : !current ? "removed" : cells.length ? "changed" : "unchanged";
        if (status === "unchanged") { unchanged++; continue; }
        if (status === "added") added++; else if (status === "removed") removed++; else changed++;
        changes.push({ keys: (current ?? previous).values, status, cells });
    }
    return { added, removed, changed, unchanged, changes, keys,
        addedColumns: names(right).filter(name => !names(left).includes(name)), removedColumns: names(left).filter(name => !names(right).includes(name)) };
}
export function matrixResult(data, rowId, columnId, valueId, aggregation) {
    validate(data);
    if (data.rows.length > 20000) throw new Error("Matrices support up to 20,000 retrieved rows. Refine the query; rows are never sampled.");
    const ri = data.columns.findIndex(column => column.id === rowId), ci = data.columns.findIndex(column => column.id === columnId);
    const vi = data.columns.findIndex(column => column.id === valueId);
    if (ri < 0 || ci < 0 || ri === ci || vi < 0 || !["none", "sum", "count"].includes(aggregation))
        throw new Error("Choose distinct row/column dimensions, a value field and an explicit aggregation.");
    if (aggregation === "sum") {
        const interpretation = numericColumn(data, valueId);
        if (!interpretation.numeric && !interpretation.empty)
            throw new Error(interpretation.reason || `Sum requires a numeric value field. ${data.columns[vi].name} is ${data.columns[vi].dataType}; choose a numeric field or Count retrieved rows.`);
    }
    const rows = new Map(), columns = new Map(), cells = new Map();
    for (const row of data.rows) {
        const r = typedKey(row[ri]), c = typedKey(row[ci]), key = typedKey([r, c]);
        rows.set(r, row[ri]); columns.set(c, row[ci]);
        if (rows.size * columns.size > 5000) throw new Error("The matrix exceeds 5,000 cells. Refine dimensions; no cells were sampled.");
        if (aggregation === "none" && cells.has(key)) throw new Error("Multiple rows map to a matrix cell. Explicitly choose sum/count, or use a finer grain.");
        const value = row[vi];
        cells.set(key, aggregation === "count" ? (cells.get(key) ?? 0) + 1
            : aggregation === "sum" ? value === null ? cells.get(key) ?? null : decimalAdd(cells.get(key) ?? "0", value) : value);
    }
    return { columns: [...columns.values()], rows: [...rows].map(([key, value]) => ({
        label: value, values: [...columns.keys()].map(column => cells.has(typedKey([key, column])) ? cells.get(typedKey([key, column])) : undefined),
    })) };
}
