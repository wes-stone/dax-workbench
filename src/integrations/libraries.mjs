import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, realpath, open, opendir, unlink } from "node:fs/promises";
import { parseDocument } from "yaml";
import {
  normalizeBuilder, generateBuilderQuery as generateCanonicalBuilderQuery,
  parseBuilderReference, normalizeBuilderOperator, builderReference, builderDataType, builderParameterName, validateBuilderSchema,
} from "./query-builder.mjs";
export {
  normalizeBuilder, validateBuilderDraft, validateBuilderSchema, BUILDER_OPERATORS,
  generateBuilderQuery as generateCanonicalBuilderQuery,
  validateMeasureExpression, normalizeBuilderOperator, builderDataType, builderLiteral,
  builderReference, quoteBuilderTable, quoteBuilderObject, parseBuilderReference,
  defaultBuilderOperator, builderParameterName, hasBuilderParameters, collectBuilderParameters, BUILDER_START, BUILDER_END,
} from "./query-builder.mjs";

const LIMIT = Object.freeze({
  fileBytes: 1_048_576, queryBytes: 262_144, totalBytes: 8_388_608,
  entries: 200, files: 1_024, depth: 4, objects: 2_000, nodes: 20_000,
  text: 16_384, identifier: 256, parameters: 100, values: 200,
});
const TYPES = new Set(["text", "number", "date", "boolean", "list[text]"]);
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SECRET_KEYS = new Set([
  "connectionstring", "password", "pwd", "credential", "credentials",
  "secret", "clientsecret", "accesstoken", "refreshtoken", "authorization",
  "apikey", "privatekey", "userid", "effectiveusername",
]);
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARTIFACT", `${label} must be an object.`);
  }
  return value;
}

function text(value, label, max = LIMIT.text, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0")) {
    fail("INVALID_ARTIFACT", `${label} must be ${empty ? "a" : "a non-empty"} bounded string.`);
  }
  return value;
}

function filename(value, label = "Name") {
  text(value, label, 120);
  if (value !== value.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(value)
    || value === "." || value === ".." || /[. ]$/.test(value) || RESERVED.test(value)) {
    fail("UNSAFE_PATH", `${label} must be a single safe filename, not a path.`);
  }
  return value;
}

function normalized(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function inside(root, candidate) {
  const relative = path.relative(normalized(root), normalized(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("UNSAFE_PATH", "Artifact references must stay inside their library.");
  }
}

function relativeFile(root, value) {
  text(value, "Relative artifact path", 1_024);
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[\\/]/.test(value)) {
    fail("UNSAFE_PATH", "Absolute artifact references are not allowed.");
  }
  const parts = value.split(/[\\/]/);
  for (const part of parts) filename(part, "Artifact path segment");
  const target = path.resolve(root, ...parts);
  inside(root, target);
  return target;
}

async function checkedPath(input, { directory = false, root } = {}) {
  text(input, "Artifact path", 4_096);
  const resolved = path.resolve(input);
  if (root) inside(root, resolved);
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) fail("UNSAFE_PATH", "Symbolic links and reparse links are not allowed.");
    const actual = await realpath(cursor);
    if (normalized(actual) !== normalized(cursor)) {
      fail("UNSAFE_PATH", "Reparse paths and redirected artifact paths are not allowed.");
    }
  }
  const stat = await lstat(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    fail("INVALID_PATH", directory ? "Library path must be a directory." : "Artifact path must be a regular file.");
  }
  return resolved;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readText(file, budget = { bytes: 0 }, max = LIMIT.fileBytes, root) {
  const target = await checkedPath(file, { root });
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max || budget.bytes + stat.size > LIMIT.totalBytes) {
      fail("ARTIFACT_TOO_LARGE", "Artifact exceeds the supported size limit.");
    }
    // Read at most the limit, even if another process grows the file after stat().
    const bytes = Buffer.alloc(Math.min(max, LIMIT.totalBytes - budget.bytes) + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > max || budget.bytes + used > LIMIT.totalBytes) {
      fail("ARTIFACT_TOO_LARGE", "Artifact exceeds the supported size limit.");
    }
    budget.bytes += used;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    } catch {
      fail("INVALID_ARTIFACT", "Artifact must contain valid UTF-8 text.");
    }
  } finally {
    await handle.close();
  }
}

function inspectTree(value, state = { nodes: 0 }, depth = 0) {
  if (++state.nodes > LIMIT.nodes || depth > 32) fail("ARTIFACT_TOO_LARGE", "Artifact structure is too large or deeply nested.");
  if (typeof value === "string" && value.length > LIMIT.queryBytes) fail("ARTIFACT_TOO_LARGE", "Artifact contains an oversized value.");
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (BAD_KEYS.has(key)) fail("INVALID_ARTIFACT", "Unsafe object keys are not supported.");
      if (SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
        fail("CREDENTIAL_FILE_BLOCKED", "Credential configuration is not a library artifact.");
      }
      inspectTree(item, state, depth + 1);
    }
  }
}

function parseYaml(source) {
  let parsed;
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) fail("INVALID_ARTIFACT", "Invalid or unsupported YAML artifact.");
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail("INVALID_ARTIFACT", "Invalid or unsupported YAML artifact.");
  }
  inspectTree(parsed);
  return record(parsed, "YAML artifact");
}

function parseJson(source) {
  let parsed;
  try { parsed = JSON.parse(source); } catch { fail("INVALID_ARTIFACT", "Invalid JSON artifact."); }
  inspectTree(parsed);
  return record(parsed, "JSON artifact");
}

function queryText(value) {
  text(value, "Query", LIMIT.queryBytes);
  if (Buffer.byteLength(value) > LIMIT.queryBytes) fail("ARTIFACT_TOO_LARGE", "Query exceeds the supported size limit.");
  return value;
}

function parameterValue(value, type) {
  if (type === "number" && typeof value === "string") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
      fail("INVALID_PARAMS", "Number parameters must be finite decimal numbers.");
    }
    value = Number(value);
  }
  if (type === "boolean" && typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) value = true;
    else if (["false", "0", "no", "n"].includes(normalized)) value = false;
  }
  if (type === "list[text]" && typeof value === "string") {
    value = value.split(",").map(item => item.trim()).filter(Boolean);
  }
  if (type === "text") {
    if (value === null) value = "";
    else if (typeof value === "boolean") value = value ? "True" : "False";
    else if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  }
  let valid;
  if (type === "text") valid = typeof value === "string" && value.length <= LIMIT.text && !value.includes("\0");
  if (type === "number") valid = typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") valid = typeof value === "boolean";
  if (type === "date") {
    valid = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (valid) {
      const date = new Date(`${value}T00:00:00.000Z`);
      valid = Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCFullYear() >= 1900;
    }
  }
  if (type === "list[text]") {
    valid = Array.isArray(value) && value.length <= LIMIT.values
      && value.every(item => typeof item === "string" && item.length <= LIMIT.text && !item.includes("\0"));
  }
  if (!valid) fail("INVALID_PARAMS", "Parameter value does not match its declared type.");
  return value;
}

function parametersFor(query, input = {}) {
  record(input, "Parameters");
  inspectTree(input);
  if (Object.keys(input).length > LIMIT.parameters) fail("ARTIFACT_TOO_LARGE", "Too many query parameters.");
  const output = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || BAD_KEYS.has(name)) fail("INVALID_PARAMS", "Invalid parameter name.");
    const definition = raw === null ? {} : record(raw, "Parameter definition");
    const type = definition.type ?? "text";
    if (!TYPES.has(type)) fail("INVALID_PARAMS", "Unsupported parameter type.");
    if (definition.required !== undefined && typeof definition.required !== "boolean") {
      fail("INVALID_PARAMS", "Parameter required must be boolean.");
    }
    const rawAllowed = definition.allowed_values ?? [];
    if (!Array.isArray(rawAllowed) || rawAllowed.length > LIMIT.values) fail("INVALID_PARAMS", "allowed_values must be a bounded array.");
    const allowed = rawAllowed.map(value => parameterValue(value, type === "list[text]" ? "text" : type));
    const result = { type };
    if (definition.default !== undefined && definition.default !== null) {
      const value = parameterValue(definition.default, type);
      const values = type === "list[text]" ? value : [value];
      if (allowed.length && values.some(item => !allowed.includes(item))) fail("INVALID_PARAMS", "Parameter default is not in allowed_values.");
      result.default = Array.isArray(value) ? [...value] : value;
    }
    if (definition.required !== undefined) result.required = definition.required;
    if (definition.description !== undefined) result.description = text(definition.description, "Parameter description", LIMIT.text, true);
    if (allowed.length) result.allowed_values = [...allowed];
    output[name] = result;
  }
  for (const span of templateSpans(query)) {
    if (!Object.hasOwn(output, span.name)) fail("INVALID_PARAMS", "Query contains an undeclared parameter.");
  }
  return output;
}

