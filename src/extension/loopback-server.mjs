import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fail, safeError } from "../application/policy.mjs";
import { ARTIFACT_LIMITS } from "../application/artifacts-validation.mjs";
import { openResultInExcel } from "./result-file-opener.mjs";
import { launchExcel } from "./excel-launcher.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" };
export async function startLoopbackServer({ workbench, assetsRoot, onAskCopilot = null, onReviewDocumentation = null, onReviewContent = null, onOfficeHandoff = null, openExcel = launchExcel }) {
    const token = randomBytes(32).toString("base64url"), clients = new Set();
    let origin;
    const sameToken = provided => {
        if (typeof provided !== "string") return false;
        const a = Buffer.from(provided), b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
    };
    const send = (res, status, value) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(value));
    };
    const server = createServer(async (req, res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
        try {
            if (req.headers.host !== new URL(origin).host) throw fail("INVALID_HOST", "Invalid loopback host.");
            const url = new URL(req.url, origin);
            if (req.headers.origin && req.headers.origin !== origin) throw fail("INVALID_ORIGIN", "Cross-origin workbench requests are not allowed.");
            if (url.pathname === "/favicon.ico" && ["GET", "HEAD"].includes(req.method)) { res.writeHead(204); res.end(); return; }
            if (url.pathname.startsWith("/api/")) {
                const supplied = req.headers["x-dax-token"] ?? (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null) ?? (url.pathname === "/api/events" ? url.searchParams.get("token") : null);
                if (!sameToken(supplied)) { send(res, 401, { error: { code: "UNAUTHORIZED", message: "Reopen the DAX Workbench canvas to establish a secure local connection." } }); return; }
                if (req.method === "POST" && url.pathname === "/api/artifacts/upload") {
                    if (req.headers.origin !== origin) throw fail("INVALID_ORIGIN", "Artifact uploads require the matching canvas origin.");
                    if (String(req.headers["content-type"]).split(";")[0].trim().toLowerCase() !== "application/octet-stream")
                        throw fail("INVALID_CONTENT_TYPE", "Artifact uploads require application/octet-stream.");
                    const length = req.headers["content-length"];
                    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > ARTIFACT_LIMITS.maxFileBytes))
                        throw fail("ARTIFACT_TOO_LARGE", "Upload at most 64 MiB per file.");
                    const revision = url.searchParams.get("expectedRevision");
                    if (revision === null || !/^(?:0|[1-9][0-9]*)$/.test(revision))
                        throw fail("INVALID_ARTIFACT", "Use the current artifact catalog revision.");
                    const chunks = []; let count = 0;
                    for await (const chunk of req) {
                        count += chunk.length;
                        if (count > ARTIFACT_LIMITS.maxFileBytes) throw fail("ARTIFACT_TOO_LARGE", "Upload at most 64 MiB per file.");
                        chunks.push(chunk);
                    }
                    const result = await workbench.uploadArtifact({
                        collectionId: url.searchParams.get("collectionId"), expectedRevision: Number(revision), name: url.searchParams.get("name"),
                    }, Buffer.concat(chunks, count), "ui");
                    send(res, 200, { result }); return;
                }
                if (req.method === "GET" && url.pathname === "/api/artifacts/content") {
                    const output = await workbench.artifactContent(url.searchParams.get("id"), url.searchParams.get("inline") === "1", "ui");
                    const encoded = encodeURIComponent(output.fileName).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
                    res.writeHead(200, {
                        "Content-Type": output.mimeType, "Content-Length": output.bytes.length,
                        "Content-Disposition": `${output.inline ? "inline" : "attachment"}; filename="artifact"; filename*=UTF-8''${encoded}`,
                        "Content-Security-Policy": "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; sandbox",
                        "Cross-Origin-Resource-Policy": "same-origin",
                    });
                    res.end(output.bytes); return;
                }
                if (req.method === "GET" && url.pathname === "/api/bootstrap") { send(res, 200, { token, state: workbench.snapshot() }); return; }
                if (req.method === "GET" && url.pathname === "/api/state") { send(res, 200, workbench.snapshot()); return; }
                if (req.method === "GET" && url.pathname === "/api/context") { send(res, 200, workbench.context()); return; }
                if (req.method === "GET" && url.pathname === "/api/result") {
                    send(res, 200, await workbench.page(url.searchParams.get("runId"), url.searchParams.get("resultSetId"), Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 500))); return;
                }
                if (req.method === "GET" && url.pathname === "/api/export") {
                    const format = url.searchParams.get("format"), output = await workbench.exportResult(url.searchParams.get("runId"), url.searchParams.get("resultSetId"), format, { stream: true });
                    try {
                        res.writeHead(200, { "Content-Type": output.contentType, "Content-Disposition": `attachment; filename="dax-result.${format}"` });
                        if (output.file) await pipeline(createReadStream(output.file), res);
                        else res.end(output.content);
                    } finally { await output.cleanup?.(); }
                    return;
                }
                if (req.method === "GET" && url.pathname === "/api/events") {
                    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
                    res.write(`event: state\ndata: ${JSON.stringify(workbench.snapshot())}\n\n`);
                    clients.add(res);
                    const authoringClient = workbench.authoring.connect(event => {
                        if (res.destroyed || res.writableEnded) return;
                        if (event.phase === "release") res.write(`event: state\ndata: ${JSON.stringify(workbench.snapshot())}\n\n`);
                        res.write(`event: authoring\ndata: ${JSON.stringify(event)}\n\n`);
                    });
                    req.on("close", () => { clients.delete(res); authoringClient.close(); workbench.clearSharedAnalysis(); }); return;
                }
                if (req.method === "POST" && url.pathname === "/api/action") {
                    if (req.headers.origin !== origin) throw fail("INVALID_ORIGIN", "Canvas mutations require the matching origin.");
                    if (!String(req.headers["content-type"]).startsWith("application/json")) throw fail("INVALID_CONTENT_TYPE", "Actions require application/json.");
                    const chunks = []; let count = 0;
                    for await (const chunk of req) {
                        count += chunk.length;
                        if (count > 256 * 1024) throw fail("REQUEST_TOO_LARGE", "This action exceeds 256 KiB.");
                        chunks.push(chunk);
                    }
                    let body;
                    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("INVALID_JSON", "The action body is not valid JSON."); }
                    if (body.action === "results.openExcel") {
                        send(res, 200, { result: await openResultInExcel(workbench, body.payload, openExcel) }); return;
                    }
                    if (body.action === "authoring.ack") {
                        send(res, 200, { result: workbench.authoring.acknowledge(body.payload ?? {}) }); return;
                    }
                    if (body.action === "copilot.ask") {
                        if (!onAskCopilot) throw fail("COPILOT_UNAVAILABLE", "This preview is not connected to a Copilot session.");
                        if (typeof body.payload?.prompt !== "string" || body.payload.prompt.length > 4000 || !body.payload.prompt.trim()) throw fail("INVALID_PROMPT", "Enter a prompt of 1 to 4,000 characters.");
                        await onAskCopilot(body.payload.prompt, workbench.context());
                        send(res, 200, { result: { sent: true } }); return;
                    }
                    if (body.action === "copilot.reviewDocumentation") {
                        if (!onReviewDocumentation) throw fail("COPILOT_UNAVAILABLE", "This preview is not connected to a Copilot session.");
                        const review = await workbench.action("library.documentation.preview", body.payload, "ui");
                        await onReviewDocumentation(review);
                        send(res, 200, { result: { sent: true, count: review.entries.length } }); return;
                    }
                    if (body.action === "copilot.reviewContent") {
                        if (!onReviewContent) throw fail("COPILOT_UNAVAILABLE", "This preview is not connected to a Copilot session.");
                        const review = await workbench.action("content.share", body.payload, "ui");
                        await onReviewContent(review);
                        send(res, 200, { result: { sent: true } }); return;
                    }
                    if (body.action === "copilot.officeHandoff") {
                        if (!onOfficeHandoff) throw fail("COPILOT_UNAVAILABLE", "This preview is not connected to a Copilot session.");
                        const capture = await workbench.action("dashboards.officeShare", body.payload, "ui");
                        await onOfficeHandoff(capture);
                        send(res, 200, { result: { sent: true } }); return;
                    }
                    send(res, 200, { result: await workbench.action(body.action, body.payload, "ui") }); return;
                }
                send(res, 404, { error: { code: "NOT_FOUND", message: "API route not found." } }); return;
            }
            if (!["GET", "HEAD"].includes(req.method)) { send(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }); return; }
            const root = await realpath(assetsRoot), candidate = path.resolve(root, ...decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).split("/").filter(Boolean));
            const relative = path.relative(root, candidate);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw fail("NOT_FOUND", "File not found.");
            let actual;
            try { actual = await realpath(candidate); } catch { throw fail("NOT_FOUND", "Asset not found. Build the frontend before opening the canvas."); }
            const rel = path.relative(root, actual);
            if (rel.startsWith("..") || path.isAbsolute(rel) || !(await stat(actual)).isFile()) throw fail("NOT_FOUND", "File not found.");
            res.writeHead(200, { "Content-Type": TYPES[path.extname(actual)] ?? "application/octet-stream" });
            if (req.method === "HEAD") res.end();
            else createReadStream(actual).on("error", () => res.destroy()).pipe(res);
        } catch (error) {
            if (res.headersSent) { res.destroy(); return; }
            const mapped = safeError(error);
            send(res, mapped.code === "NOT_FOUND" ? 404 : mapped.code === "INVALID_ORIGIN" || mapped.code === "INVALID_HOST" ? 403 : mapped.code.includes("CONFLICT") ? 409 : 400, { error: mapped });
        }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    let pendingSnapshot = false;
    const publish = () => { pendingSnapshot = true; };
    workbench.on("change", publish);
    const flush = setInterval(() => {
        if (!pendingSnapshot) return;
        pendingSnapshot = false;
        if (!clients.size) return;
        const frame = `event: state\ndata: ${JSON.stringify(workbench.snapshot())}\n\n`;
        for (const client of clients) {
            if (client.writableLength > 2 * 1024 * 1024) { client.end(); clients.delete(client); }
            else client.write(frame);
        }
    }, 100);
    const onError = error => {
        const frame = `event: error\ndata: ${JSON.stringify(error)}\n\n`;
        for (const client of clients) client.write(frame);
    };
    workbench.on("operationError", onError);
    const heartbeat = setInterval(() => { for (const client of clients) client.write(": heartbeat\n\n"); }, 20_000);
    flush.unref(); heartbeat.unref();
    return {
        url: `${origin}/#token=${token}`, token, origin,
        async close() {
            clearInterval(flush); clearInterval(heartbeat);
            workbench.off("change", publish); workbench.off("operationError", onError);
            for (const client of clients) client.end(); clients.clear();
            await new Promise(resolve => server.close(resolve));
        },
    };
}
