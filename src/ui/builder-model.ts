import type { BuilderDefinition, BuilderField, BuilderFilter, ModelItem, ModelObject } from "../contracts/workbench";

export const FIELD_DRAG_TYPE = "application/x-dax-model-field";
export const BUILDER_DRAG_TYPE = "application/x-dax-builder-item";
export const EMPTY_BUILDER: BuilderDefinition = { version: 2, fields: [], filters: [], orderBy: [] };

export function fieldLabel(field: Pick<BuilderField, "table" | "name">) {
  return field.table ? `${field.table}[${field.name}]` : `[${field.name}]`;
}

export function builderField(object: ModelObject): BuilderField | null {
  if (object.kind !== "column" && object.kind !== "measure") return null;
  if (object.kind === "column" && !object.table) return null;
  return { id: object.id, kind: object.kind, name: object.name, table: object.table, dataType: object.dataType };
}

export function explorerObjects(objects: ModelObject[], showHidden: boolean): ModelObject[] {
  if (showHidden) return objects;
  const hiddenTables = new Set(objects.filter(object => object.kind === "table" && object.isHidden).map(object => object.name));
  // Measure visibility is independent of its home table's visibility.
  const measureTables = new Set(objects.filter(object => object.kind === "measure" && object.isHidden === false).map(object => object.table));
  return objects.filter(object => {
    if (object.kind === "table") return !object.isHidden || measureTables.has(object.name);
    if (object.isHidden) return false;
    return !object.table || !hiddenTables.has(object.table) || (object.kind === "measure" && object.isHidden === false);
  });
}

export function expandBuilderFields(item: ModelItem, objects: ModelObject[], dependencies = true): BuilderField[] {
  const selected = item.kind === "hierarchy" ? [...item.levels].sort((a, b) => a.ordinal - b.ordinal).map(level => {
    const column = objects.find(object => object.id === level.columnId && object.kind === "column");
    if (!column) throw new Error(`The hierarchy level ${level.name} has no verified column. Refresh metadata.`);
    return column;
  }) : item.kind === "table" ? explorerObjects(objects, false).filter(object => object.table === item.name) : [item];
  const result: BuilderField[] = [], visited = new Set<string>(), visiting = new Set<string>();
  function append(object: ModelObject) {
    if (visiting.has(object.id)) throw new Error("The model's sort-column dependencies contain a cycle. Refresh metadata.");
    if (visited.has(object.id)) return;
    const field = builderField(object);
    if (!field) return;
    visiting.add(object.id); result.push(field);
    if (dependencies && object.sortByColumnId) {
      const sort = objects.find(candidate => candidate.id === object.sortByColumnId && candidate.kind === "column" && candidate.table === object.table);
      if (!sort) throw new Error(`The sort column for ${object.name} is unavailable. Refresh metadata.`);
      append(sort);
    }
    visiting.delete(object.id); visited.add(object.id);
  }
  selected.forEach(append);
  return result;
}

