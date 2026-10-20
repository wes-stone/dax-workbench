import { readFileSync } from "node:fs";

const artifact = new URL("../../engine/artifacts/dax_workbench_core.wasm", import.meta.url);
const ABI_VERSION = 1;
const SCHEMA_CAPACITY = 6;
const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const codec = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const schemas = new Map();
const relevantKeys = new Set([
  "version", "table", "columns", "measure", "fields", "filters", "orderBy", "id", "kind", "name",
  "dataType", "caption", "isCustom", "expression", "field", "operator", "value", "value2", "enabled",
  "isParameter", "isParameter2", "fieldId", "direction",
]);
function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

let engine;
try {
  engine = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(artifact))).exports;
  if (!(engine.memory instanceof WebAssembly.Memory)
    || !["alloc", "dealloc", "invoke"].every(key => typeof engine[key] === "function")) {
    throw new Error("The installed artifact does not expose the builder ABI.");
  }
} catch (cause) {
  throw failure("ENGINE_NOT_INSTALLED",
    "The Rust/WASM builder engine is missing or incompatible. Build/install engine/artifacts/dax_workbench_core.wasm.", cause);
}

// JSON has no undefined and Rust strings cannot contain lone UTF-16 surrogates.
// Tagged values and an escaped private-use range preserve both without changing
// valid Unicode, literal precision, or the native compiler's length semantics.
function encodeString(value) {
  return value.replace(/[\uD800-\uDFFF\u{F0000}-\u{F0800}]/gu, char => {
    const unit = char.codePointAt(0);
    return unit >= 0xF0000 ? `\u{F0800}${char}` : String.fromCodePoint(0xF0000 + unit - 0xD800);
  });
}
function decodeString(value) {
  return value.replace(/\u{F0800}[\s\S]|[\u{F0000}-\u{F07FF}]/gu,
    char => char.startsWith("\u{F0800}") ? char.slice(2) : String.fromCharCode(0xD800 + char.codePointAt(0) - 0xF0000));
}
function encode(value, active = new Set()) {
  if (value === undefined) return ["u"];
  if (value === null) return ["z"];
  if (typeof value === "string") return ["s", encodeString(value)];
  if (typeof value === "boolean") return ["b", value];
  if (typeof value === "number") return ["n", Number.isFinite(value) ? value : String(value)];
  if (typeof value !== "object") return ["x", String(value)];
  if (active.has(value)) throw failure("INVALID_BUILDER", "Builder properties cannot contain cycles.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      // Length-only wire values let Rust reject oversized arrays without copying
      // an already-invalid model into WASM memory.
      if (value.length > 100_000) return ["l", value.length];
      return ["a", Array.from(value, item => encode(item, active))];
    }
    const result = Object.create(null);
    // Unknown values are intentionally opaque: the public compiler ignores them,
    // but still checks every own property name for unsafe keys.
    for (const key of Object.keys(value)) {
      result[key] = relevantKeys.has(key) ? encode(value[key], active) : ["u"];
    }
    for (const key of relevantKeys) {
      if (!Object.hasOwn(result, key) && key in value) result[key] = encode(value[key], active);
    }
    return ["o", result, Object.hasOwn(value, "table")];
  } finally { active.delete(value); }
}
function decode(value) {
  if (typeof value === "string") return decodeString(value);
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = decode(value[key]);
  }
  return value;
}
function encodeSchemaValue(value) {
  return typeof value === "string" ? encodeString(value) : encode(value);
}

