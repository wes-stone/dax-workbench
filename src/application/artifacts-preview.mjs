import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { artifactText } from "./artifacts-validation.mjs";

const PREVIEW_BYTES = 192 * 1024, XML_BYTES = 1024 * 1024, XML_TOTAL = 4 * 1024 * 1024;
const dimensions = (width, height) => width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40_000_000;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};
export function safeFileName(value) {
    artifactText(value, "File name", 180);
    if (/[\\/:*?"<>|]/u.test(value) || value === "." || value === ".." || /[. ]$/.test(value))
        throw Object.assign(new Error("File names cannot contain paths or reserved characters."), { code: "INVALID_ARTIFACT" });
    return value;
}
// Raster formats are checked structurally, never inferred from client MIME or extension.
export function rasterMime(bytes) {
    try {
        if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            let offset = 8, data = false, chunks = 0;
            while (offset + 12 <= bytes.length && ++chunks < 100000) {
                const length = bytes.readUInt32BE(offset), end = offset + length + 12, type = bytes.toString("ascii", offset + 4, offset + 8);
                if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return null;
                if (offset === 8) {
                    if (type !== "IHDR" || length !== 13 || !dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12))) return null;
                    const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
                    if (!depths[bytes[offset + 17]]?.includes(bytes[offset + 16]) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return null;
                } else if (type === "IHDR") return null;
                if (type === "IDAT" && length > 0) data = true;
                if (type === "IEND") return length === 0 && end === bytes.length && data ? "image/png" : null;
                offset = end;
            }
        }
        if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
            let offset = 2, validFrame = false;
            while (offset < bytes.length - 2) {
                if (bytes[offset++] !== 255) return null;
                while (bytes[offset] === 255) offset++;
                const marker = bytes[offset++];
                if (marker === 0xd9) break;
                if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
                const length = bytes.readUInt16BE(offset);
                if (length < 2 || offset + length > bytes.length) return null;
                if ([0xc0, 0xc1, 0xc2].includes(marker)) {
                    if (length < 8 || !dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return null;
                    validFrame = true;
                }
                offset += length;
                if (marker === 0xda) {
                    if (!validFrame || offset >= bytes.length - 2) return null;
                    while (offset < bytes.length - 2) {
                        if (bytes[offset] !== 255) { offset++; continue; }
                        if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) { offset += 2; continue; }
                        break;
                    }
                }
            }
            return validFrame && offset >= bytes.length - 2 ? "image/jpeg" : null;
        }
        if (bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) && dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) {
            let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), image = false, frames = 0, pixels = 0;
            while (offset < bytes.length) {
                const type = bytes[offset++];
                if (type === 0x3b) return image && offset === bytes.length ? "image/gif" : null;
                if (type === 0x21) offset++;
                else if (type === 0x2c) {
                    if (offset + 9 >= bytes.length || !dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6))) return null;
                    pixels += bytes.readUInt16LE(offset + 4) * bytes.readUInt16LE(offset + 6);
                    if (++frames > 200 || pixels > 100_000_000) return null;
                    const flags = bytes[offset + 8]; offset += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
                    if (bytes[offset] < 2 || bytes[offset] > 8) return null;
                    offset++; image = true;
                } else return null;
                let size;
                do { if (offset >= bytes.length) return null; size = bytes[offset++]; offset += size; } while (size);
            }
        }
        if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
            && bytes.readUInt32LE(4) === bytes.length - 8) {
            let offset = 12, valid = false, canvas = null, image = null;
            while (offset + 8 <= bytes.length) {
                const type = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), data = offset + 8;
                if (data + length > bytes.length) return null;
                if (type === "VP8X") {
                    if (offset !== 12 || length !== 10 || bytes[data] & 2) return null;
                    canvas = [bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1];
                    if (!dimensions(...canvas)) return null;
                }
                if (type === "VP8 " && length >= 10 && bytes.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
                    if (image) return null;
                    image = [bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff];
                    valid = dimensions(...image);
                }
                if (type === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
                    if (image) return null;
                    const bits = bytes.readUInt32LE(data + 1);
                    image = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]; valid = dimensions(...image);
                }
                offset = data + length + (length & 1);
            }
            return offset === bytes.length && valid && (!canvas || canvas.every((value, index) => value === image[index])) ? "image/webp" : null;
        }
    } catch { return null; }
    return null;
}
const officeTypes = {
    ".pptx": ["presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ".docx": ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ".xlsx": ["spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};
const textExtensions = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".log", ".dax", ".kql", ".sql", ".py", ".js", ".ts", ".css", ".html", ".svg", ".r"]);
export function classifyArtifact(name, bytes) {
    const raster = rasterMime(bytes);
    if (raster) return { kind: "image", mimeType: raster };
    const extension = path.extname(name).toLowerCase();
    if (officeTypes[extension] && bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
        const [kind, mimeType] = officeTypes[extension]; return { kind, mimeType };
    }
    if (extension === ".pdf" && bytes.toString("ascii", 0, 5) === "%PDF-") return { kind: "pdf", mimeType: "application/pdf" };
    if (textExtensions.has(extension)) return { kind: "text", mimeType: "text/plain; charset=utf-8" };
    return { kind: "file", mimeType: "application/octet-stream" };
}
function utf8(bytes) {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error("Not safe plain text.");
    return value;
}
function xmlText(bytes, prefix) {
    const xml = utf8(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("XML declarations are not previewed.");
    const output = [];
    for (const match of xml.matchAll(new RegExp(`<${prefix}:t(?:\\s[^<>]*?)?>([^<]*)<\\/${prefix}:t>|<\\/${prefix}:p>`, "g"))) {
        if (match[1] === undefined) { output.push("\n"); continue; }
        output.push(match[1].replace(/&([^;]{1,16});/g, (_, entity) => {
            const predefined = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
            if (Object.hasOwn(predefined, entity)) return predefined[entity];
            if (!/^#(?:[0-9]+|x[a-f0-9]+)$/i.test(entity)) throw new Error("Unknown XML entity.");
            const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10ffff || (point < 32 && ![9, 10, 13].includes(point))
                || point === 127 || (point >= 0xd800 && point <= 0xdfff)) throw new Error("Invalid XML entity.");
            return String.fromCodePoint(point);
        }));
    }
    return output.join("").trim();
}
// Central-directory bounds plus zlib's hard output cap prevent ZIP bombs. Only
// known slide/document XML is decompressed; links, media, macros and relationships are never opened.
function officeParts(bytes, kind) {
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--)
        if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error("Unsupported ZIP.");
    const count = bytes.readUInt16LE(end + 10), directory = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
    if (count > 2000 || count !== bytes.readUInt16LE(end + 8) || directory + size !== end) throw new Error("ZIP directory limit.");
    let offset = directory, total = 0, expanded = 0;
    const selected = [], names = new Set(), ranges = [];
    for (let index = 0; index < count; index++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory.");
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16),
            packed = bytes.readUInt32LE(offset + 20), unpacked = bytes.readUInt32LE(offset + 24),
            nameSize = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32),
            local = bytes.readUInt32LE(offset + 42);
        const next = offset + 46 + nameSize + extra + comment;
        if (next > end || flags & 1 || bytes.readUInt16LE(offset + 34) || packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff)
            throw new Error("Encrypted or ZIP64 files are not previewed.");
        const name = utf8(bytes.subarray(offset + 46, offset + 46 + nameSize));
        if (names.has(name) || /\\|^\/|(?:^|\/)\.\.(?:\/|$)/.test(name)) throw new Error("Unsafe ZIP name.");
        names.add(name); total += unpacked;
        if (total > 128 * 1024 * 1024) throw new Error("ZIP expansion limit.");
        const match = kind === "presentation" ? /^ppt\/slides\/slide([1-9][0-9]{0,3})\.xml$/.exec(name) : name === "word/document.xml";
        if (match) {
            if (selected.length >= 200 || unpacked > XML_BYTES || (expanded += unpacked) > XML_TOTAL || ![0, 8].includes(method))
                throw new Error("Office text preview limit.");
            if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method)
                throw new Error("Invalid ZIP local entry.");
            const localNameSize = bytes.readUInt16LE(local + 26), start = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
            if (start + packed > directory || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(bytes.subarray(offset + 46, offset + 46 + nameSize)))
                throw new Error("Invalid ZIP part.");
            if (ranges.some(([a, b]) => local < b && start + packed > a)) throw new Error("Overlapping ZIP entries.");
            ranges.push([local, start + packed]);
            const input = bytes.subarray(start, start + packed);
            const content = method === 0 ? input : inflateRawSync(input, { maxOutputLength: XML_BYTES });
            if (content.length !== unpacked || crc32(content) !== crc) throw new Error("Corrupt ZIP part.");
            selected.push({ number: kind === "presentation" ? Number(match[1]) : 1, text: xmlText(content, kind === "presentation" ? "a" : "w") });
        }
        offset = next;
    }
    if (offset !== end || !selected.length || Buffer.byteLength(JSON.stringify(selected)) > PREVIEW_BYTES) throw new Error("Office preview unavailable or too large.");
    return selected.sort((a, b) => a.number - b.number);
}
export function filePreview(metadata, bytes) {
    if (metadata.kind === "image")
        return { previewMessage: rasterMime(bytes) ? "Validated raster image. Download retains the original bytes." : "Image validation failed. Download only." };
    if (metadata.kind === "text") {
        if (bytes.length > PREVIEW_BYTES) return { previewMessage: "Text exceeds the 192 KiB preview limit. Download to inspect the complete original file." };
        try { return { text: utf8(bytes), previewMessage: "Plain-text source preview only; no HTML, scripts, links or embedded assets are executed." }; }
        catch { return { previewMessage: "This file is not safe UTF-8 plain text. Download only." }; }
    }
    if (["presentation", "document"].includes(metadata.kind)) {
        try {
            const parts = officeParts(bytes, metadata.kind);
            return { ...(metadata.kind === "presentation" ? { slides: parts } : { text: parts[0].text }),
                previewMessage: "Text-only preview, not slide or document fidelity. Slide numbers follow package part names; custom deck order, layout, notes, graphics, embedded content and external assets are not rendered." };
        } catch {
            return { previewMessage: "Safe text-only Office preview is unavailable (unsupported, corrupt, encrypted, or over preview limits). The original file remains downloadable." };
        }
    }
    return { previewMessage: "Download only. This file type is stored without executing or rendering its contents." };
}