function templateSpans(query) {
  const spans = [];
  let state = "code";
  for (let index = 0; index < query.length;) {
    const char = query[index];
    const pair = query.slice(index, index + 2);
    if (pair === "{{") {
      const tail = query.slice(index);
      const match = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(tail);
      if (match) {
        if (state !== "code") fail("INVALID_PARAMS", "Placeholders must be complete DAX literal tokens, outside strings, identifiers and comments.");
        const before = query[index - 1];
        const after = query[index + match[0].length];
        if ((before && !/[\s(,{=<>+*/!&|^;:-]/.test(before))
          || (after && !/[\s),}=<>+*/!&|^;:-]/.test(after))) {
          fail("INVALID_PARAMS", "Placeholders cannot be concatenated with DAX identifiers or literal tokens.");
        }
        spans.push({ name: match[1], start: index, end: index + match[0].length });
        index += match[0].length;
        continue;
      }
      // Nested DAX row constructors also use {{...}}; do not mistake numeric/string rows for templates.
      if (/^\{\{\s*[A-Za-z_][A-Za-z0-9_-]*(?:\s*\}\}|$)/.test(tail)) {
        fail("INVALID_PARAMS", "Malformed parameter placeholder.");
      }
    }
    if (state === "line-comment") {
      if (char === "\n" || char === "\r") state = "code";
      index++;
    } else if (state === "block-comment") {
      if (pair === "*/") { state = "code"; index += 2; }
      else index++;
    } else if (state !== "code") {
      const closing = state === "[" ? "]" : state;
      if (char === closing) {
        if (query[index + 1] === closing) index += 2;
        else { state = "code"; index++; }
      } else index++;
    } else if (pair === "--" || pair === "//") {
      state = "line-comment";
      index += 2;
    } else if (pair === "/*") {
      state = "block-comment";
      index += 2;
    } else {
      if (char === '"' || char === "'" || char === "[") state = char;
      index++;
    }
  }
  return spans;
}

export function parameterDefaults(definitions = {}) {
  const normalized = parametersFor("", definitions);
  return Object.fromEntries(Object.entries(normalized)
    .filter(([, definition]) => Object.hasOwn(definition, "default"))
    .map(([name, definition]) => [name, Array.isArray(definition.default) ? [...definition.default] : definition.default]));
}

function parameterLiteral(value, type) {
  if (type === "text") return quoteString(value);
  if (type === "number") return String(value);
  if (type === "boolean") return value ? "TRUE()" : "FALSE()";
  if (type === "date") return `DATE(${value.split("-").map(Number).join(", ")})`;
  if (type === "list[text]") return `{${value.map(quoteString).join(", ")}}`;
  fail("INVALID_PARAMS", "Unsupported parameter type.");
}

export function renderQueryTemplate({ query, definitions = {}, values = {} }) {
  queryText(query);
  const normalized = parametersFor(query, definitions);
  record(values, "Parameter values");
  inspectTree(values);
  if (Object.keys(values).length > LIMIT.parameters) fail("ARTIFACT_TOO_LARGE", "Too many parameter values.");
  const supplied = {};
  function validateValue(name, value) {
    const definition = normalized[name];
    const normalizedValue = parameterValue(value, definition.type);
    const selected = definition.type === "list[text]" ? normalizedValue : [normalizedValue];
    if (definition.allowed_values?.length && selected.some(item => !definition.allowed_values.includes(item))) {
      fail("INVALID_PARAMS", "Parameter value is not in allowed_values.");
    }
    return Array.isArray(normalizedValue) ? [...normalizedValue] : normalizedValue;
  }
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(normalized, name)) fail("INVALID_PARAMS", "Values contain an undeclared parameter.");
    supplied[name] = validateValue(name, value);
  }
  const resolved = {};
  const literals = new Map();
  const output = [];
  let bytes = 0;
  let previous = 0;
  function append(part) {
    bytes += Buffer.byteLength(part);
    if (bytes > LIMIT.queryBytes) fail("ARTIFACT_TOO_LARGE", "Rendered query exceeds the supported size limit.");
    output.push(part);
  }
  for (const span of templateSpans(query)) {
    const { name } = span;
    if (!literals.has(name)) {
      const definition = normalized[name];
      let value;
      if (Object.hasOwn(supplied, name)) value = supplied[name];
      else if (Object.hasOwn(definition, "default")) value = definition.default;
      else if (definition.required) fail("INVALID_PARAMS", `Missing required query parameter: ${name}.`);
      else value = "";
      resolved[name] = validateValue(name, value);
      literals.set(name, parameterLiteral(resolved[name], definition.type));
    }
    append(query.slice(previous, span.start));
    const literal = literals.get(name);
    // A negative number following unary/binary '-' must not create a '--' comment.
    append(query[span.start - 1] === "-" && literal.startsWith("-") ? ` ${literal}` : literal);
    previous = span.end;
  }
  append(query.slice(previous));
  return { query: output.join(""), values: resolved };
}

function connection(value, required = false) {
  if (value === undefined && !required) return undefined;
  return filename(value, "Connection name");
}

function metadata(raw, query, fallback) {
  if (raw.connection_binding !== undefined && (raw.connection_binding !== "unbound" || raw.connection_name !== undefined || raw.connectionName !== undefined))
    fail("INVALID_ARTIFACT", "An explicitly unbound query cannot also name a connection.");
  const result = {
    name: text(raw.display_name ?? raw.name ?? raw.id ?? fallback, "Query name", LIMIT.identifier),
    query: queryText(query),
    parameters: parametersFor(query, raw.parameters ?? {}),
  };
  const connectionName = connection(raw.connection_name ?? raw.connectionName);
  if (connectionName !== undefined) result.connectionName = connectionName;
  if (raw.connection_binding === "unbound") result.unbound = true;
  return result;
}

function isValidated(file) {
  return /\.validated_queries$/i.test(path.basename(path.dirname(file))) && /\.ya?ml$/i.test(file);
}

async function readQueryInternal(filePath, budget, root) {
  const file = path.resolve(text(filePath, "Query path", 4_096));
  if (/\.dax$/i.test(file)) {
    const query = await readText(file, budget, LIMIT.queryBytes, root);
    const sidecar = `${file}.json`;
    const builder = `${file}.queryBuilder`;
    const validated = file.replace(/\.dax$/i, ".yaml");
    let raw = {};
    let builderMetadata = {};
    if (await exists(sidecar)) {
      raw = parseJson(await readText(sidecar, budget, LIMIT.fileBytes, root));
      if (raw.artifact_version !== "1.0") fail("UNSUPPORTED_VERSION", "Unsupported query metadata version.");
      if (await exists(builder)) {
        const builderRaw = parseJson(await readText(builder, budget, LIMIT.fileBytes, root));
        builderMetadata = importedBuilderMetadata(builderRaw, query);
      }
    } else if (await exists(builder)) {
      raw = parseJson(await readText(builder, budget, LIMIT.fileBytes, root));
      builderMetadata = importedBuilderMetadata(raw, query);
    } else if (isValidated(validated) && await exists(validated)) {
      return readQueryInternal(validated, budget, root);
    }
    return { ...metadata(raw, query, path.basename(file, path.extname(file))), ...builderMetadata };
  }
  if (/\.dax\.querybuilder$/i.test(file)) {
    const raw = parseJson(await readText(file, budget, LIMIT.fileBytes, root));
    const query = await readText(file.slice(0, -".queryBuilder".length), budget, LIMIT.queryBytes, root);
    return { ...metadata(raw, query, path.basename(file).replace(/\.dax\.querybuilder$/i, "")), ...importedBuilderMetadata(raw, query) };
  }
  if (isValidated(file)) {
    const raw = parseYaml(await readText(file, budget, LIMIT.fileBytes, root));
    if (String(raw.version ?? "1.0") !== "1.0") fail("UNSUPPORTED_VERSION", "Unsupported validated library version.");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw.id ?? "")) fail("INVALID_ARTIFACT", "Invalid validated query id.");
    connection(raw.connection_name, true);
    const target = relativeFile(path.dirname(file), raw.file ?? `${raw.id}.dax`);
    if (!/\.dax$/i.test(target)) fail("CREDENTIAL_FILE_BLOCKED", "Query references must point to .dax files.");
    await checkReferenceParents(target, path.dirname(file));
    const query = raw.query_text ?? raw.query
      ?? await readText(target, budget, LIMIT.queryBytes, path.dirname(file));
    return metadata(raw, query, raw.id);
  }
  if (/\.ya?ml$/i.test(file)) fail("CREDENTIAL_FILE_BLOCKED", "Only validated-library YAML can be opened as a query.");
  fail("UNSUPPORTED_ARTIFACT", "Supported query files are .dax, .dax.queryBuilder, and validated-library YAML.");
}

