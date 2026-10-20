import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fail, safeError } from "../application/policy.mjs";

export async function projectQueryBridge(execute) {
    const token = randomBytes(32).toString("base64url");
    let origin, stopped = false, busy = false;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        const send = (status, value) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); } };
        try {
            if (stopped || req.headers.host !== new URL(origin).host || req.headers.origin)
                throw fail("PROJECT_ORIGIN", "This connection is available only to its managed local project.");
            const provided = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
            if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
                return send(401, { error: { code: "UNAUTHORIZED", message: "Relaunch the project from Workbench." } });
            if (req.method !== "POST" || req.url !== "/query") return send(404, { error: { code: "NOT_FOUND", message: "Only this project's captured queries are available." } });
            if (busy) throw fail("PROJECT_BUSY", "Wait for the current project query to finish.");
            if (req.headers["content-type"] !== "application/json") throw fail("INVALID_INPUT", "Use a JSON query request.");
            let body = "", bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 64 * 1024) throw fail("REQUEST_TOO_LARGE", "Project parameter requests are limited to 64 KiB.");
                body += chunk;
            }
            let request;
            try { request = JSON.parse(body); } catch { throw fail("INVALID_JSON", "Invalid project query request."); }
            if (!request || Object.keys(request).some(key => !["queryId", "values"].includes(key)) || typeof request.queryId !== "string")
                throw fail("INVALID_INPUT", "Choose a captured query ID and parameter values.");
            if (busy || stopped) throw fail("PROJECT_BUSY", "The project connection is busy or closed.");
            busy = true;
            try { send(200, await execute(request.queryId, request.values ?? {})); } finally { busy = false; }
        } catch (error) { send(400, { error: safeError(error) }); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, token, async close() {
        stopped = true;
        const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections(); await done;
    } };
}
