import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { stageInstall } from "./stage-install.mjs";
import { filesUnder, sha256, verifyEntries, privacyMarkers } from "./release/release-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function verifyInstallation(release, { reviewOnly = false, prerequisiteDirectory } = {}) {
const temp = await mkdtemp(path.join(tmpdir(), "dax-source-check-"));
let native, wb, server, browser;
try {
    const manifest = JSON.parse(await readFile(path.join(release, "release-manifest.json"), "utf8"));
    const entries = Object.fromEntries(await Promise.all((await filesUnder(release))
        .map(async name => [name, await readFile(path.join(release, ...name.split("/")))])));
    verifyEntries(entries, manifest, privacyMarkers(root));
    const prerequisites = manifest.prerequisites ? JSON.parse(entries[manifest.prerequisites]) : null;
    const home = path.join(temp, "copilot-home");
    const install = () => spawnSync("powershell", ["-NoProfile", "-File", path.join(release, "Install.ps1"),
        "-CopilotHome", home, ...(reviewOnly ? ["-AllowReviewPackage"] : []),
        ...(prerequisites ? prerequisiteDirectory ? ["-PrerequisiteDirectory", prerequisiteDirectory] : ["-DownloadMicrosoftPrerequisites"] : [])],
        { encoding: "utf8", windowsHide: true, timeout: 300000 });
    const first = install();
    assert.equal(first.status, 0, first.stderr || first.error?.message);
    const second = install();
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already installed/);
    const payload = path.join(home, "extensions", "dax-copilot-workbench");
    const load = name => import(pathToFileURL(path.join(payload, ...name.split("/"))).href);
    const { DISTRIBUTION_PROFILE: profile } = await load("src/shared/distribution-profile.mjs");
    assert.equal(profile.id, "generic");
    assert.equal(profile.agentReadEnabled, false);
    assert.equal(profile.agentResultsEnabled, false);
    const state = path.join(home, ...profile.stateDirectory);
    assert(!state.startsWith(payload + path.sep));
    await mkdir(state, { recursive: true });
    const { NativeClient } = await load("src/extension/native-client.mjs");
    class SyntheticOnlyClient extends NativeClient {
        request(method, params = {}, timeout) {
            if (method === "connections.list") return Promise.resolve({ connections: [{
                id: "demo:contoso", name: "Contoso (synthetic demo)", kind: "synthetic", model: "Demo Sales",
                capabilities: { query: { status: "supported" }, schema: { status: "supported" } },
            }] });
            if (method.startsWith("connection")) throw new Error("Local connection access is prohibited in this check.");
            if (["schema.get", "query.execute"].includes(method) && params.connectionId !== "demo:contoso")
                throw new Error("Only synthetic Contoso requests are permitted.");
            return super.request(method, params, timeout);
        }
    }
    native = new SyntheticOnlyClient({ root: payload, artifactsRoot: state });
    await native.start();
    assert.equal((await native.request("health")).engine, "rust");
    const { Workbench } = await load("src/application/workbench.mjs");
    wb = new Workbench({ id: "source-check", native, artifactsRoot: state });
    await wb.initialize();
    assert.equal(wb.state.runs.length, 0);
    assert.equal(wb.activeDocument().connectionId, "demo:contoso");
    assert.equal(wb.state.agentReadEnabled, false);
    assert.equal(wb.state.agentResultsEnabled, false);
    assert.deepEqual(wb.state.library.entries, []);
    await assert.rejects(wb.runQuery(undefined, "agent"), /disabled|enable|access/i);
    const { generateBuilderQuery } = await load("src/integrations/query-builder.mjs");
    for (const [id, count] of [
        ["starter:contoso-monthly", 12], ["starter:contoso-december", 3],
        ["starter:contoso-ranking", 3], ["starter:contoso-sales", 36],
    ]) {
        await wb.action("library.entry.open", { id });
        if (id !== "starter:contoso-sales")
            assert.equal(generateBuilderQuery(wb.activeDocument().builder).query, wb.activeDocument().query);
        const started = await wb.runQuery();
        await wb.running.get(started.runId);
        const run = wb.state.runs.find(item => item.id === started.runId);
        assert.equal(run.status, "completed", JSON.stringify(run.error));
        assert.equal(run.rowCount, count);
        assert.equal(run.truncated, false);
        if (id === "starter:contoso-monthly") {
            const page = await wb.page(run.id, run.resultSets[0].id, 0, 100);
            assert.deepEqual(page.rows[0], ["2025-01-01T00:00:00.0000000", "46714.05", "474"]);
            assert.deepEqual(page.rows[11], ["2025-12-01T00:00:00.0000000", "87972.30", "837"]);
        }
        if (id === "starter:contoso-sales") {
            const page = await wb.page(run.id, run.resultSets[0].id, 0, 100);
            assert.equal(page.rows.reduce((sum, row) => sum + BigInt(row[2].replace(".", "")), 0n), 80811810n);
            assert.equal(page.rows.reduce((sum, row) => sum + Number(row[3]), 0), 7866);
            await wb.action("run.pin", { runId: run.id });
        }
    }
    const { generateProject } = await load("src/integrations/project-generation.mjs");
    const project = await generateProject({ target: "python", title: "Synthetic example", sources: [
        wb.projects.source(wb.activeDocument(), 0, false),
    ] });
    const runner = project.files.find(file => file.name === "run_queries.py");
    assert.match(runner.content, /format_table/);
    assert.match(runner.content, /--format/);
    assert.match(project.files.find(file => file.name === "README.md").content, /--format table/);
    const pyproject = project.files.find(file => file.name === "pyproject.toml").content;
    assert.match(pyproject, /ipykernel==6\.30\.1/);
    assert.match(pyproject, /streamlit==1\.50\.0/);
    const projectPath = path.join(temp, "offline-project");
    await mkdir(projectPath);
    for (const file of project.files) {
        const target = path.join(projectPath, ...file.name.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
    }
    const python = args => spawnSync("python", [path.join(projectPath, "run_queries.py"), ...args],
        { cwd: projectPath, encoding: "utf8", windowsHide: true, timeout: 30000,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(python([]).status, 2);
    const listed = python(["--list"]);
    assert.equal(listed.status, 0, listed.stderr);
    const listedQueries = JSON.parse(listed.stdout);
    const projectQuery = Array.isArray(listedQueries) ? listedQueries[0] : listedQueries.queries?.[0];
    assert(projectQuery, "Generated project must list its selected query.");
    const queryName = typeof projectQuery === "string" ? projectQuery : projectQuery.name ?? projectQuery.id;
    assert(queryName, "Generated query identifier is missing.");
    const result = python(["--query", queryName, "--format", "table"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Revenue/);
    await verifyWorkbook(load);
    const { startLoopbackServer } = await load("src/extension/loopback-server.mjs");
    server = await startLoopbackServer({ workbench: wb, assetsRoot: path.join(payload, "dist") });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [], blocked = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        const action = url.pathname === "/api/action" ? request.postDataJSON()?.action : null;
        if (url.origin !== server.origin || action && !["authoring.view", "authoring.ack",
            "pivot.layout.set", "chart.set"].includes(action)) {
            blocked.push(action ?? "external-request");
            await route.abort();
        } else await route.continue();
    });
    await page.goto(server.url);
    await page.getByRole("button", { name: /Use queries/ }).first().waitFor();
    await page.getByRole("tab", { name: "Explore", exact: true }).click();
    await page.getByRole("checkbox", { name: "Revenue", exact: true }).check();
    await page.getByRole("checkbox", { name: "Product", exact: true }).check();
    await page.getByRole("table", { name: "Local pivot", exact: true }).waitFor();
    await page.getByText("36 of 36 captured rows", { exact: true }).waitFor();
    await page.getByText("Layout saved", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Chart", exact: true }).click();
    await page.getByRole("combobox", { name: "Chart", exact: true }).selectOption("line");
    await page.getByRole("combobox", { name: "X field", exact: true }).selectOption("column-0");
    await page.getByRole("combobox", { name: "Y field", exact: true }).selectOption("column-2");
    await page.getByRole("combobox", { name: "Legend / series", exact: true }).selectOption("column-1");
    await page.getByRole("combobox", { name: "Aggregation", exact: true }).selectOption("sum");
    await page.getByRole("button", { name: "Apply chart", exact: true }).click();
    await page.getByRole("img", { name: "line chart, 36 points, 3 visible series, sum aggregation", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    assert.equal(wb.state.runs.length, 4, "Opening the UI must not run a query.");
    const acquired = prerequisites?.packages.flatMap(pkg => [
        { path: pkg.retainedPath, bytes: pkg.bytes, sha256: pkg.sha256 }, ...pkg.files]) ?? [];
    assert.deepEqual(await filesUnder(payload), [...manifest.files
        .filter(file => file.path.startsWith("payload/")).map(file => file.path.slice(8)), ...acquired.map(file => file.path)].sort());
    for (const file of acquired) {
        const bytes = await readFile(path.join(payload, ...file.path.split("/")));
        assert.equal(bytes.length, file.bytes);
        assert.equal(sha256(bytes), file.sha256);
    }
    await browser.close(); browser = undefined;
    await server.close(); server = undefined;
    await wb.close(); wb = undefined;
    await native.close(); native = new SyntheticOnlyClient({ root: payload, artifactsRoot: state });
    await native.start();
    wb = new Workbench({ id: "source-check", native, artifactsRoot: state });
    await wb.initialize();
    assert.equal(wb.state.runs.length, 4);
    assert.equal(wb.state.agentReadEnabled, false);
    assert.equal(wb.state.agentResultsEnabled, false);
    const pinned = wb.state.runs.find(run => run.pinned);
    assert(pinned?.retained);
    assert.equal((await wb.page(pinned.id, pinned.resultSets[0].id, 0, 100)).rows.length, 36);
    return { passed: true, installedFromPackage: true, sourceRestaging: false,
        liveQueriesExecuted: 0, personalStateAccessed: false,
        microsoftPrerequisites: prerequisites ? { acquisition: prerequisiteDirectory ? "exact-local-packages" : "official-nuget-download",
            packages: prerequisites.packages.length, runtimeFiles: acquired.length - prerequisites.packages.length,
            hashesVerified: true, originalsRetained: true } : null,
        checks: ["fresh-install", "overwrite-refusal", "external-state", "off-by-default-permissions",
            "four-native-contoso-recipes", "wasm-builder", "offline-python-table", "notebook-dependencies",
            "excel-export-precision", "browser-pivot-and-chart", "pinned-result-reopening", "immutable-payload"] };
} finally {
    await browser?.close();
    await server?.close();
    await wb?.close();
    await native?.close();
    await rm(temp, { recursive: true, force: true });
}
}

async function verifyWorkbook(load) {
    const { createResultWorkbook } = await load("src/shared/result-excel.mjs");
    const { default: ExcelJS } = await load("node_modules/exceljs/dist/exceljs.min.js");
    const columns = [
        { name: "[Revenue]", dataType: "Decimal" }, { name: "[Large]", dataType: "Int64" },
        { name: "[Text]", dataType: "String" }, { name: "[Date]", dataType: "DateTime" },
        { name: "[Blank]", dataType: "String" },
    ];
    const data = { columns, rows: [["46714.05", "9007199254740993", "=1+1", "2025-01-01T00:00:00.0000000", null]] };
    const run = { id: "synthetic-export", status: "completed", revision: 1, connectionId: "demo:contoso",
        startedAt: "2025-01-01T00:00:00Z", warnings: [], resultSets: [{ id: "set", columns, rowCount: 1 }] };
    const exported = await createResultWorkbook(data, run, "set");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.bytes);
    const sheet = workbook.getWorksheet("Results");
    assert.equal(sheet.getCell("A2").value, 46714.05);
    assert.equal(sheet.getCell("B2").value, "9007199254740993");
    assert.equal(sheet.getCell("C2").value, "=1+1");
    assert.equal(sheet.getCell("C2").formula, undefined);
    assert.equal(sheet.getCell("D2").value, data.rows[0][3]);
    assert.equal(sheet.getCell("E2").value, null);
    assert.equal(exported.preservedNumbers, 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const temp = await mkdtemp(path.join(tmpdir(), "dax-source-stage-"));
    try {
        const release = await stageInstall(path.join(temp, "package"));
        console.log(JSON.stringify(await verifyInstallation(release), null, 2));
    } finally { await rm(temp, { recursive: true, force: true }); }
}