export async function readQueryFile(filePath) {
  return readQueryInternal(filePath, { bytes: 0 }, undefined);
}

async function checkReferenceParents(target, root) {
  let folder = path.dirname(target);
  inside(root, folder);
  while (!(await exists(folder))) folder = path.dirname(folder);
  await checkedPath(folder, { directory: true, root });
  if (await exists(target)) await checkedPath(target, { root });
}

async function packInternal(filePath, budget) {
  let file = path.resolve(text(filePath, "Pack path", 4_096));
  if ((await lstat(file)).isDirectory()) file = path.join(file, "pack.yaml");
  if (path.basename(file).toLowerCase() !== "pack.yaml") fail("CREDENTIAL_FILE_BLOCKED", "Import requires a pack.yaml manifest.");
  const raw = parseYaml(await readText(file, budget));
  if (String(raw.pack_version ?? "") !== "1.0") fail("UNSUPPORTED_VERSION", "Only query pack version 1.0 is supported.");
  if (!Array.isArray(raw.queries)) fail("INVALID_ARTIFACT", "Pack queries must be an array.");
  if (raw.queries.length > LIMIT.entries) fail("ARTIFACT_TOO_LARGE", "Query pack contains too many entries.");
  const name = text(raw.name ?? "query-pack", "Pack name", LIMIT.identifier);
  const root = path.dirname(file);
  const ids = new Set();
  const entries = [];
  for (const entry of raw.queries) {
    record(entry, "Pack query");
    const id = text(entry.id, "Query id", 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || ids.has(id.toLowerCase())) fail("INVALID_ARTIFACT", "Invalid or duplicate pack query id.");
    ids.add(id.toLowerCase());
    const connectionName = connection(entry.connection_name ?? entry.connection, true);
    const queryPath = relativeFile(root, entry.file ?? `queries/${id}.dax`);
    if (!/\.dax$/i.test(queryPath)) fail("CREDENTIAL_FILE_BLOCKED", "Pack query references must point to .dax files.");
    await checkReferenceParents(queryPath, root);
    const query = entry.query_text ?? entry.query
      ?? await readText(queryPath, budget, LIMIT.queryBytes, root);
    entries.push({ ...metadata({ ...entry, connection_name: connectionName }, query, id), id, path: queryPath });
  }
  return { name, entries };
}

export async function importPack(filePath) {
  const pack = await packInternal(filePath, { bytes: 0 });
  return { name: pack.name, entries: pack.entries.map(({ id, path: file, ...entry }) => entry) };
}

export async function listLibrary(directory) {
  const root = await checkedPath(directory, { directory: true });
  const files = [];
  let seen = 0;
  async function walk(folder, depth) {
    const handle = await opendir(folder);
    for await (const entry of handle) {
      if (++seen > LIMIT.files) fail("ARTIFACT_TOO_LARGE", "Library has too many files; choose a narrower directory.");
      const target = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) fail("UNSAFE_PATH", "Library contains a symbolic or reparse link.");
      if (entry.isDirectory()) {
        if (depth >= LIMIT.depth) fail("ARTIFACT_TOO_LARGE", "Library is too deeply nested; choose a narrower directory.");
        await checkedPath(target, { directory: true, root });
        await walk(target, depth + 1);
      } else if (/\.dax(?:\.querybuilder)?$/i.test(entry.name)
        || entry.name.toLowerCase() === "pack.yaml" || isValidated(target)) {
        files.push(target);
      }
    }
  }
  await walk(root, 0);
  files.sort();
  const entries = [];
  const budget = { bytes: 0 };
  const packedFiles = new Set();
  function add(entry) {
    if (entries.length >= LIMIT.entries) fail("ARTIFACT_TOO_LARGE", "Library has too many entries; choose a narrower directory.");
    entries.push(entry);
  }
  for (const file of files) {
    if (path.basename(file).toLowerCase() === "pack.yaml") {
      const pack = await packInternal(file, budget);
      add({ id: path.relative(root, file), name: pack.name, path: file, kind: "pack" });
      for (const entry of pack.entries) packedFiles.add(normalized(entry.path));
    }
  }
  for (const file of files) {
    const relative = path.relative(root, file);
    if (path.basename(file).toLowerCase() === "pack.yaml" || packedFiles.has(normalized(file))
      || packedFiles.has(normalized(file.replace(/\.querybuilder$/i, "")))) continue;
    if (/\.dax$/i.test(file) && (files.includes(`${file}.queryBuilder`)
      || files.includes(file.replace(/\.dax$/i, ".yaml")))) continue;
    const item = await readQueryInternal(file, budget, root);
    add({
      id: relative, name: item.name, path: file,
      ...(item.connectionName ? { connectionName: item.connectionName } : {}),
      kind: isValidated(file) ? "validated-query" : /\.querybuilder$/i.test(file) ? "query-builder" : "query",
    });
  }
  return entries;
}

async function writeExclusive(directory, artifacts) {
  const root = await checkedPath(directory, { directory: true });
  const opened = [];
  try {
    for (const [name, content] of artifacts) {
      const target = relativeFile(root, name);
      if (Buffer.byteLength(content) > LIMIT.fileBytes) fail("ARTIFACT_TOO_LARGE", "Saved artifact exceeds the size limit.");
      await checkedPath(root, { directory: true });
      let handle;
      try { handle = await open(target, "wx", 0o600); } catch (error) {
        if (error.code === "EEXIST") fail("FILE_EXISTS", "An artifact with this name already exists; choose another name.");
        throw error;
      }
      opened.push({ target, handle, content, stat: await handle.stat() });
    }
    for (const item of opened) await item.handle.writeFile(item.content, "utf8");
    for (const item of opened) await item.handle.sync();
    return opened.map(item => item.target);
  } catch (error) {
    for (const item of opened) {
      await item.handle.close();
      item.closed = true;
      const stat = await lstat(item.target).catch(() => null);
      if (stat && stat.ino === item.stat.ino && stat.dev === item.stat.dev) await unlink(item.target);
    }
    throw error;
  } finally {
    for (const item of opened) if (!item.closed) await item.handle.close();
  }
}

export async function saveQueryFile({ directory, name, query, parameters = {}, connectionName }) {
  const stem = filename(name).replace(/\.dax$/i, "");
  filename(stem);
  queryText(query);
  inspectTree(parameters);
  const params = parametersFor(query, parameters);
  const configuredConnection = connection(connectionName);
  const raw = {
    artifact_version: "1.0", name: stem, parameters: params,
    ...(configuredConnection ? { connection_name: configuredConnection } : {}),
  };
  const [saved] = await writeExclusive(directory, [
    [`${stem}.dax`, query], [`${stem}.dax.json`, `${JSON.stringify(raw, null, 2)}\n`],
  ]);
  return { path: saved };
}

function identifier(value, label) {
  text(value, label, LIMIT.identifier);
  if (/[\x00-\x1f\x7f]/.test(value)) fail("INVALID_IDENTIFIER", `${label} cannot contain control characters.`);
  return value;
}

const quoteTable = value => `'${value.replaceAll("'", "''")}'`;
const quoteObject = value => `[${value.replaceAll("]", "]]")}]`;
const quoteString = value => `"${value.replaceAll('"', '""')}"`;

function parseReference(value, column = false) {
  return parseBuilderReference(value, column);
}

function validateBuilder(builder, requireConnection) {
  record(builder, "Builder");
  if (builder.version !== 1) fail("UNSUPPORTED_VERSION", "Only query builder version 1 is supported.");
  text(builder.name, "Builder name", LIMIT.identifier);
  if (requireConnection) connection(builder.connection_name, true);
  if (!Array.isArray(builder.columns) || !Array.isArray(builder.measures)
    || builder.columns.length + builder.measures.length === 0
    || builder.columns.length + builder.measures.length > LIMIT.entries) {
    fail("INVALID_BUILDER", "Builder requires bounded columns or measures.");
  }
  builder.columns.forEach(value => parseReference(value, true));
  builder.measures.forEach(item => {
    record(item, "Builder measure");
    identifier(item.caption, "Measure caption");
    parseReference(item.expression);
  });
  if (!Array.isArray(builder.filters) || !Array.isArray(builder.order_by)) fail("INVALID_BUILDER", "Builder filters and order_by must be arrays.");
  if (builder.filters.length || builder.order_by.length) fail("UNSUPPORTED_BUILDER", "This builder supports schema selections only; open the paired DAX for filters or ordering.");
}

