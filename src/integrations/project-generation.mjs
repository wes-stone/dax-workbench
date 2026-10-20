import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stringify } from "yaml";
import { fail } from "../application/policy.mjs";
import { renderQueryTemplate } from "./libraries.mjs";

export const PROJECT_TARGETS = ["power-query", "python", "streamlit", "pack", "example", "studio"];
export const hashProject = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value ?? null)).digest("hex");
export const projectSlug = value => String(value).normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "query-project";
const json = value => JSON.stringify(value, null, 2) + "\n";
const mText = value => `"${String(value).replaceAll("#", "#(#)").replaceAll('"', '""').replaceAll("\r", "#(cr)").replaceAll("\n", "#(lf)")}"`;
const resultHeadersM = (await readFile(new URL("./project-templates/result-headers.pq", import.meta.url), "utf8")).trimEnd();
export function nativeParameterNames(query) {
    const code = query.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|\/\/[^\r\n]*|--[^\r\n]*|\/\*[\s\S]*?\*\//g, " ");
    return [...new Set([...code.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]))];
}
export function queryForM(source) {
    if (source.parameterDefinitions && Object.keys(source.parameterDefinitions).length)
        return renderQueryTemplate({ query: source.query, definitions: source.parameterDefinitions, values: source.parameters }).query;
    if (Object.keys(source.parameters).length || nativeParameterNames(source.query).length)
        throw fail("PARAMETER_EXPORT_UNSUPPORTED", "Power Query requires literal DAX or a query-pack template with explicit parameter values. Native @parameters cannot be exported as M.");
    return source.query;
}
export function powerQuery(source, { server = "", database = "" } = {}) {
    const query = queryForM(source);
    return `let\n    Server = ${mText(server || "<ANALYSIS_SERVICES_OR_XMLA_ENDPOINT>")},\n    Database = ${mText(database || "<MODEL_NAME>")},\n    Source = AnalysisServices.Database(Server, Database, [Query = ${mText(query)}, Implementation = "2.0"]),\n${resultHeadersM}\nin\n    CleanHeaders\n`;
}
export async function generateProject({ target, title, sources, server, database }) {
    if (!PROJECT_TARGETS.includes(target) || !sources.length) throw fail("INVALID_PROJECT", "Choose an output and at least one source query.");
    const warnings = ["Generated source files are plaintext. Credentials and captured result rows are not included."];
    const isContoso = source => source.connectionId === "demo:contoso" && source.connectionKind === "synthetic";
    const hasContoso = sources.some(isContoso), onlyContoso = sources.every(isContoso);
    if (hasContoso)
        warnings.push(target === "power-query"
            ? "Contoso is a built-in synthetic fixture, not an external model. Exported M needs your own compatible model and query; it does not include the synthetic engine."
            : "Contoso is a built-in synthetic fixture. Python, notebooks and Streamlit include an offline retail runner for the four shipped Contoso recipes, without credentials or model access. Other DAX is rejected, not silently replaced with sample results.");
    const files = [];
    if (target === "power-query") {
        if (sources[0].connectionKind === "powerbi-rest") warnings.push("This query-only REST connection is not an Analysis Services endpoint. Configure an XMLA endpoint before refreshing this M template.");
        if (!server || !database) warnings.push("Unbound M template: fill in Server and Database before refreshing. Copying M does not install or refresh an Excel query.");
        return { files: [{ name: `${projectSlug(title)}.pq`, content: powerQuery(sources[0], { server, database }) }], warnings };
    }
    const hasNativeParameters = sources.some(source => !source.parameterDefinitions && nativeParameterNames(source.query).length);
    if (hasNativeParameters && target === "pack")
        throw fail("PARAMETER_EXPORT_UNSUPPORTED", "Portable query packs use typed {{parameter}} definitions. Convert native @parameters explicitly before exporting a pack; no bindings were dropped or rewritten.");
    for (const source of sources) files.push({ name: `queries/${source.id}.dax`, content: source.query });
    const queries = sources.map(source => ({
        id: source.id, display_name: source.title, connection_name: source.connectionName, file: `queries/${source.id}.dax`,
        parameters: source.parameterDefinitions ?? {}, workbench: {
            revision: source.revision, model: source.model ?? null, evidence: source.evidence,
        },
    }));
    if (!hasNativeParameters) files.push({ name: "pack.yaml", content: stringify({ pack_version: "1.0", name: title, queries }) });
    else warnings.push("Native @parameters require Workbench-managed execution. A pack.yaml was not generated because the portable pack format cannot preserve native bindings.");
    const manifest = { version: 1, title, queries: sources.map(source => ({
        id: source.id, title: source.title, file: `queries/${source.id}.dax`,
        connection_name: source.connectionName, parameters: source.parameterDefinitions ?? {},
        native_parameters: !source.parameterDefinitions && nativeParameterNames(source.query).length > 0,
        ...(isContoso(source) ? { execution: { kind: "contoso-retail", version: 1 } } : {}),
    })) };
    files.push({ name: "project.json", content: json(manifest) });
    files.push({ name: "parameters.json", content: json(Object.fromEntries(sources.map(source => [source.id, source.parameters]))) });
    const connectionNames = [...new Set(sources.map(source => source.connectionName))];
    files.push({ name: "connection.example.json", content: json({
        connections: Object.fromEntries(connectionNames.map((name, index) => [name, {
            adomd_directory: "<DIRECTORY_CONTAINING_MICROSOFT_ANALYSISSERVICES_ADOMDCLIENT_DLL>",
            connection_string_env: connectionNames.length === 1 ? "DAX_CONNECTION_STRING" : `DAX_CONNECTION_${index + 1}`,
        }])),
    }) });
    files.push({ name: ".gitignore", content: ".venv/\n__pycache__/\nconnection.local.json\n.env\nresults/\n" });
    const template = name => readFile(new URL(`./project-templates/${name}`, import.meta.url), "utf8");
    files.push({ name: "run_queries.py", content: await template("run_queries.py") });
    if (hasContoso) files.push({ name: "contoso.py", content: await template("contoso.py") });
    files.push({ name: "streamlit_app.py", content: await template("streamlit_app.py") });
    files.push({ name: "pyproject.toml", content: `[project]\nname = "${projectSlug(title).toLowerCase()}"\nversion = "0.1.0"\nrequires-python = ">=3.11,<3.14"\ndependencies = ["ipykernel==6.30.1", "streamlit==1.50.0"]\n\n[project.optional-dependencies]\nindependent = ["pyadomd==0.1.1", "pythonnet==3.0.5"]\nnotebook = ["ipykernel==6.30.1"]\n\n[tool.uv]\npackage = false\n` });
    files.push({ name: "notebook.ipynb", content: json({
        nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python (uv .venv)", language: "python" } },
        cells: [
            { cell_type: "markdown", metadata: {}, source: ["# " + title + "\n",
                "From this project folder, run `uv sync`, then select this project's `.venv` interpreter as the notebook kernel in your editor, not a global Python kernel. The kernel and Streamlit are installed by default; no notebook extras or editor Install prompt are needed.\n",
                "The kernel label alone does not select an interpreter. Check its path against `uv run --frozen --no-sync python -c \"import sys; print(sys.executable)\"`.\n",
                `Opening this notebook does not execute queries. ${isContoso(sources[0]) ? "This query runs against the included offline Contoso retail fixture, without credentials or a running Workbench. Only the four shipped recipes are supported." : "For a real model, run `uv sync --extra independent` and configure your own ADOMD-compatible connection before executing."}`] },
            { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: ["from run_queries import execute_query, project\n", "project()['queries']"] },
            { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: [`result = execute_query(${JSON.stringify(sources[0].id)})\n`, "result"] },
        ],
    }) });
    files.push({ name: "README.md", content: `# ${title}

## Takeaway

Run \`uv sync\`, select this project's \`.venv\` notebook kernel, then run a query. The notebook kernel and Streamlit are installed by default. ${onlyContoso ? "The included Contoso retail fixture runs without credentials, external services or a running Workbench." : "Real-model queries still require your own compatible connection and authentication."}

## Evidence

Generated from explicitly selected DAX queries. Source files and any results you later save are plaintext. No credentials or captured rows were exported. ${hasContoso ? "contoso.py generates invented Desks, Chairs and Lamps sales for January-December 2025: illustrative USD revenue and physical units sold, not captured business results." : ""} Successful execution is not business validation.

## Workbench

Open this project in Artifacts. Choose Set up environment, then Run Python${target === "python" ? "" : " or Launch app"}. All managed Python setup and execution use uv, with no pip or global-Python fallback. Setup runs \`uv --no-config sync --no-dev\` in this project's folder; it does not query a model. Runs and app launches use \`uv run --frozen --no-sync\` against the reviewed .venv and uv.lock, without installing or changing dependencies. Streamlit waits for Run query. Managed execution uses the pinned sources, original models, and Workbench read-only limits. It stops when its owning Workbench closes.

## Independent use

Install uv first. If Python 3.11-3.13 is not already available, install it explicitly with \`uv python install 3.13\`. Workbench itself does not install global tools or download Python. Run the following commands from this project folder:

| Action | Command |
|---|---|
| Set up notebook, runner and app | \`uv sync\` |
| List query IDs without model access | \`uv run --frozen --no-sync python run_queries.py --list\` |
| Run the first query${isContoso(sources[0]) ? " (offline Contoso)" : " (after connection setup)"} | \`uv run --frozen --no-sync python run_queries.py --query ${sources[0].id}\` |
| Read the first query as a terminal table | \`uv run --frozen --no-sync python run_queries.py --query ${sources[0].id} --format table\` |
| Launch the included app | \`uv run --frozen --no-sync streamlit run streamlit_app.py --server.address 127.0.0.1\` |
| Add the real-model adapter, only when needed | \`uv sync --extra independent\` |

Setup resolves dependencies and writes uv.lock. Keep that lock with the project. The run commands use \`--no-sync\` to preserve any independent adapter extra and keep dependency changes separate from execution. Plain \`uv sync\` always retains the kernel and Streamlit. Do not use an editor's pip installer or install packages into global Python.

${hasContoso ? "Queries explicitly marked as Contoso in project.json use the bundled offline fixture. It computes the four fixed recipes from invented retail sales with exact decimals, rejecting edited unsupported DAX and all parameters. It never opens connection.local.json or contacts a model. Real connections never fall back to synthetic data.\n\n" : ""}For real-model queries only, install the Microsoft ADOMD client and the appropriate .NET runtime, run \`uv sync --extra independent\`, copy connection.example.json to connection.local.json and configure each named connection's environment variable. This file is ignored by Git. Authentication is independent; Workbench credentials, REST profiles and isolated CLR4 Windows MSOLAP sessions are not portable.

The CLI requires a query ID so opening a project never executes every query. Open notebook.ipynb in your editor and select this project's uv-managed .venv interpreter as its kernel. The notebook includes instructions for checking the interpreter; its display label alone does not bind a kernel. Opening a notebook never runs its cells.

## Parameters and results

Edit parameters.json for typed pack parameters. Native @parameters require the Workbench-managed connection; independent execution rejects them instead of silently substituting text. Values were included only when explicitly selected during export. Missing required values fail before querying. The runner defaults to a typed JSON envelope (\`--format json\`), keeps exact decimals and integers as strings, and reports truncation. Streamlit displays strings without numeric coercion. It does not claim provider FE/SE timings.

Add \`--format table\` for aligned terminal columns, exact values without numeric rounding, a row count, and the execution mode/notice when present. Headers use the same readable captions as Streamlit; JSON retains the original names. Nulls display as \`null\`, empty strings as \`""\`, and backslashes/control characters are escaped to keep each row on one line. Truncated results are labeled. \`--list\` remains non-executing JSON regardless of the format option. Notebook, app and managed JSON behavior is unchanged.

## Filters

These are execution-boundary settings, not inferred analytical query filters.

| Field | Operator | Exact value(s) |
|---|---|---|
| Export captured rows | = | \`false\` |
| Export credentials | = | \`false\` |
| Include offline Contoso fixture | = | \`${hasContoso}\` |
| Execute on import or notebook open | = | \`false\` |

**Excluded:** Private captures, authentication state and unselected queries.

**Filter assumptions:** Query scope remains in each selected DAX file. The offline fixture accepts only its four complete recipes; it does not reinterpret arbitrary DAX or infer filters.

## Limits

Python 3.11-3.13 and uv must be available. Dependency setup needs package-index access or cached packages; it does not install global tools. Offline Contoso is not a general DAX evaluator. Real-model execution requires separate configuration; generated files do not grant model access.

## Files changed outside Workbench

External changes, including a lock updated by independent setup, block managed setup/run; create a new reviewed project from Workbench or run the edited project independently. Workbench never overwrites your edits. Removing or archiving its Artifacts reference does not delete this folder.
` });
    if (!onlyContoso) warnings.push("Real-model independent execution needs separate ADOMD-compatible configuration; REST and isolated Windows MSOLAP profiles are not portable credentials.");
    return { files, warnings };
}