export function invokeBuilderCore(op, ...args) {
  const request = { abi: ABI_VERSION, op, args: [] };
  if (op === "schema.create" && Array.isArray(args[0]) && args[0].length <= 100_000) {
    // Schema metadata uses compact positional rows, avoiding hundreds of
    // thousands of transient property maps in the WASM decoder. No validation,
    // name folding, matching, or binding happens on this side of the ABI.
    request.schemaRows = Array.from(args[0], item => item == null ? encode(item)
      : [encodeSchemaValue(item.id), encodeSchemaValue(item.kind), encodeSchemaValue(item.name), encodeSchemaValue(item.table), encodeSchemaValue(item.dataType)]);
  } else {
    request.args = args.map(value => encode(value));
  }
  const bytes = codec.encode(JSON.stringify(request));
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw failure("ENGINE_PROTOCOL_ERROR", "Engine request exceeds its byte limit.");
  const pointer = engine.alloc(bytes.byteLength) >>> 0;
  if (!pointer) throw failure("ENGINE_MEMORY_LIMIT", "The Rust/WASM builder engine could not allocate its request.");
  let outputPointer = 0;
  let outputLength = 0;
  try {
    new Uint8Array(engine.memory.buffer, pointer, bytes.byteLength).set(bytes);
    const packed = engine.invoke(pointer, bytes.byteLength);
    outputPointer = Number(packed >> 32n) >>> 0;
    outputLength = Number(packed & 0xFFFFFFFFn);
    if (!outputPointer || outputPointer + outputLength > engine.memory.buffer.byteLength) {
      throw failure("ENGINE_PROTOCOL_ERROR", "The Rust/WASM builder engine returned an invalid response buffer.");
    }
    const response = decode(JSON.parse(decoder.decode(new Uint8Array(engine.memory.buffer, outputPointer, outputLength))));
    if (!response.ok) {
      const { name, message, code } = response.error;
      const error = name === "TypeError" ? new TypeError(message) : new Error(message);
      if (code !== undefined) error.code = code;
      throw error;
    }
    return response.value;
  } finally {
    if (outputPointer) engine.dealloc(outputPointer, outputLength);
    engine.dealloc(pointer, bytes.byteLength);
  }
}

function retainedSchema(objects) {
  if (schemas.has(objects)) {
    const id = schemas.get(objects);
    schemas.delete(objects);
    schemas.set(objects, id);
    return id;
  }
  if (schemas.size >= SCHEMA_CAPACITY) {
    const [prior, id] = schemas.entries().next().value;
    invokeBuilderCore("schema.release", id);
    schemas.delete(prior);
  }
  const id = invokeBuilderCore("schema.create", objects);
  schemas.set(objects, id);
  return id;
}

export function validateIndexedBuilderSchema(input, objects) {
  // On first registration, draft errors must precede schema errors, as before.
  // Warm edits make one call and never serialize or scan the complete schema.
  if (!schemas.has(objects)) input = invokeBuilderCore("normalizeBuilder", input);
  return invokeBuilderCore("schema.validate", input, retainedSchema(objects));
}

export function validateReadQuery(query) {
  return invokeBuilderCore("validateQuery", query);
}

export function searchBuilderSchema(objects, term, limit = 30) {
  // This is JS's original slice end coercion, not builder/schema validation.
  const end = Math.min(50, Math.max(1, limit));
  const indices = invokeBuilderCore("schema.search", retainedSchema(objects), term, Number.isNaN(end) ? 0 : Math.trunc(end));
  return indices.map(index => objects[index]);
}

export function releaseBuilderSchema(objects) {
  if (!schemas.has(objects)) return false;
  const id = schemas.get(objects);
  schemas.delete(objects);
  return invokeBuilderCore("schema.release", id);
}

export function getBuilderEngineHealth() {
  return Object.freeze({ ...invokeBuilderCore("health"), artifact: artifact.href, wasmBytes: engine.memory.buffer.byteLength });
}

export const BUILDER_ENGINE = Object.freeze({
  runtime: "rust-wasm", abiVersion: ABI_VERSION, compiler: "dax-workbench-core", schemaIndexCapacity: SCHEMA_CAPACITY,
});
if (invokeBuilderCore("health").abiVersion !== ABI_VERSION) {
  throw failure("ENGINE_NOT_INSTALLED", "The installed Rust/WASM builder engine uses an incompatible ABI.");
}