function validateImportedBuilder(builder) {
  record(builder, "Builder");
  if ((builder.version ?? 1) !== 1) fail("UNSUPPORTED_VERSION", "Only query builder version 1 is supported.");
  text(builder.name, "Builder name", LIMIT.identifier);
  connection(builder.connection_name, true);
  const columns = boundedArray(builder.columns, "Builder columns");
  const measures = boundedArray(builder.measures, "Builder measures");
  if (!columns.length && !measures.length) fail("INVALID_BUILDER", "Builder requires columns or measures.");
  for (const column of columns) text(column, "Column expression", LIMIT.text);
  for (const measure of measures) {
    record(measure, "Builder measure");
    text(measure.caption, "Measure caption", LIMIT.identifier);
    text(measure.expression, "Measure expression", LIMIT.text);
  }
  for (const filter of boundedArray(builder.filters, "Builder filters")) {
    record(filter, "Builder filter");
    text(filter.expression, "Filter expression");
    const operator = normalizeBuilderOperator(filter.operator);
    if (["In", "NotIn"].includes(operator)) {
      if (!boundedArray(filter.values, "Filter values").length) fail("INVALID_BUILDER", "Filter requires values.");
    } else if (!["IsBlank", "IsNotBlank"].includes(operator) && filter.value == null) {
      fail("INVALID_BUILDER", "Filter requires a value.");
    }
    if (operator === "Between" && filter.value2 == null) fail("INVALID_BUILDER", "Between filter requires a second value.");
  }
  for (const order of boundedArray(builder.order_by, "Builder ordering")) {
    record(order, "Builder ordering");
    text(order.expression, "Order expression");
    if (!["ASC", "DESC"].includes(order.direction ?? "ASC")) fail("INVALID_BUILDER", "Invalid builder sort direction.");
  }
}

function legacyStudioPayload(builder) {
  const defaultTable = builder.columns.length ? parseReference(builder.columns[0], true).table : "QueryBuilder";
  function item(expression, caption, measure) {
    const ref = parseReference(expression, !measure);
    const table = ref.table ?? defaultTable;
    return {
      TabularObject: {
        Caption: caption, DaxName: measure ? quoteObject(caption) : expression,
        Description: "", IsVisible: true, ObjectType: measure ? "Measure" : "Column",
        MetadataImage: measure ? "Measure" : "Column", MeasureExpression: measure ? expression : "",
        TableName: table, DataType: 2, SystemType: "System.String, mscorlib", ImageResource: "",
      },
      SelectedTable: {
        Caption: table, DaxName: quoteTable(table), Name: table,
        Description: "", IsVisible: true, ObjectType: "Table",
      },
      IsModelItem: true, Caption: caption, IsOverriden: false,
      MeasureExpression: measure ? expression : "", SortDirection: "None",
    };
  }
  return {
    AutoGenerate: false,
    Columns: [
      ...builder.columns.map(expression => item(expression, parseReference(expression, true).name, false)),
      ...builder.measures.map(measure => item(measure.expression, measure.caption, true)),
    ],
    Filters: { Items: [] },
  };
}

function renderBuilder(builder) {
  const args = [...builder.columns, ...builder.measures.map(item => `${quoteString(item.caption)}, ${item.expression}`)];
  return `EVALUATE\nSUMMARIZECOLUMNS(\n    ${args.join(",\n    ")}\n)`;
}

const queryHash = value => createHash("sha256").update(value, "utf8").digest("hex");
const builderMetadataHash = raw => queryHash(JSON.stringify({
  columns: raw.columns, measures: raw.measures, filters: raw.filters, order_by: raw.order_by,
  Columns: raw.Columns, Filters: raw.Filters, OrderBy: raw.OrderBy, workbenchBuilder: raw.workbenchBuilder,
}));

function importedField(ref, kind, extra = {}) {
  return { id: JSON.stringify([kind, ref.table ?? "", ref.name]), kind, ...ref, ...extra };
}

function importMcpBuilder(raw) {
  function reference(value, column = false) {
    try { return parseReference(value, column); } catch (error) {
      if (/^[A-Za-z_][A-Za-z0-9_.]*\s*\(/.test(value.trim())) {
        fail("UNSUPPORTED_BUILDER", "MCP computed field expressions cannot be restored as schema references. The paired DAX is preserved.");
      }
      throw error;
    }
  }
  const fields = raw.columns.map(value => importedField(reference(value, true), "column"));
  for (const item of raw.measures) {
    let ref;
    try { ref = parseReference(item.expression); } catch {
      fail("UNSUPPORTED_BUILDER", "MCP expression measures without an explicit model reference cannot safely become query-scoped measures. The paired DAX is preserved.");
    }
    fields.push(importedField(ref, "measure", item.caption === ref.name ? {} : { caption: item.caption }));
  }
  function resolve(expression) {
    const ref = reference(expression);
    const candidates = fields.filter(field => field.name === ref.name && (ref.table === undefined || field.table === ref.table));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) fail("INVALID_BUILDER", "Ambiguous MCP builder field reference.");
    return importedField(ref, ref.table ? "column" : "measure");
  }
  const filters = (raw.filters ?? []).map((item, index) => {
    const field = resolve(item.expression);
    const operator = normalizeBuilderOperator(item.operator);
    const rawValues = ["In", "NotIn"].includes(operator) ? item.values : [item.value];
    const populated = rawValues?.filter(value => value !== null && value !== undefined) ?? [];
    if (!field.dataType && populated.length) {
      const types = new Set(populated.map(value => typeof value));
      if (types.size !== 1 || !["string", "number", "boolean"].includes([...types][0])) fail("UNSUPPORTED_BUILDER", "MCP filters contain unsupported or mixed literal types.");
      field.dataType = { number: "number", boolean: "boolean", string: "text" }[[...types][0]];
    }
    for (const value of populated) {
      if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        fail("UNSUPPORTED_BUILDER", "MCP numeric filter precision cannot be recovered from a JSON number.");
      }
      if (["In", "NotIn"].includes(operator) && typeof value === "string" && /[\r\n]/.test(value)) {
        fail("UNSUPPORTED_BUILDER", "MCP list values containing newlines cannot be represented by the builder's newline-separated list editor.");
      }
    }
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") fail("INVALID_BUILDER", "Filter enabled must be boolean.");
    return {
      id: `mcp-filter-${index}`, field, operator, value: ["In", "NotIn"].includes(operator)
        ? populated.map(String).join("\n") : item.value == null ? "" : String(item.value),
      ...(item.value2 !== undefined ? { value2: String(item.value2) } : {}), enabled: item.enabled ?? true,
    };
  });
  const orderBy = (raw.order_by ?? []).map(item => {
    const field = resolve(item.expression);
    if (!fields.some(selected => selected.id === field.id)) fail("UNSUPPORTED_BUILDER", "MCP ordering by an unselected field is not supported.");
    return { fieldId: field.id, direction: item.direction ?? "ASC" };
  });
  return normalizeBuilder({ version: 2, fields, filters, orderBy });
}

function studioType(field) {
  const type = builderDataType(field);
  if (type === "number" && /^(?:decimal|currency|fixed decimal number|10)$/i.test(field.dataType ?? "")) return 10;
  return { text: 2, integer: 6, number: 8, boolean: 11, date: 9, datetime: 9 }[type];
}

function studioItem(field, order = "None") {
  const table = field.table ?? "QueryBuilder";
  const measure = field.kind === "measure";
  return {
    TabularObject: {
      Caption: field.name, Name: field.name, DaxName: builderReference(field),
      Description: "", IsVisible: true, ObjectType: measure ? 2 : 0, IsMeasure: measure,
      MetadataImage: measure ? 4 : 2, MeasureExpression: field.expression ?? "",
      TableName: table, DataType: studioType(field), SystemType: {
        text: "System.String", integer: "System.Int64", number: "System.Double",
        boolean: "System.Boolean", date: "System.DateTime", datetime: "System.DateTime",
      }[builderDataType(field)] + ", mscorlib", ImageResource: "",
    },
    SelectedTable: { Caption: table, DaxName: quoteTable(table), Name: table, Description: "", IsVisible: true, ObjectType: 9 },
    IsModelItem: !field.isCustom, Caption: field.caption ?? field.name,
    IsOverriden: field.expression !== undefined,
    MeasureExpression: field.expression ?? "", SortDirection: { ASC: 0, DESC: 1, None: 2 }[order],
  };
}

