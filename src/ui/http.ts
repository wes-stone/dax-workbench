import type { Snapshot } from "../contracts/workbench";

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiError";
  }
}

export function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === "object" && value !== null
    && "workbenchId" in value && typeof value.workbenchId === "string"
    && "version" in value && typeof value.version === "number" && Number.isSafeInteger(value.version)
    && "activeDocumentId" in value && typeof value.activeDocumentId === "string"
    && "documents" in value && Array.isArray(value.documents)
    && "connections" in value && Array.isArray(value.connections)
    && "runs" in value && Array.isArray(value.runs)
    && "schema" in value && "limits" in value && "native" in value
    && "agentReadEnabled" in value && typeof value.agentReadEnabled === "boolean";
}

export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs: number | null = 15000): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = timeoutMs === null ? undefined : setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      throw new ApiError(failure?.error?.code ?? `HTTP_${response.status}`,
        failure?.error?.message ?? `Request failed (${response.status}). Reopen the workbench if the connection has expired.`);
    }
    return await response.json() as T;
  } catch (reason) {
    if (timedOut && !init.signal?.aborted) {
      throw new ApiError("REQUEST_TIMEOUT", init.method === "POST"
        ? "The controller did not respond in time. The action may have completed; check the current tab before retrying. Your local draft is preserved."
        : "The controller did not return the workspace state in time. Your local draft is preserved; reconnect the workbench before retrying.");
    }
    throw reason;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}
