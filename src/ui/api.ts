import type { AuthoringEvent, Bootstrap, ResultPage, SafeContext, Snapshot } from "../contracts/workbench";
import { ApiError, requestJson } from "./http";
export { ApiError } from "./http";

let token = "";

export interface ExcelOpenReceipt {
  status: "opening";
  filePath: string;
  format: "xlsx" | "csv";
  rowCount: number;
  partial: boolean;
  preservedNumbers?: number;
}

function request<T>(path: string, init: RequestInit = {}, timeoutMs: number | null = 15000): Promise<T> {
  return requestJson<T>(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "X-Dax-Token": token,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  }, timeoutMs);
}

export const api = {
  async read<T>(action: "connection.details" | "library.catalog" | "library.get" | "library.documentation.preview" | "knowledge.search" | "knowledge.get" | "artifacts.catalog" | "artifacts.get" | "dashboards.catalog" | "dashboards.get" | "dashboards.snapshot" | "dashboards.proposals" | "content.preview" | "content.pending" | "content.history" | "projects.get" | "projects.file" | "builder.values.read" | "builder.filters.validate", payload: object = {}, signal?: AbortSignal): Promise<T> {
    try {
      const body = await request<{ result: T }>("/api/action", {
        method: "POST", body: JSON.stringify({ action, payload }), signal,
      }, 15000);
      return body.result;
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "REQUEST_TIMEOUT")
        throw new ApiError(reason.code, `${action === "builder.filters.validate" ? "Filter validation" : action === "builder.values.read" ? "The captured values" : action === "connection.details" ? "Connection settings" : "The library"} did not respond in time. Retry the read; your drafts have not changed.`);
      throw reason;
    }
  },
  async bootstrap(): Promise<Snapshot> {
    const fragment = location.hash.slice(1);
    token = fragment.startsWith("token=") ? new URLSearchParams(fragment).get("token") ?? "" : fragment;
    history.replaceState(null, "", location.pathname + location.search);
    const bootstrap = await request<Bootstrap>("/api/bootstrap");
    token = bootstrap.token;
    return bootstrap.state;
  },
  state: () => request<Snapshot>("/api/state"),
  async action<T = unknown>(action: string, payload: object = {}): Promise<T> {
    // A mutation must return a definite outcome; a client deadline cannot cancel its commit.
    const body = await request<{ result: T }>("/api/action", {
      method: "POST", body: JSON.stringify({ action, payload }),
    }, ["builder.preview", "authoring.ack"].includes(action) ? 15000 : null);
    return body.result;
  },
  context: () => request<SafeContext>("/api/context"),
  page: (runId: string, resultSetId: string, offset: number, signal?: AbortSignal) =>
    request<ResultPage>(`/api/result?${new URLSearchParams({ runId, resultSetId, offset: String(offset), limit: "1000" })}`, { signal }),
  async uploadArtifact(file: File, collectionId: string, expectedRevision: number) {
    const query = new URLSearchParams({ name: file.name, collectionId, expectedRevision: String(expectedRevision) });
    const body = await request<{ result: { id: string; revision: number } }>(`/api/artifacts/upload?${query}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
    }, null);
    return body.result;
  },
  async artifactBlob(id: string, inline = false, signal?: AbortSignal) {
    const response = await fetch(`/api/artifacts/content?${new URLSearchParams({ id, ...(inline ? { inline: "1" } : {}) })}`, {
      headers: { "X-Dax-Token": token }, cache: "no-store", signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new ApiError(error?.error?.code ?? "ARTIFACT_READ_FAILED", error?.error?.message ?? "Could not read this artifact. Refresh and retry.");
    }
    return response.blob();
  },
  async export(runId: string, resultSetId: string, format: "xlsx" | "csv" | "json") {
    const response = await fetch(`/api/export?${new URLSearchParams({ runId, resultSetId, format })}`, {
      headers: { "X-Dax-Token": token }, cache: "no-store",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new ApiError(error?.error?.code ?? "EXPORT_FAILED", error?.error?.message ?? "Could not export this retained result.");
    }
    downloadBlob(await response.blob(), `dax-${runId}-${resultSetId}.${format}`);
  },
  async events(signal: AbortSignal, onState: (state: Snapshot) => void, onStatus: (connected: boolean) => void, onError?: (message: string) => void, onAuthoring?: (event: AuthoringEvent) => void) {
    while (!signal.aborted) {
      try {
        const response = await fetch("/api/events", {
          headers: { "X-Dax-Token": token, Accept: "text/event-stream" }, signal, cache: "no-store",
        });
        if (!response.ok || !response.body) throw new Error("Event stream unavailable");
        onStatus(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
          if (buffer.length > 2 * 1024 * 1024) throw new Error("Event notification exceeds the safe metadata limit.");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = message.split("\n");
            const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
            const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if ((event === "state" || !event) && data) {
              try {
                const parsed = JSON.parse(data);
                const state = parsed.state ?? parsed;
                if (Array.isArray(state.documents)) onState(state as Snapshot);
              } catch { /* A malformed notification cannot replace the current snapshot. */ }
            }
            if (event === "error" && data) {
              try {
                const parsed = JSON.parse(data);
                onError?.(parsed.error?.message ?? parsed.message ?? "The controller reported an event error.");
              } catch { onError?.("The controller reported an event error."); }
            }
            if (event === "authoring" && data) {
              const parsed: AuthoringEvent = JSON.parse(data);
              if (!["prepare", "hold", "release"].includes(parsed.phase) || typeof parsed.requestId !== "string" || typeof parsed.clientId !== "string")
                throw new Error("Invalid canvas authoring notification.");
              onAuthoring?.(parsed);
            }
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      onStatus(false);
      onAuthoring?.({ phase: "disconnected", requestId: "", clientId: "" });
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 2000);
        signal.addEventListener("abort", finish, { once: true });
      });
      if (!signal.aborted) {
        try { onState(await api.state()); } catch { /* The reconnect banner remains visible. */ }
      }
    }
  },
};

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "An unexpected error occurred. Try the action again.";
}