export function studioPayload(input) {
  const builder = normalizeBuilder(input);
  const orderFor = field => builder.orderBy.find(order => order.fieldId === field.id)?.direction ?? "None";
  return {
    AutoGenerate: false,
    Columns: builder.fields.map(field => studioItem(field, orderFor(field))),
    Filters: { Items: builder.filters.filter(filter => filter.enabled).map(filter => ({
      TabularObject: studioItem(filter.field).TabularObject,
      ModelCapabilities: { DAXFunctions: { SummarizeColumns: true, TreatAs: true }, Variables: true, TableConstructor: true },
      FilterType: filter.operator,
      FilterValue: filter.isParameter && !["IsBlank", "IsNotBlank"].includes(filter.operator) ? builderParameterName(filter.value) : filter.value,
      FilterValueIsParameter: Boolean(filter.isParameter && !["IsBlank", "IsNotBlank"].includes(filter.operator)),
      FilterValue2: filter.isParameter2 && filter.operator === "Between" ? builderParameterName(filter.value2) : filter.value2 ?? "",
      FilterValue2IsParameter: Boolean(filter.isParameter2 && filter.operator === "Between"),
    })) },
  };
}

function studioCompatibilityWarnings(builder) {
  const warnings = [];
  const studioOrder = builder.fields.filter(field => field.kind === "column" && builder.orderBy.some(order => order.fieldId === field.id)).map(field => field.id);
  if (JSON.stringify(studioOrder) !== JSON.stringify(builder.orderBy.map(order => order.fieldId))) warnings.push("DAX Studio regenerates sorting only for columns in selection order; independent sort priority and measure sorting are preserved in Workbench state and the paired DAX.");
  if (/mc/.test(builder.fields.map(field => field.kind[0]).join(""))) warnings.push("DAX Studio regenerates columns before measures; interleaved output order is preserved in Workbench state and the paired DAX.");
  if (builder.fields.some(field => field.caption !== undefined && field.caption !== field.name)) warnings.push("Output aliases are preserved in Workbench state and the paired DAX; DAX Studio may reset aliases or use them as new measure names.");
  if (builder.filters.some(filter => !filter.enabled)) warnings.push("Disabled filters are retained in Workbench state but omitted from Studio's active-only filter list.");
  if (builder.filters.some(filter => filter.enabled && filter.field.expression !== undefined && !builder.fields.some(field => field.id === filter.field.id))) warnings.push("Query-scoped definitions used only by filters are preserved in Workbench state and the paired DAX; Studio defines only selected measures.");
  return warnings;
}

function canonicalMcpPayload(builder) {
  // MCP v1 cannot describe interleaved projections, column captions or scoped measure definitions.
  const orderedKinds = builder.fields.map(field => field.kind[0]).join("");
  const mcpOperators = {
    Is: "==", IsNot: "!=", GreaterThan: ">", GreaterThanOrEqual: ">=",
    LessThan: "<", LessThanOrEqual: "<=", IsBlank: "is_blank", IsNotBlank: "is_not_blank",
    In: "in", NotIn: "not_in", Between: "between", Contains: "contains", StartsWith: "starts_with",
  };
  if (/mc/.test(orderedKinds) || builder.fields.some(field => field.expression !== undefined || (field.kind === "column" && field.caption))
    || builder.filters.some(filter => filter.field.expression !== undefined || !filter.enabled || filter.isParameter || filter.isParameter2 || !mcpOperators[filter.operator]
      || (!["IsBlank", "IsNotBlank"].includes(filter.operator) && builderDataType(filter.field) !== "text"))) return {};
  return {
    columns: builder.fields.filter(field => field.kind === "column").map(builderReference),
    measures: builder.fields.filter(field => field.kind === "measure").map(field => ({
      caption: field.caption ?? field.name, expression: field.expression ?? builderReference(field),
    })),
    filters: builder.filters.map(filter => ({
      expression: builderReference(filter.field), operator: mcpOperators[filter.operator], value: filter.value,
      ...(filter.value2 !== undefined ? { value2: filter.value2 } : {}),
      ...(["In", "NotIn"].includes(filter.operator) ? { values: filter.value.replaceAll("\r", "").split("\n") } : {}),
      enabled: filter.enabled,
    })),
    order_by: builder.orderBy.map(order => ({
      expression: builderReference(builder.fields.find(field => field.id === order.fieldId)), direction: order.direction,
    })),
  };
}

function importStudioField(item, allowHierarchy = false) {
  record(item, "Studio builder item");
  const tabular = record(item.TabularObject, "Studio tabular object");
  const kind = typeof tabular.ObjectType === "string" ? tabular.ObjectType.toLowerCase()
    : { 0: "column", 2: "measure", 6: "hierarchy", 7: "level", 8: "unnaturalhierarchy" }[tabular.ObjectType];
  for (const key of ["IsModelItem", "IsOverriden", "IsOverridden"]) if (item[key] !== undefined && typeof item[key] !== "boolean") {
    fail("INVALID_BUILDER", `Studio ${key} must be boolean.`);
  }
  if (item.IsOverriden !== undefined && item.IsOverridden !== undefined && item.IsOverriden !== item.IsOverridden) {
    fail("INVALID_BUILDER", "Conflicting Studio measure override flags.");
  }
  if (["hierarchy", "unnaturalhierarchy"].includes(kind)) {
    if (!allowHierarchy) fail("UNSUPPORTED_BUILDER", "A whole hierarchy cannot be used as a filter or independent sort field. The paired DAX is preserved.");
    if (item.IsModelItem === false || item.IsOverriden || item.IsOverridden) fail("UNSUPPORTED_BUILDER", "Query-local hierarchy definitions are not supported. The paired DAX is preserved.");
    if (tabular.DaxName !== undefined && tabular.DaxName !== "") fail("UNSUPPORTED_BUILDER", "Studio hierarchy identities with a nonempty DaxName require manual review. The paired DAX is preserved.");
    const name = identifier(tabular.Name, "Hierarchy name");
    const table = identifier(tabular.TableName ?? item.SelectedTable?.Name, "Hierarchy table");
    if (item.SelectedTable?.Name !== undefined && item.SelectedTable.Name !== table) fail("INVALID_BUILDER", "Studio hierarchy home tables conflict.");
    return importedField({ table, name }, "hierarchy");
  }
  if (!["column", "level", "measure"].includes(kind)) fail("UNSUPPORTED_BUILDER", "Only Studio columns, levels, measures and model hierarchies are supported.");
  const ref = parseReference(tabular.DaxName, kind === "column");
  const table = ref.table ?? tabular.TableName ?? item.SelectedTable?.Name;
  if (ref.table && tabular.TableName && ref.table !== tabular.TableName) fail("INVALID_BUILDER", "Studio field table conflicts with its DAX reference.");
  const systemType = typeof tabular.SystemType === "string" ? tabular.SystemType.split(",")[0].replace(/^System\./, "") : undefined;
  const importedType = systemType && !["Object", "Unknown"].includes(systemType) ? systemType : tabular.DataType;
  const field = importedField({ ...ref, ...(table ? { table } : {}) }, kind === "level" ? "column" : kind, {
    ...(importedType !== undefined ? { dataType: String(importedType) } : {}),
    ...(item.Caption !== undefined && item.Caption !== ref.name ? { caption: item.Caption } : {}),
  });
  if (item.IsModelItem === false) field.isCustom = true;
  if (item.IsOverriden || item.IsOverridden) {
    if (kind !== "measure") fail("UNSUPPORTED_BUILDER", "Studio calculated column overrides cannot be imported as measures.");
    field.expression = text(item.MeasureExpression ?? tabular.MeasureExpression, "Studio measure expression");
  } else if (field.isCustom) {
    field.expression = "";
  }
  return field;
}

function studioDirection(value) {
  if (value === undefined) return "ASC";
  if (["ASC", "Asc", "Ascending", 0, "0"].includes(value)) return "ASC";
  if (["DESC", "Desc", "Descending", 1, "1"].includes(value)) return "DESC";
  if (["None", 2, "2"].includes(value)) return undefined;
  fail("INVALID_BUILDER", "Invalid Studio sort direction.");
}

