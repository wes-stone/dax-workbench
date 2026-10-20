/**
 * Display only: never parse through Date, change time zones, or round source precision.
 * @param {import("../contracts/workbench").Cell | undefined} value
 * @param {string} [dataType]
 */
export function resultValueText(value, dataType) {
    const original = String(value);
    if (typeof value !== "string" || !/^(?:Date|DateTime|DateTimeOffset)$/i.test(dataType ?? "")) return original;
    const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,7}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(value);
    if (!match) return original;
    const [, year, month, day, hour, minute, second, fraction = "", zone = ""] = match;
    const y = Number(year), m = Number(month), d = Number(day);
    const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return original;
    const date = `${year}-${month}-${day}`, significant = fraction.replace(/0+$/, "");
    if (!zone && hour === "00" && minute === "00" && second === "00" && !significant) return date;
    return `${date} ${hour}:${minute}:${second}${significant ? `.${significant}` : ""}${zone}`;
}
