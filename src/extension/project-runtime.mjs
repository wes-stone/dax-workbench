import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fail, safeError } from "../application/policy.mjs";
import { hashProject } from "../integrations/project-generation.mjs";
import { safeProjectDirectory } from "../integrations/project-files.mjs";
import { projectQueryBridge } from "./project-query-bridge.mjs";

const exec = promisify(execFile);
export function projectEnvironment(extra = {}, environment = process.env) {
    const result = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "COMSPEC"])
        if (environment[name]) result[name] = environment[name];
    return { ...result, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", UV_PYTHON_DOWNLOADS: "never", UV_NO_CONFIG: "1", UV_SYSTEM_CERTS: "1", ...extra };
}
export function setupEnvironment(environment = process.env) {
    const result = projectEnvironment({}, environment);
    if (environment.UV_DEFAULT_INDEX) {
        let index;
        try { index = new URL(environment.UV_DEFAULT_INDEX); }
        catch { throw fail("PROJECT_PACKAGE_INDEX", "UV_DEFAULT_INDEX must name a credential-free HTTPS package index."); }
        if (index.protocol !== "https:" || index.username || index.password || index.search || index.hash)
            throw fail("PROJECT_PACKAGE_INDEX", "Managed setup requires a credential-free HTTPS package index. Configure UV_DEFAULT_INDEX without credentials, query parameters or fragments.");
        result.UV_DEFAULT_INDEX = index.href;
    }
    return result;
}
async function locateUv() {
    let found;
    try {
        const result = await exec(process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "where.exe") : "/usr/bin/which", ["uv"], { windowsHide: true, timeout: 5000 });
        found = result.stdout.trim().split(/\r?\n/).find(value => path.isAbsolute(value) && (process.platform !== "win32" || /\.exe$/i.test(value)));
    } catch (error) { throw fail("UV_REQUIRED", `uv is required for all Python setup and execution. Install uv and make Python 3.11-3.13 available, then retry. Workbench never falls back to pip or global Python. ${error.code ?? ""}`); }
    if (!found || !(await lstat(found)).isFile()) throw fail("UV_REQUIRED", "A uv executable was not found. Install uv and make Python 3.11-3.13 available, then retry. There is no pip or global-Python fallback.");
    return found;
}
async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve)); return port;
}
export class ProjectRuntime {
    constructor(projects, { spawnProcess = spawn, locate = locateUv, execute = exec, bridge = projectQueryBridge } = {}) {
        this.projects = projects; this.spawn = spawnProcess; this.locate = locate; this.exec = execute; this.bridge = bridge;
        this.active = new Map(); this.logs = new Map(); this.runs = new Map();
    }
    details(id) { return { log: this.logs.get(id) ?? "" }; }
    log(id, content) {
        const previous = this.logs.get(id) ?? "";
        const bytes = Buffer.from(previous + content);
        let start = Math.max(0, bytes.length - 64 * 1024);
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        this.logs.set(id, bytes.subarray(start).toString("utf8"));
    }
    trackRun(id, runId) { if (!this.runs.has(id)) this.runs.set(id, new Set()); this.runs.get(id).add(runId); }
    untrackRun(id, runId) { this.runs.get(id)?.delete(runId); }
    async start(entry, operation, queryId) {
        if (this.projects.wb.closed) throw fail("PROJECT_UNAVAILABLE", "This Workbench is closing.");
        if (entry.archived) throw fail("PROJECT_ARCHIVED", "Restore this project reference before using it.");
        if (!["python", "streamlit", "pack"].includes(entry.target)) throw fail("PROJECT_NOT_RUNNABLE", "These files are opened in their destination application, not executed by Workbench.");
        if (this.active.has(entry.id)) throw fail("PROJECT_BUSY", "A setup or process is already active for this project.");
        if (operation === "setup" && [...this.active.values()].some(job => job.operation === "setup")) throw fail("PROJECT_BUSY", "Wait for the other environment setup to finish.");
        if (operation !== "setup" && !entry.activity.environmentReady) throw fail("PROJECT_SETUP_REQUIRED", "Set up this project's environment first.");
        if (operation === "launch" && !["streamlit", "pack"].includes(entry.target)) throw fail("PROJECT_NOT_APP", "Choose a Streamlit app or query pack to launch from Workbench. Python projects can launch their included app independently.");
        if (operation === "run" && !entry.sources.some(source => source.id === queryId)) throw fail("PROJECT_QUERY", "Choose one captured query to run.");
        const job = { operation, cancelled: false, child: null, bridge: null, task: null };
        this.active.set(entry.id, job);
        try { await this.projects.verify(entry); }
        catch (error) { this.active.delete(entry.id); throw error; }
        this.logs.set(entry.id, "");
        job.task = this.work(entry.id, operation, queryId, job).catch(async error => {
            this.log(entry.id, `${safeError(error).message}\n`);
            await this.terminate(job);
            if (job.done) await job.done.catch(processError => this.log(entry.id, `${safeError(processError).message}\n`));
            await this.projects.activity(entry.id, { status: job.cancelled ? "stopped" : "failed", message: error.message, url: undefined });
        }).finally(async () => {
            try { if (job.bridge) await job.bridge.close(); }
            finally { this.active.delete(entry.id); this.projects.wb.publish(); }
        });
        void job.task.catch(error => this.projects.wb.emit("operationError", safeError(error)));
        return { id: entry.id, operation, started: true, executed: false };
    }
    async work(id, operation, queryId, job) {
        await this.projects.activity(id, { status: operation === "setup" ? "setting-up" : "starting", message: operation === "setup" ? "uv is installing the reviewed dependencies into this project's isolated environment. No model query runs." : "Starting the reviewed project with uv.", url: undefined });
        const executable = await this.locate(), entry = this.projects.get(id);
        if (job.cancelled || this.projects.wb.closed) throw fail("PROJECT_STOPPED", "Project operation stopped before launch.");
        await this.projects.verify(entry);
        let args, extra = {}, port;
        if (operation === "setup") args = ["--no-config", "sync", "--no-dev"];
        else {
            await safeProjectDirectory(path.join(entry.directory, ".venv"));
            job.bridge = await this.bridge((queryId, values) => this.projects.execute(this.projects.get(id), queryId, values));
            extra = { DAX_PROJECT_BRIDGE: job.bridge.origin, DAX_PROJECT_TOKEN: job.bridge.token };
            if (operation === "launch") {
                port = await freePort();
                args = ["--no-config", "run", "--frozen", "--no-sync", "streamlit", "run", "streamlit_app.py",
                    "--server.address", "127.0.0.1", "--server.port", String(port), "--server.headless", "true", "--browser.gatherUsageStats", "false",
                    "--server.fileWatcherType", "none"];
            } else args = ["--no-config", "run", "--frozen", "--no-sync", "python", "-I", "run_queries.py", "--query", queryId];
        }
        if (job.cancelled || this.projects.wb.closed) throw fail("PROJECT_STOPPED", "Project operation stopped before launch.");
        job.child = this.spawn(executable, args, { cwd: entry.directory, shell: false, windowsHide: true,
            env: operation === "setup" ? setupEnvironment() : projectEnvironment(extra), stdio: ["ignore", "pipe", "pipe"] });
        const child = job.child;
        const done = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", code => resolve(code));
        });
        job.done = done;
        void done.catch(() => {});
        child.stdout.on("data", chunk => this.log(id, chunk.toString()));
        child.stderr.on("data", chunk => this.log(id, chunk.toString()));
        let readiness;
        if (operation === "launch") readiness = this.ready(id, port, job).catch(async error => {
            if (!job.cancelled) {
                this.log(id, `${error.message}\n`);
                job.readinessError = error;
                await this.terminate(job);
            }
        });
        else if (operation === "run") await this.projects.activity(id, { status: "running", message: "Running the selected captured query through the Workbench engine." });
        const code = await done;
        job.exited = true;
        if (readiness) await readiness;
        if (job.cancelled) {
            await this.projects.activity(id, { status: "stopped", message: "The owned process stopped. Generated files were preserved.", url: undefined });
            return;
        }
        if (code !== 0 || job.readinessError) throw fail("PROJECT_PROCESS_FAILED", job.readinessError?.message ?? `The project process exited with code ${code}. Review Activity, correct the prerequisite, and retry.`);
        if (operation === "setup") {
            const file = path.join(entry.directory, "uv.lock"), info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw fail("PROJECT_LOCK", "Setup did not produce a supported dependency lock.");
            const sha256 = hashProject(await readFile(file));
            await this.projects.serial(async () => {
                const entries = structuredClone(this.projects.entries), current = entries.find(item => item.id === id);
                current.files = [...current.files.filter(item => item.name !== "uv.lock"), { name: "uv.lock", sha256 }];
                current.revision++;
                current.activity = { status: "ready", environmentReady: true, message: "Environment ready. No model query was executed." };
                await this.projects.commit(entries);
            });
        } else await this.projects.activity(id, { status: "completed", message: "Process completed. Query success is not business validation.", url: undefined });
    }
    async ready(id, port, job) {
        const url = `http://127.0.0.1:${port}`;
        for (let attempt = 0; attempt < 60; attempt++) {
            if (job.cancelled || job.exited || job.child.exitCode !== null) return;
            if ((this.logs.get(id) ?? "").includes(url)) {
                try {
                    const response = await fetch(`${url}/_stcore/health`, { signal: AbortSignal.timeout(1000), redirect: "error" });
                    if (response.ok && (await response.text()).trim() === "ok" && !job.cancelled && job.child.exitCode === null) {
                        await this.projects.activity(id, { status: "running", message: "App ready on localhost. Use Run query in the app to retrieve data.", url });
                        return;
                    }
                } catch (error) {
                    if (attempt === 59) throw fail("PROJECT_NOT_READY", `The app did not become ready. ${error.message}`);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw fail("PROJECT_NOT_READY", "The app did not report a healthy local address. Review Activity and retry.");
    }
    async terminate(job) {
        const child = job.child;
        if (!child || job.exited || child.exitCode !== null || !Number.isInteger(child.pid)) return;
        if (process.platform === "win32") {
            try { await this.exec(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); }
            catch (error) { if (child.exitCode === null && !job.exited) throw error; }
        } else child.kill("SIGTERM");
    }
    async stop(id) {
        this.projects.get(id);
        const job = this.active.get(id);
        if (!job) return { id, stopped: true };
        job.cancelled = true;
        for (const runId of this.runs.get(id) ?? []) await this.projects.wb.action("query.cancel", { runId }, "ui");
        await this.terminate(job);
        await job.task;
        return { id, stopped: true };
    }
    async openFolder(entry) {
        if (process.platform !== "win32") throw fail("UNSUPPORTED_PLATFORM", `Open this folder in your file manager: ${entry.directory}`);
        await safeProjectDirectory(entry.directory);
        await this.exec(path.join(process.env.SystemRoot, "explorer.exe"), [entry.directory], { windowsHide: false, timeout: 5000 });
        return { opened: true };
    }
    async close() {
        await Promise.all([...this.active.keys()].map(id => this.stop(id)));
        this.logs.clear();
    }
}
