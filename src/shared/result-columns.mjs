// @ts-check

/** @param {string} name */
export function shortColumnName(name) {
    const match = /^(?:'(?:[^']|'')+'|[^\[\]']+)?\[((?:[^\]]|\]\])+)\]$/.exec(name);
    return match ? match[1].replaceAll("]]", "]") : name;
}

/**
 * Captions are presentation only; IDs, source names and values remain unchanged.
 * @param {{name: string}[]} columns
 * @param {boolean} fullNames
 */
export function resultColumnLabels(columns, fullNames = false) {
    const names = columns.map(column => fullNames ? column.name : shortColumnName(column.name));
    const counts = new Map();
    for (const name of names) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
    const candidates = names.map((name, index) => counts.get(name.toLowerCase()) > 1 ? columns[index].name : name);
    const reserved = new Set(candidates.map(name => name.toLowerCase())), used = new Set();
    return candidates.map(candidate => {
        const base = candidate || "Column";
        let label = base, suffix = 2;
        while (used.has(label.toLowerCase()) || label !== candidate && reserved.has(label.toLowerCase()))
            label = `${base} (${suffix++})`;
        used.add(label.toLowerCase());
        return label;
    });
}

/** @param {{id: string, name: string}[]} columns */
export function resultColumnLabelMap(columns) {
    const labels = resultColumnLabels(columns);
    return new Map(columns.map((column, index) => [column.id, labels[index]]));
}