function importStudioBuilder(raw) {
  if (raw.AutoGenerate !== undefined && typeof raw.AutoGenerate !== "boolean") fail("INVALID_BUILDER", "Studio AutoGenerate must be boolean.");
  const fields = boundedArray(raw.Columns, "Studio columns").map(item => importStudioField(item, true));
  const filterItems = Array.isArray(raw.Filters) ? raw.Filters : raw.Filters?.Items ?? [];
  if (raw.Filters !== undefined && !Array.isArray(raw.Filters)) {
    record(raw.Filters, "Studio filters");
    if (!Array.isArray(raw.Filters.Items)) fail("INVALID_BUILDER", "Studio Filters.Items must be an array.");
  }
  const filters = boundedArray(filterItems, "Studio filter items").map((item, index) => {
    for (const key of ["FilterValueIsParameter", "FilterValue2IsParameter"]) {
      if (item[key] !== undefined && typeof item[key] !== "boolean") fail("INVALID_BUILDER", `Studio ${key} must be boolean.`);
    }
    const field = importStudioField(item);
    const selected = fields.find(candidate => candidate.kind === field.kind && candidate.name === field.name && candidate.table === field.table);
    const value = item.FilterValue ?? item.Value ?? "";
    const value2 = item.FilterValue2 ?? item.Value2;
    if (typeof value !== "string" || (value2 !== undefined && typeof value2 !== "string")) fail("INVALID_BUILDER", "Studio filter values must be strings.");
    const enabled = item.IsEnabled ?? item.Enabled ?? true;
    const studioOperators = [
      "Contains", "DoesNotContain", "StartsWith", "DoesNotStartWith", "In", "NotIn",
      "Is", "IsNot", "IsBlank", "IsNotBlank", "GreaterThan", "GreaterThanOrEqual",
      "LessThan", "LessThanOrEqual", "Between",
    ];
    const rawOperator = item.FilterType ?? item.Operator;
    return {
      id: `studio-filter-${index}`, field: selected ?? field,
      operator: normalizeBuilderOperator(typeof rawOperator === "number" ? studioOperators[rawOperator] : rawOperator),
      value, ...(value2 !== undefined ? { value2 } : {}), enabled,
      ...(item.FilterValueIsParameter !== undefined ? { isParameter: item.FilterValueIsParameter } : {}),
      ...(item.FilterValue2IsParameter !== undefined ? { isParameter2: item.FilterValue2IsParameter } : {}),
    };
  });
  if (raw.OrderBy !== undefined && !Array.isArray(raw.OrderBy)) {
    record(raw.OrderBy, "Studio order by");
    if (!Array.isArray(raw.OrderBy.Items)) fail("INVALID_BUILDER", "Studio OrderBy.Items must be an array.");
  }
  const orders = raw.OrderBy === undefined
    ? raw.Columns.filter((item, index) => fields[index].kind === "column" && studioDirection(item.SortDirection) !== undefined)
    : boundedArray(Array.isArray(raw.OrderBy) ? raw.OrderBy : raw.OrderBy?.Items, "Studio order by");
  const orderBy = orders.map(item => {
    const field = importStudioField(item);
    const selected = fields.find(candidate => candidate.kind === field.kind && candidate.name === field.name && candidate.table === field.table);
    if (!selected) fail("UNSUPPORTED_BUILDER", "Studio ordering by an unselected field is not supported.");
    const direction = studioDirection(item.SortDirection ?? item.Direction);
    if (!direction) fail("INVALID_BUILDER", "Studio ordering requires a sort direction.");
    return { fieldId: selected.id, direction };
  });
  return fields.some(field => field.kind === "hierarchy")
    ? normalizeBuilderImport({ version: 1, format: "dax-studio", fields, filters, orderBy })
    : normalizeBuilder({ version: 2, fields, filters, orderBy });
}

export function normalizeBuilderImport(input) {
  inspectTree(input);
  record(input, "Pending builder import");
  if (input.version !== 1 || input.format !== "dax-studio") fail("UNSUPPORTED_VERSION", "Unsupported pending builder import.");
  const fields = boundedArray(input.fields, "Imported fields").map(raw => {
    record(raw, "Imported field");
    if (raw.kind !== "hierarchy") return normalizeBuilder({ version: 2, fields: [raw], filters: [], orderBy: [] }).fields[0];
    const table = identifier(raw.table, "Hierarchy table"), name = identifier(raw.name, "Hierarchy name");
    if (raw.id !== JSON.stringify(["hierarchy", table, name])) fail("INVALID_BUILDER", "Invalid pending hierarchy identity.");
    return importedField({ table, name }, "hierarchy");
  });
  if (!fields.some(field => field.kind === "hierarchy")) fail("INVALID_BUILDER", "Pending imports require a model hierarchy.");
  const ids = new Set(), refs = new Set();
  for (const field of fields) {
    const ref = JSON.stringify([field.kind, field.table?.toLowerCase(), field.name.toLowerCase()]);
    if (ids.has(field.id) || refs.has(ref)) fail("INVALID_BUILDER", "Duplicate imported fields are not allowed.");
    ids.add(field.id); refs.add(ref);
  }
  const regular = fields.filter(field => field.kind !== "hierarchy");
  const canonical = normalizeBuilder({ version: 2, fields: regular, filters: input.filters, orderBy: input.orderBy });
  return { version: 1, format: "dax-studio", fields, filters: canonical.filters, orderBy: canonical.orderBy };
}

export function resolveBuilderImport(input, schema) {
  const pending = normalizeBuilderImport(input);
  const mismatch = message => fail("BUILDER_SCHEMA_MISMATCH", `${message} The paired DAX and pending selections are preserved.`);
  if (!schema || !Array.isArray(schema.objects) || schema.objects.length > 100_000
    || !Array.isArray(schema.hierarchies) || schema.hierarchies.length > 100_000
    || schema.coverage?.hierarchies?.status === "unavailable") mismatch("This connection does not expose verified hierarchy levels.");
  const objects = new Map();
  for (const object of schema.objects) {
    if (objects.has(object.id)) mismatch("Model metadata has ambiguous object IDs.");
    objects.set(object.id, object);
  }
  const fields = [];
  for (const field of pending.fields) {
    if (field.kind !== "hierarchy") { fields.push(field); continue; }
    const matches = schema.hierarchies.filter(item => item.kind === "hierarchy"
      && item.table?.toLowerCase() === field.table.toLowerCase() && item.name?.toLowerCase() === field.name.toLowerCase());
    if (matches.length !== 1) mismatch(`Hierarchy '${field.table}'[${field.name}] is absent or ambiguous in this model.`);
    const hierarchy = matches[0];
    if (!Array.isArray(hierarchy.levels) || !hierarchy.levels.length || hierarchy.levels.length > LIMIT.entries
      || hierarchy.levels.some(level => !level || typeof level !== "object"))
      mismatch(`Hierarchy ${field.name} has no bounded, verified level list.`);
    const ordinals = new Set(), columns = new Set(), levelIds = new Set();
    for (const level of [...hierarchy.levels].sort((left, right) => left.ordinal - right.ordinal)) {
      const column = objects.get(level.columnId);
      if (!Number.isInteger(level.ordinal) || level.ordinal < 0 || ordinals.has(level.ordinal)
        || !level.id || levelIds.has(level.id) || columns.has(level.columnId)
        || column?.kind !== "column" || column.table !== hierarchy.table)
        mismatch(`Hierarchy ${field.name} contains an invalid, repeated, or cross-table level binding.`);
      ordinals.add(level.ordinal); levelIds.add(level.id); columns.add(level.columnId);
      fields.push({ id: column.id, kind: "column", table: column.table, name: column.name, ...(column.dataType ? { dataType: column.dataType } : {}) });
    }
  }
  // Restore the saved selection, not additional columns inferred from current sort/group dependencies.
  return validateBuilderSchema({ version: 2, fields, filters: pending.filters, orderBy: pending.orderBy }, schema.objects);
}

