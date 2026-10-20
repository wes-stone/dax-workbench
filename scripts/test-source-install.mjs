import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { stageInstall } from "./stage-install.mjs";
import { filesUnder, verifyEntries, privacyMarkers } from "./release/release-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(tmpdir(), "dax-source-check-"));
let native, wb, server, browser;
try {
    const release = await stageInstall(path.join(temp, "package"));
    const manifest = JSON.parse(await readFile(path.join(release, "release-manifest.json"), "utf8"));
    const entries = Object.fromEntries(await Promise.all((await filesUnder(release))
        .map(async name => [name, await readFile(path.join(release, ...name.split("/")))])));
    verifyEntries(entries, manifest, privacyMarkers(root));
    const home = path.join(temp, "copilot-home");
    const install = () => spawnSync("powershell", ["-NoProfile", "-File", path.join(root, "scripts", "install.ps1"),
        "-CopilotHome", home], { encoding: "utf8", windowsHide: true, timeout: 120000 });
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
        ["starter:contoso-sales", 36], ["starter:contoso-monthly", 12],
        ["starter:contoso-december", 3], ["starter:contoso-ranking", 3],
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
    }
    const { generateProject } = await load("src/integrations/project-generation.mjs");
    const project = await generateProject({ target: "python", title: "Synthetic example", sources: [
        wb.projects.source(wb.activeDocument(), 0, false),
    ] });
    const runner = project.files.find(file => file.name === "run_queries.py");
    assert.match(runner.content, /format_table/);
    assert.match(runner.content, /--format/);
    assert.match(project.files.find(file => file.name === "README.md").content, /--format table/);
    const { startLoopbackServer } = await load("src/extension/loopback-server.mjs");
    server = await startLoopbackServer({ workbench: wb, assetsRoot: path.join(payload, "dist") });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    const errors = [], blocked = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        const action = url.pathname === "/api/action" ? request.postDataJSON()?.action : null;
        if (url.origin !== server.origin || action && !["authoring.view", "authoring.ack"].includes(action)) {
            blocked.push(action ?? "external-request");
            await route.abort();
        } else await route.continue();
    });
    await page.goto(server.url);
    await page.getByRole("button", { name: /Use queries/ }).first().waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    assert.equal(wb.state.runs.length, 4, "Opening the UI must not run a query.");
    assert.deepEqual(await filesUnder(payload), manifest.files
        .filter(file => file.path.startsWith("payload/")).map(file => file.path.slice(8)).sort());
    console.log("Fresh isolated install, overwrite refusal, generic/off-by-default state, four native Contoso recipes, WASM builder, Python table template and browser startup passed. No real models or personal state accessed.");
} finally {
    await browser?.close();
    await server?.close();
    await wb?.close();
    await native?.close();
    await rm(temp, { recursive: true, force: true });
}
