export const MONTH_NAMES = Object.freeze([
    ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"], ["may"],
    ["june", "jun"], ["july", "jul"], ["august", "aug"], ["september", "sep", "sept"],
    ["october", "oct"], ["november", "nov"], ["december", "dec"],
]);

export function monthLabelKey(value) {
    if (typeof value !== "string") return null;
    const text = value.trim().toLowerCase();
    const iso = /^\d{4}-\d{2}$/.test(text);
    const yearText = iso ? text.slice(0, 4) : text.slice(-4);
    if (!/^\d{4}$/.test(yearText)) return null;
    const year = Number(yearText);
    const name = text.slice(0, -4).replaceAll(",", " ").trim();
    const month = iso ? Number(text.slice(-2)) : MONTH_NAMES.findIndex(names => names.includes(name)) + 1;
    return year >= 1900 && year <= 9999 && month >= 1 && month <= 12 ? year * 100 + month : null;
}

/** @param {{name: string, dataType?: string}} field
 * @returns {"asc" | "desc" | "month-asc" | "month-desc"} */
export function defaultFilterValueOrder(field) {
    if (/date|time/i.test(field.dataType ?? "")) return "desc";
    return /string|text|char/i.test(field.dataType ?? "") && /month/i.test(field.name) ? "month-desc" : "asc";
}

/** @param {{dataType?: string}} field */
export function filterValueOrderChoices(field) {
    const type = field.dataType ?? "";
    if (/date|time/i.test(type)) return [{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }];
    if (/int|decimal|currency|double|float|numeric|number|real/i.test(type))
        return [{ value: "asc", label: "Smallest first" }, { value: "desc", label: "Largest first" }];
    return [
        { value: "asc", label: /bool/i.test(type) ? "False first" : "A to Z" },
        { value: "desc", label: /bool/i.test(type) ? "True first" : "Z to A" },
        ...(/string|text|char/i.test(type) ? [{ value: "month-desc", label: "Newest month first" }, { value: "month-asc", label: "Oldest month first" }] : []),
    ];
}