function importedBuilderMetadata(raw, query) {
  record(raw, "Builder");
  if (raw.version !== undefined && ![1, 2].includes(raw.version)) fail("UNSUPPORTED_VERSION", "Unsupported query builder version.");
  if (raw.connection_name !== undefined) connection(raw.connection_name, true);
  if (raw.name !== undefined) text(raw.name, "Builder name", LIMIT.identifier);
  if (raw.query_sha256 !== undefined) {
    if (typeof raw.query_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.query_sha256)) fail("INVALID_BUILDER", "Invalid builder query fingerprint.");
    if (raw.query_sha256 !== queryHash(query)) return { builderWarning: "The paired DAX changed after builder save. Builder state was not restored; the DAX text is preserved." };
  }
  if (raw.builder_metadata_sha256 !== undefined && raw.builder_metadata_sha256 !== builderMetadataHash(raw)) {
    return { builderWarning: "The builder sidecar changed after save. Its saved canonical state was not restored; the paired DAX is preserved." };
  }
  try {
    let builderState;
    if (raw.workbenchBuilder !== undefined) builderState = normalizeBuilder(raw.workbenchBuilder);
    else if (raw.version === 2) builderState = normalizeBuilder(raw);
    else if (Array.isArray(raw.columns)) {
      validateImportedBuilder(raw);
      builderState = importMcpBuilder(raw);
      if (raw.Columns?.length) {
        const studio = importStudioBuilder(raw);
        const signatures = builder => builder.fields.map(field => [field.kind, field.name, field.caption ?? field.name]);
        if (studio.format === "dax-studio" || JSON.stringify(signatures(studio)) !== JSON.stringify(signatures(builderState))
          || studio.filters.length !== builderState.filters.length || studio.orderBy.length !== builderState.orderBy.length) {
          fail("UNSUPPORTED_BUILDER", "Combined MCP and Studio builder metadata disagree. The paired DAX is preserved without restoring an ambiguous builder.");
        }
        builderState = studio;
      }
    } else if (Array.isArray(raw.Columns)) builderState = importStudioBuilder(raw);
    else fail("INVALID_BUILDER", "Unrecognized query-builder artifact shape.");
    if (builderState.format === "dax-studio") return {
      builderImport: builderState,
      builderWarning: "This Studio file contains hierarchy selections. Resolve them against the intended model to restore an editable builder. The paired DAX is preserved; synchronization is unverified.",
    };
    return {
      builderState,
      ...(Array.isArray(raw.workbenchCompatibilityWarnings) && raw.workbenchCompatibilityWarnings.length ? {
        builderWarning: raw.workbenchCompatibilityWarnings.map(value => text(value, "Builder compatibility warning")).join(" "),
      } : raw.query_sha256 === undefined ? {
        builderWarning: "Imported external builder metadata. The paired DAX is preserved but synchronization is unverified; generate to review the current builder query.",
      } : {}),
    };
  } catch (error) {
    if (error.code !== "UNSUPPORTED_BUILDER") throw error;
    return { builderWarning: error.message };
  }
}

export function generateBuilderQuery(input) {
  if (input?.version === 2) return generateCanonicalBuilderQuery(input);
  const { table, columns, measure } = input ?? {};
  identifier(table, "Table name");
  if (!Array.isArray(columns) || columns.length > LIMIT.entries) fail("INVALID_BUILDER", "Columns must be a bounded array of names.");
  const selected = columns.map(name => `${quoteTable(table)}${quoteObject(identifier(name, "Column name"))}`);
  if (new Set(selected).size !== selected.length) fail("INVALID_BUILDER", "Duplicate builder columns are not allowed.");
  const measures = measure === undefined || measure === "" ? [] : [{
    caption: identifier(measure, "Measure name"), expression: quoteObject(measure),
  }];
  const builder = {
    version: 1, name: "query", connection_name: "", description: null,
    output_filename: null, command_timeout_seconds: null, max_rows: null,
    columns: selected, measures, filters: [], order_by: [],
  };
  validateBuilder(builder, false);
  return { query: renderBuilder(builder), builder: { ...builder, ...legacyStudioPayload(builder) } };
}

export function queryBuilderFiles({ name, query, builder, connectionName }) {
  const stem = filename(name).replace(/\.dax$/i, "");
  filename(stem);
  inspectTree(builder);
  record(builder, "Builder");
  let payload;
  let expected;
  let canonical;
  if (builder.version === 2) {
    const generated = generateCanonicalBuilderQuery(builder);
    canonical = generated.builder;
    expected = generated.query;
    const configuredConnection = connection(connectionName ?? builder.connection_name);
    payload = {
      version: 1, name: stem, ...(configuredConnection ? { connection_name: configuredConnection } : {}),
      ...canonicalMcpPayload(canonical), ...studioPayload(canonical),
    };
  } else {
    const definition = {
      version: builder.version, name: stem, connection_name: connectionName ?? builder.connection_name,
      description: null, output_filename: null, command_timeout_seconds: null, max_rows: null,
      columns: builder.columns, measures: builder.measures, filters: builder.filters, order_by: builder.order_by,
    };
    validateBuilder(definition, true);
    expected = renderBuilder(definition);
    canonical = importMcpBuilder(definition);
    payload = { ...definition, ...legacyStudioPayload(definition) };
  }
  if (queryText(query).trim() !== expected.trim()) fail("BUILDER_QUERY_MISMATCH", "Query changed since builder generation; save it as a plain query instead.");
  payload.workbenchBuilder = canonical;
  const compatibilityWarnings = builder.version === 2 ? studioCompatibilityWarnings(canonical) : [];
  if (compatibilityWarnings.length) payload.workbenchCompatibilityWarnings = compatibilityWarnings;
  payload.query_sha256 = queryHash(query);
  payload.builder_metadata_sha256 = builderMetadataHash(payload);
  return { files: [
    { name: `${stem}.dax`, content: query }, { name: `${stem}.dax.queryBuilder`, content: `${JSON.stringify(payload, null, 2)}\n` },
  ], ...(compatibilityWarnings.length ? { builderWarning: compatibilityWarnings.join(" ") } : {}) };
}
export async function saveQueryBuilder({ directory, name, query, builder, connectionName }) {
  const output = queryBuilderFiles({ name, query, builder, connectionName });
  const [saved, builderPath] = await writeExclusive(directory, output.files.map(file => [file.name, file.content]));
  return { path: saved, builderPath, ...(output.builderWarning ? { builderWarning: output.builderWarning } : {}) };
}

function boundedArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_ARTIFACT", `${label} must be an array.`);
  if (value.length > LIMIT.objects) fail("ARTIFACT_TOO_LARGE", `${label} exceeds the object limit.`);
  return value;
}

