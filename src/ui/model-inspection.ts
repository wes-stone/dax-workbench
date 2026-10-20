import type { ModelObject, ModelSchema } from "../contracts/workbench";

export function expressionKind(schema: ModelSchema, object: ModelObject): "definition" | "reference" | "documented" | "unavailable" {
  if (!object.expression) return "unavailable";
  if (schema.origin === "dictionary") return "documented";
  if (object.source?.startsWith("MDSCHEMA") || schema.coverage?.measureExpressions.status === "unavailable") return "reference";
  return object.source?.startsWith("TMSCHEMA") || schema.coverage?.source === "TMSCHEMA" ? "definition" : "reference";
}

export function expressionReferences(schema: ModelSchema, object: ModelObject): ModelObject[] {
  if (expressionKind(schema, object) !== "definition") return [];
  const found = new Map<string, ModelObject>();
  const same = (left: string | undefined, right: string) => left?.toLocaleLowerCase() === right.toLocaleLowerCase();
  // Skip strings/comments before recognizing references; this is text navigation, not engine lineage.
  const tokens = /"(?:[^"]|"")*"|\/\/[^\r\n]*|--[^\r\n]*|\/\*[\s\S]*?\*\/|('(?:[^']|'')*'|[\p{L}_][\p{L}\p{N}_]*)\s*(\[(?:[^\]]|\]\])*\])|(\[(?:[^\]]|\]\])*\])|'(?:[^']|'')*'/gu;
  for (const match of (object.expression ?? "").matchAll(tokens)) {
    if (/^(?:"|\/\/|--|\/\*)/.test(match[0])) continue;
    const table = match[1]?.replace(/^'|'$/g, "").replaceAll("''", "'"), field = match[2] ?? match[3];
    const name = field?.slice(1, -1).replaceAll("]]", "]");
    const candidates = schema.objects.filter(item => name
      ? same(item.name, name) && (table ? same(item.table, table) : item.kind === "measure")
      : item.kind === "table" && same(item.name, match[0].slice(1, -1).replaceAll("''", "'")));
    if (candidates.length === 1 && candidates[0].id !== object.id) found.set(candidates[0].id, candidates[0]);
  }
  return [...found.values()];
}

export function objectRelationships(schema: ModelSchema, object: ModelObject) {
  const table = object.kind === "table" ? object.name : object.table;
  return (schema.origin === "dictionary" ? [] : schema.relationships ?? []).filter(link => link.source === "TMSCHEMA_RELATIONSHIPS"
    && (object.kind === "table" ? link.fromTable === table || link.toTable === table
      : object.kind === "column" && (link.fromTable === table && link.fromColumn === object.name || link.toTable === table && link.toColumn === object.name)));
}
