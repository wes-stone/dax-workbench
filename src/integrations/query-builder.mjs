import { invokeBuilderCore, validateIndexedBuilderSchema } from "../engine/builder-core.mjs";
export {
  BUILDER_ENGINE, getBuilderEngineHealth, searchBuilderSchema, releaseBuilderSchema,
} from "../engine/builder-core.mjs";

export const BUILDER_OPERATORS = Object.freeze([
  "Is", "IsNot", "StartsWith", "DoesNotStartWith", "Contains", "DoesNotContain",
  "GreaterThan", "GreaterThanOrEqual", "LessThan", "LessThanOrEqual",
  "IsBlank", "IsNotBlank", "Between", "In", "NotIn",
]);
export const BUILDER_START = "/* START QUERY BUILDER */";
export const BUILDER_END = "/* END QUERY BUILDER */";
export const quoteBuilderTable = value => `'${value.replaceAll("'", "''")}'`;
export const quoteBuilderObject = value => `[${value.replaceAll("]", "]]")}]`;
export const builderReference = field => `${field.kind === "column" || field.table ? quoteBuilderTable(field.table) : ""}${quoteBuilderObject(field.name)}`;

export const parseBuilderReference = (value, column = false) => invokeBuilderCore("parseBuilderReference", value, column);
export const normalizeBuilderOperator = value => invokeBuilderCore("normalizeBuilderOperator", value);
export const normalizeBuilder = input => invokeBuilderCore("normalizeBuilder", input);
export const validateBuilderDraft = input => invokeBuilderCore("validateBuilderDraft", input);
export const validateMeasureExpression = value => invokeBuilderCore("validateMeasureExpression", value);
export const builderDataType = field => invokeBuilderCore("builderDataType", field);
export const defaultBuilderOperator = field => invokeBuilderCore("defaultBuilderOperator", field);
export const builderParameterName = value => invokeBuilderCore("builderParameterName", value);
export const hasBuilderParameters = input => invokeBuilderCore("hasBuilderParameters", input);
export const collectBuilderParameters = input => invokeBuilderCore("collectBuilderParameters", input);
export const builderLiteral = (value, field) => invokeBuilderCore("builderLiteral", value, field);
export const validateBuilderSchema = (input, objects) => validateIndexedBuilderSchema(input, objects);
export const generateBuilderQuery = input => invokeBuilderCore("generateBuilderQuery", input);
