import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fail } from "../application/policy.mjs";

export class NativeClient extends EventEmitter {
    constructor({ root, artifactsRoot, executable, provider }) {
        super(); this.root = root; this.artifactsRoot = artifactsRoot; this.executable = executable;
        this.provider = provider; this.pending = new Map(); this.child = null; this.starting = null;
    }
    async start() {
        if (this.starting) return this.starting;
        if (this.child) return;
        this.starting = this.#start();
        try { await this.starting; } finally { this.starting = null; }
    }
    async #start() {
        const candidates = this.executable ? [this.executable] : [path.join(this.root, "native", "publish", "DaxWorkbench.Engine.exe")];
        const executable = candidates.find(p => existsSync(p));
        if (!executable) throw fail("NATIVE_NOT_INSTALLED", "The Rust engine is not built. Run npm run build:native, then reopen the workbench.");
        const child = spawn(executable, ["--artifacts", this.artifactsRoot, ...(this.provider ? ["--provider", this.provider] : [])],
            { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.child = child;
        let buffer = Buffer.alloc(0);
        child.stdout.on("data", chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            let index;
            while ((index = buffer.indexOf(10)) >= 0) {
                const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
                if (line.length > 2 * 1024 * 1024) { this.#protocolFailure(); return; }
                if (!line.toString("utf8").trim()) continue;
                let message;
                try { message = JSON.parse(line.toString("utf8")); } catch { this.#protocolFailure(); return; }
                if (message.id) {
                    const pending = this.pending.get(String(message.id));
                    if (pending) {
                        clearTimeout(pending.timer); this.pending.delete(String(message.id));
                        if (message.error) pending.reject(fail(message.error.code ?? "NATIVE_ERROR", message.error.message ?? "Native operation failed."));
                        else pending.resolve(message.result);
                    }
                } else if (message.event) this.emit("notification", message);
            }
            if (buffer.length > 2 * 1024 * 1024) this.#protocolFailure();
        });
        // Native logs are not forwarded to the transcript or the iframe.
        child.stderr.on("data", () => {});
        child.on("error", () => this.#failed(fail("NATIVE_START_FAILED", "Unable to start the native companion.")));
        child.on("exit", () => {
            if (this.child === child) {
                this.child = null;
                this.#failed(fail("NATIVE_DISCONNECTED", "The native companion disconnected. Reopen the workbench; unfinished runs will not restart."));
            }
        });
        const health = await this.request("health", {}, 15_000);
        if (health?.protocolVersion !== 1) {
            await this.close(); throw fail("PROTOCOL_MISMATCH", "The native companion uses an incompatible protocol. Reinstall a matching build.");
        }
        return health;
    }
    #protocolFailure() {
        this.#failed(fail("PROTOCOL_ERROR", "The native companion sent an invalid or oversized protocol message."));
        this.child?.kill();
    }
    #failed(error) {
        for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
        this.pending.clear(); this.emit("unavailable", error);
    }
    request(method, params = {}, timeout = method === "schema.get" ? 60_000 : 30_000) {
        if (!this.child) return Promise.reject(fail("NATIVE_UNAVAILABLE", "The native companion is unavailable."));
        const id = randomUUID(), line = JSON.stringify({ id, method, params }) + "\n";
        if (Buffer.byteLength(line) > 2 * 1024 * 1024) return Promise.reject(fail("MESSAGE_TOO_LARGE", "This request exceeds the native protocol size limit."));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(fail("NATIVE_RESPONSE_TIMEOUT", "The native operation did not acknowledge completion. Its cancellation state is uncertain."));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(line, error => {
                if (!error) return;
                clearTimeout(timer); this.pending.delete(id);
                reject(fail("NATIVE_WRITE_FAILED", "The native companion could not receive this request."));
            });
        });
    }
    async close() {
        const child = this.child;
        if (!child) return;
        this.child = null;
        this.#failed(fail("NATIVE_CLOSED", "The workbench closed."));
        child.stdin.end();
        await new Promise(resolve => {
            const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
            child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
    }
}