export function addBuilderItems(definition: BuilderDefinition, items: ModelItem[], objects: ModelObject[], target: "field" | "filter", index?: number): BuilderDefinition {
  const existing = new Set(target === "field" ? definition.fields.map(field => field.id) : definition.filters.map(filter => filter.field.id));
  const added: BuilderField[] = [];
  for (const item of items) {
    for (const field of expandBuilderFields(item, objects, target === "field")) {
      if (!existing.has(field.id)) { existing.add(field.id); added.push(field); }
    }
  }
  if (target === "filter") return { ...definition, filters: [...definition.filters, ...added.map(newFilter)] };
  const fields = [...definition.fields];
  fields.splice(index ?? fields.length, 0, ...added);
  return { ...definition, fields, orderBy: [...definition.orderBy, ...added.filter(field => field.kind === "column").map(field => ({ fieldId: field.id, direction: "ASC" as const }))] };
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

export function removeField(definition: BuilderDefinition, id: string): BuilderDefinition {
  const field = definition.fields.find(item => item.id === id);
  return {
    ...definition,
    fields: definition.fields.filter(item => item.id !== id),
    orderBy: definition.orderBy.filter(item => item.fieldId !== id),
    filters: field?.isCustom ? definition.filters.filter(item => item.field.id !== id) : definition.filters,
  };
}

export function typeFamily(dataType?: string): "text" | "number" | "date" | "boolean" | "unknown" {
  if (/bool/i.test(dataType ?? "")) return "boolean";
  if (/date|time/i.test(dataType ?? "")) return "date";
  if (/int|decimal|currency|double|float|numeric|number|real/i.test(dataType ?? "")) return "number";
  if (/string|text|char/i.test(dataType ?? "")) return "text";
  return "unknown";
}

const common = [
  ["Is", "Is"], ["IsNot", "Is not"], ["IsBlank", "Is blank"], ["IsNotBlank", "Is not blank"],
] as const;
const comparison = [
  ["GreaterThan", "> Greater than"], ["GreaterThanOrEqual", ">= Greater than or equal"],
  ["LessThan", "< Less than"], ["LessThanOrEqual", "<= Less than or equal"], ["Between", "Between"],
] as const;
const text = [
  ["StartsWith", "Starts with"], ["DoesNotStartWith", "Does not start with"],
  ["Contains", "Contains"], ["DoesNotContain", "Does not contain"],
  ["In", "In"], ["NotIn", "Not in"],
] as const;

export function filterOperators(field: BuilderField): ReadonlyArray<readonly [string, string]> {
  const family = typeFamily(field.dataType);
  const operators: Array<readonly [string, string]> = family === "text" ? [...common, ...text] : [...common, ...comparison, ["In", "In"], ["NotIn", "Not in"]];
  return operators.filter(([operator]) => field.kind !== "measure" || !["In", "NotIn"].includes(operator));
}

export function newFilter(field: BuilderField): BuilderFilter {
  return { id: crypto.randomUUID(), field, operator: typeFamily(field.dataType) === "text" ? "Contains" : "Is", value: "", enabled: true };
}

export function replaceCalendarRange(filters: BuilderFilter[], [lower, upper]: [BuilderFilter, BuilderFilter]): BuilderFilter[] {
  return filters.filter(item => item.id !== upper.id).flatMap(item => item.id === lower.id ? [lower, upper] : [item]);
}

export function applyStagedFilters(definition: BuilderDefinition, original: BuilderFilter[], filters: BuilderFilter[]): BuilderDefinition {
  if (JSON.stringify(definition.filters) !== JSON.stringify(original))
    throw new Error("Builder filters changed while this panel was open. Cancel and reopen to edit the latest filters; nothing was overwritten.");
  return { ...definition, filters: structuredClone(filters) };
}

export function filterSummary(filter: BuilderFilter): string {
  const operator = filterOperators(filter.field).find(([value]) => value === filter.operator)?.[1] ?? filter.operator;
  if (["IsBlank", "IsNotBlank"].includes(filter.operator)) return operator;
  const literal = (value: string | undefined, parameter?: boolean) => parameter ? `@${value || "name"}` : value === ""
    ? typeFamily(filter.field.dataType) === "text" ? '"" (empty text)' : "(enter a value)" : value ?? "(not set)";
  if (["In", "NotIn"].includes(filter.operator)) {
    const values = filter.value.replaceAll("\r", "").split("\n");
    return `${filter.operator === "In" ? "Include" : "Exclude"} ${values.length} value${values.length === 1 ? "" : "s"}: ${values.slice(0, 2).map(value => literal(value)).join(", ")}${values.length > 2 ? ", ..." : ""}`;
  }
  return `${operator} ${literal(filter.value, filter.isParameter)}${filter.operator === "Between" ? ` and ${literal(filter.value2, filter.isParameter2)}` : ""}`;
}

export function fieldSearch(object: ModelObject, search: string): boolean {
  const term = search.trim().toLocaleLowerCase();
  return !term || `${object.table ?? ""} ${object.name} ${object.displayFolder ?? ""} ${object.description ?? ""}`.toLocaleLowerCase().includes(term);
}

export interface FieldFolder { name: string; path: string; fields: ModelObject[]; folders: FieldFolder[] }
export function fieldFolders(objects: ModelObject[]): FieldFolder {
  const root: FieldFolder = { name: "", path: "", fields: [], folders: [] };
  for (const object of objects) {
    const paths = [...new Set((object.displayFolder ?? "").split(";"))];
    for (const path of paths) {
      let folder = root;
      const segments = path.split("\\").filter(Boolean);
      for (const name of segments) {
        let child = folder.folders.find(item => item.name === name);
        if (!child) { child = { name, path: `${folder.path}\\${name}`, fields: [], folders: [] }; folder.folders.push(child); }
        folder = child;
      }
      folder.fields.push(object);
    }
  }
  return root;
}