export async function loadContextBundle(directory, connectionName) {
  const root = await checkedPath(directory, { directory: true });
  const name = connection(connectionName, true);
  const budget = { bytes: 0 };
  const objects = [];
  const relationships = [];
  const warnings = [];
  const seen = new Set();
  const overview = {
    connectionName: name, hasOverview: false, hasFullContext: false, hasDataDictionary: false,
    counts: { tables: 0, columns: 0, measures: 0, relationships: 0 },
  };
  function add(kind, objectName, table, dataType) {
    identifier(objectName, "Context object name");
    if (table !== undefined) identifier(table, "Context table name");
    const id = JSON.stringify([kind, table ?? "", objectName]);
    if (seen.has(id)) return;
    if (objects.length >= LIMIT.objects) fail("ARTIFACT_TOO_LARGE", "Context contains too many schema objects.");
    seen.add(id);
    objects.push({ id, kind, name: objectName, ...(table ? { table } : {}),
      ...(dataType ? { dataType: text(dataType, "Data type", 80) } : {}) });
    overview.counts[`${kind}s`]++;
  }
  function dictionary(raw) {
    for (const table of boundedArray(raw.tables, "Tables")) {
      record(table, "Table");
      add("table", table.name);
      for (const column of boundedArray(table.columns, "Columns")) {
        record(column, "Column");
        add("column", column.name, table.name, column.data_type);
      }
    }
    for (const measure of boundedArray(raw.measures, "Measures")) {
      record(measure, "Measure");
      add("measure", measure.name, measure.table ?? measure.table_name);
    }
    for (const relationship of boundedArray(raw.relationships, "Relationships")) {
      record(relationship, "Relationship");
      const safe = {};
      for (const key of ["from_table", "from_column", "to_table", "to_column"]) {
        safe[key] = identifier(relationship[key], "Relationship endpoint");
      }
      for (const key of ["cardinality", "cross_filter_direction"]) {
        if (relationship[key] !== undefined && relationship[key] !== null) safe[key] = text(relationship[key], "Relationship metadata", 80);
      }
      if (relationship.is_active !== undefined) {
        if (typeof relationship.is_active !== "boolean") fail("INVALID_ARTIFACT", "Relationship is_active must be boolean.");
        safe.is_active = relationship.is_active;
      }
      if (relationships.length >= LIMIT.objects) fail("ARTIFACT_TOO_LARGE", "Too many relationships.");
      relationships.push(safe);
    }
  }
  const dictionaryFile = path.join(root, `${name}.data_dictionary.yaml`);
  if (await exists(dictionaryFile)) {
    dictionary(parseYaml(await readText(dictionaryFile, budget, LIMIT.fileBytes, root)));
    overview.hasDataDictionary = true;
  }
  for (const [suffix, flag] of [["_overview.md", "hasOverview"], [".md", "hasFullContext"]]) {
    const file = path.join(root, `${name}${suffix}`);
    if (!(await exists(file))) continue;
    let markdown = await readText(file, budget, LIMIT.fileBytes, root);
    overview[flag] = true;
    if (markdown.startsWith("---\n") || markdown.startsWith("---\r\n")) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
      if (!match) fail("INVALID_ARTIFACT", "Unterminated Markdown front matter.");
      const front = parseYaml(match[1]);
      if (!overview.hasDataDictionary) dictionary(front);
      markdown = markdown.slice(match[0].length);
    }
    // Only explicit schema headings are admitted; prose, tables, code and samples never leave this backend.
    let fence = null;
    let omittedSection = 0;
    for (const line of markdown.split(/\r?\n/)) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        continue;
      }
      if (fence) continue;
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!heading) continue;
      const level = heading[1].length;
      if (omittedSection && level <= omittedSection) omittedSection = 0;
      if (/\b(sample|samples|example|examples|result|results|values|credentials|secrets)\b/i.test(heading[2])) omittedSection = level;
      if (omittedSection || overview.hasDataDictionary) continue;
      const schema = /^(Table|Measure)\s*:\s*`([^`]+)`\s*$/i.exec(heading[2]);
      if (schema) add(schema[1].toLowerCase(), schema[2]);
    }
  }
  overview.counts.relationships = relationships.length;
  if (!overview.hasDataDictionary) warnings.push("No data dictionary found; Markdown-only schema is partial.");
  if (!overview.hasOverview && !overview.hasFullContext && !overview.hasDataDictionary) {
    fail("CONTEXT_NOT_FOUND", "No context companions exist for this connection.");
  }
  warnings.push("Context is metadata-only: prose, expressions, samples, suggested values and validation results are omitted.");
  return { overview, objects, relationships, warnings };
}

const SHARE_DICTIONARY_KEYS = new Set([
  "name", "model", "model_name", "connection_name", "description", "summary", "purpose", "notes", "business_rules",
  "tables", "columns", "measures", "relationships", "hierarchies", "levels", "filters", "recommended_filters",
  "kind", "type", "data_type", "dataType", "table", "table_name", "column", "column_name", "expression",
  "dax", "format", "format_string", "formatString", "display_folder", "displayFolder", "is_hidden", "isHidden",
  "grain", "units", "unit", "meaning", "caveats", "limitations", "is_key", "key_columns",
  "from_table", "from_column", "to_table", "to_column", "cardinality", "cross_filter_direction", "is_active",
  "operator", "required", "is_nullable", "sort_by_column", "sort_by", "ordinal", "confidence",
]);
function shareDictionary(value) {
  if (Array.isArray(value)) return value.map(shareDictionary);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => SHARE_DICTIONARY_KEYS.has(key))
    .map(([key, item]) => [key, shareDictionary(item)]));
}

// UI-only sharing reads named companions, never connection YAML or unrelated library trees.
export async function loadShareModelSources({ directory, connection: profile, modelContext, validatedQueries, skill,
  skillFile = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "skills", "dax-query", "SKILL.md") }) {
  const files = [], queries = [], coverage = [], budget = { bytes: 0 };
  const mark = (source, status, count, detail) => coverage.push({ source, status, count, detail });
  let root, name;
  const configured = /^(?:import:windows-msolap:|import:|configured:powerbi-rest:)[a-f0-9]{64}$/.test(profile?.id ?? "");
  if (directory && configured && (modelContext || validatedQueries)) {
    name = connection(profile?.name, true);
    if (!path.isAbsolute(directory) || /^[\\/]{2}/.test(directory))
      fail("UNSAFE_PATH", "Model sharing requires the configured local DAX MCP folder.");
    const matches = ["yaml", "yml"].some(extension => {
      const digest = createHash("sha256").update(`${path.resolve(directory, `${name}.${extension}`).toUpperCase()}\n${name}`).digest("hex");
      return [`import:windows-msolap:${digest}`, `import:${digest}`, `configured:powerbi-rest:${digest}`].includes(profile.id);
    });
    if (matches) root = await checkedPath(directory, { directory: true });
  }
  if (modelContext && root) {
    for (const [suffix, label] of [["_overview.md", "Model overview"], [".md", "Full model context"], [".data_dictionary.yaml", "Data dictionary"]]) {
      const file = path.join(root, `${name}${suffix}`);
      if (!(await exists(file))) { mark(label, "missing", 0, "No companion file found for this profile."); continue; }
      let content = await readText(file, budget, LIMIT.fileBytes, root);
      const output = `context/dax-query/${name}${suffix === ".data_dictionary.yaml" ? ".data_dictionary.json" : suffix}`;
      if (suffix.endsWith(".yaml")) {
        const dictionary = parseYaml(content);
        if (dictionary.connection_name !== undefined && dictionary.connection_name !== name)
          fail("CONTEXT_CONNECTION_MISMATCH", "The dictionary identifies another connection. Exclude DAX model context or correct the companion.");
        content = JSON.stringify(shareDictionary(dictionary), null, 2) + "\n";
      }
      files.push({ name: output, content });
      mark(label, "included", 1, suffix.endsWith(".yaml")
        ? "Metadata definitions only; samples, suggested values and validation outputs excluded."
        : "Written context, unredacted; may quote business values. Review before sending.");
    }
  } else mark("DAX model context", modelContext ? "unavailable" : "excluded", 0,
    modelContext ? "No exact configured DAX MCP profile match; no similarly named folder was substituted." : "Not selected.");
  if (validatedQueries && root) {
    const folder = path.join(root, `${name}.validated_queries`);
    if (!(await exists(folder))) mark("Validated query examples", "missing", 0, "No validated-query folder found for this profile.");
    else {
      await checkedPath(folder, { directory: true, root });
      const names = [], listing = await opendir(folder);
      let count = 0;
      for await (const entry of listing) {
        if (++count > LIMIT.files) fail("ARTIFACT_TOO_LARGE", "Too many files in the model's validated-query folder.");
        if (/\.(?:dax|ya?ml)$/i.test(entry.name)) {
          if (!entry.isFile()) fail("UNSAFE_PATH", "Validated-query companions must be regular files, not links or folders.");
          names.push(entry.name);
        }
      }
      const yaml = names.filter(file => /\.ya?ml$/i.test(file));
      const selected = [...yaml, ...names.filter(file => /\.dax$/i.test(file)
        && !yaml.some(sidecar => sidecar.replace(/\.ya?ml$/i, "").toLowerCase() === file.slice(0, -4).toLowerCase()))].sort();
      if (selected.length > LIMIT.entries) fail("ARTIFACT_TOO_LARGE", "Share at most 200 validated query examples per model.");
      for (const file of selected) {
        const target = path.join(folder, file);
        const raw = /\.ya?ml$/i.test(file) ? parseYaml(await readText(target, budget, LIMIT.fileBytes, root)) : {};
        const item = await readQueryInternal(target, budget, root);
        if (item.connectionName && item.connectionName !== name)
          fail("CONTEXT_CONNECTION_MISMATCH", "A validated query identifies another connection. Exclude validated examples or correct the companion.");
        queries.push({
          title: item.name, query: item.query, parameterDefinitions: item.parameters,
          description: typeof raw.description === "string" ? raw.description : "",
          documentation: typeof raw.documentation === "string" ? raw.documentation : "",
          sourceFile: file, connectionId: profile.id, connectionName: name, model: profile.model,
        });
      }
      mark("Validated query examples", queries.length ? "included" : "missing", queries.length,
        "Query definitions only; recorded result samples, validation outputs and sample parameter bindings are excluded.");
    }
  } else mark("Validated query examples", validatedQueries ? "unavailable" : "excluded", 0,
    validatedQueries ? "No exact configured DAX MCP profile match." : "Not selected.");
  if (skill) {
    if (await exists(skillFile)) {
      files.push({ name: "workflow/dax-query/SKILL.md", content: await readText(skillFile, budget) });
      mark("DAX query skill", "included", 1, "Local workflow instructions, shared as reference text; not installed or executed.");
    } else mark("DAX query skill", "missing", 0, "No local dax-query SKILL.md found.");
  } else mark("DAX query skill", "excluded", 0, "Not selected.");
  return { files, queries, coverage };
}
