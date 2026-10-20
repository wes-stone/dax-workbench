export const BUNDLED_CONTEXT_VERSION = "generic:4";
const month = { id: "demo-column-0", kind: "column", table: "Demo Sales", name: "Month", dataType: "DateTime" };
const product = { id: "demo-column-1", kind: "column", table: "Demo Sales", name: "Product", dataType: "String" };
const revenue = { id: "demo-measure-revenue", kind: "measure", table: "Demo Sales", name: "Total Revenue", dataType: "Decimal" };
const units = { id: "demo-measure-units", kind: "measure", table: "Demo Sales", name: "Units Sold", dataType: "Int64" };
const recipes = [
    {
        id: "starter:contoso-monthly", title: "01 - Monthly performance", dimension: month, measures: [revenue, units],
        description: "12 monthly retail totals: revenue and units sold, with matching builder selections.",
        period: "January through December 2025", grain: "One month across all three products; 12 rows",
        order: { fieldId: month.id, direction: "ASC" }, orderText: "'Demo Sales'[Month] ASC",
    },
    {
        id: "starter:contoso-december", title: "02 - December product snapshot", dimension: product, measures: [revenue, units],
        description: "Three products in December, filtered in DAX and sorted by revenue.",
        period: "December 2025", grain: "One product in December; 3 rows",
        order: { fieldId: revenue.id, direction: "DESC" }, orderText: "[Total Revenue] DESC",
        filter: { id: "demo-december", field: month, operator: "Is", value: "2025-12-01", enabled: true },
    },
    {
        id: "starter:contoso-ranking", title: "03 - Annual revenue ranking", dimension: product, measures: [revenue],
        description: "Three products ranked by full-year revenue; a compact Python/notebook handoff.",
        period: "January through December 2025", grain: "One product across the year; 3 rows",
        order: { fieldId: revenue.id, direction: "DESC" }, orderText: "[Total Revenue] DESC",
    },
];
const recipeEntry = recipe => ({
    id: recipe.id, title: recipe.title, description: recipe.description,
    collectionId: "starter:contoso", source: "starter", connectionId: "demo:contoso",
    connectionName: "Contoso (synthetic demo)", model: "Demo Sales",
    builder: structuredClone({ version: 2, fields: [recipe.dimension, ...recipe.measures],
        filters: recipe.filter ? [recipe.filter] : [], orderBy: [recipe.order] }),
    query: `/* START QUERY BUILDER */
EVALUATE
SUMMARIZECOLUMNS(
    'Demo Sales'[${recipe.dimension.name}],
${recipe.filter ? "    KEEPFILTERS(TREATAS({DATE(2025, 12, 1)}, 'Demo Sales'[Month])),\n" : ""}${recipe.measures.map(field => `    "${field.name}", 'Demo Sales'[${field.name}]`).join(",\n")}
)
ORDER BY
    ${recipe.orderText}
/* END QUERY BUILDER */`,
    documentation: `# ${recipe.title}

## Purpose

${recipe.description} Opening this starter does not execute it. Use Run explicitly.

## Scope

| Setting | Value |
|---|---|
| Source | Built-in Contoso retail fixture / Demo Sales: Desks, Chairs and Lamps |
| Period | ${recipe.period} |
| Grain | ${recipe.grain} |
| Measure / units | Total Revenue: illustrative USD, exact decimal.${recipe.measures.includes(units) ? " Units Sold: number of physical items sold." : ""} |

## Filters

${recipe.filter ? "| Field | Operator | Exact value(s) |\n|---|---|---|\n| 'Demo Sales'[Month] | = | `DATE(2025, 12, 1)` |" : "No filters applied."}

**Excluded:** Real business data.${recipe.filter ? " January-November rows are excluded by the query." : ""}

**Filter assumptions:** The shipped recipe's scope is encoded in its DAX, not inferred from a chart.

## Definitions

Total Revenue is SUM('Demo Sales'[Revenue]).${recipe.measures.includes(units) ? " Units Sold is SUM('Demo Sales'[Units]).\nUnits are additive across products and months; they are not customer counts." : ""}
The builder's fields, filter and sorting generate the displayed query.

## Caveats

Contoso supports four fixed recipes, not arbitrary DAX. The matching shipped builder
definitions run; changing their fields, expressions, filter values or sorting may
produce unsupported DAX. Comments and whitespace do not change the recipe.
Field-value lookups and model previews still require a real model.

Use queries can hand this query to Python or a notebook. Managed execution uses
the synthetic connection after explicit setup. The exported Python project
includes an offline retail fixture for all four recipes. Run uv sync, then use
its CLI, notebook or Streamlit app without credentials or a running Workbench.
Arbitrary DAX still requires your own compatible model.

## Technical details

This is a deterministic synthetic recipe, not business evidence. Opening the
starter or previewing its output files does not execute it.
`,
});
export const bundledStarterLibrary = connection => connection?.id === "demo:contoso" ? {
    collections: [{ id: "starter:contoso", name: "Try Contoso", parentId: null, source: "starter" }],
    entries: [{
        id: "starter:contoso-sales", title: "Contoso sales sample", collectionId: "starter:contoso", source: "starter",
        connectionId: "demo:contoso", connectionName: "Contoso (synthetic demo)", model: "Demo Sales",
        description: "Run 36 invented rows without model credentials; explore a local pivot or chart.",
        query: "EVALUATE 'Demo Sales'",
        documentation: `# Contoso sales sample

## Purpose

Try typed results, local pivots and charts without connecting to a real model.
Opening this query never runs it. Click Run explicitly.

## Scope

| Setting | Value |
|---|---|
| Source | Built-in Contoso retail fixture: Desks, Chairs and Lamps |
| Period | January through December 2025 |
| Grain | One row per month and product; 36 invented rows |
| Measure / units | Revenue: illustrative USD, exact decimal. Units: physical items sold, integer count. |

Month is a date and Product is text. These are not actual product results.

## Filters

| Field | Operator | Exact value(s) |
|---|---|---|
| Connection | = | \`demo:contoso\` |
| Table | = | \`Demo Sales\` |
| Parameters | = | \`{}\` |

**Excluded:** Real customer, account and model data.

**Filter assumptions:** No model filters are applied. Chart and pivot filters
operate on the captured rows, not on the model.

## Interpretation

Run the query, open Explore, and check Product, Revenue and Units. Try number
formatting and Show rows. In Chart, choose Line, Month on X, Revenue on Y,
Product for the legend, and Sum aggregation; click Apply chart.

## Caveats

The built-in demo accepts this raw query and three distinct shipped recipes:
monthly performance, December product snapshot and annual revenue ranking.
It is not a general DAX evaluator. Only the matching recipe builder definitions
execute; arbitrary edits, column lookups and model previews need a real model.
Parameters are unsupported. The six DAX basics starters become
available on other connections and also require a real DAX engine.
Use queries previews M/Python files without running them. Exported Python
includes the offline retail fixture; uv sync installs its notebook kernel and
Streamlit by default. Exported M needs your own compatible model.
Workbench-managed Python uses the original connection after separate setup.
`,
    }, ...recipes.map(recipeEntry)],
} : null;
export const legacyStarterEntries = () => [];
export const bundledKnowledgeRecords = () => [];
