import { randomUUID } from "node:crypto";
import { fail } from "./policy.mjs";

// Every connected editor must save successfully before an agent can change tabs or drafts.
export class AuthoringCoordinator {
    constructor(timeoutMs = 15_000) {
        this.timeoutMs = timeoutMs; this.clients = new Map(); this.current = null;
    }
    connect(send) {
        const clientId = randomUUID();
        if (this.current?.phase === "prepare") this.current.reject(fail("AUTHORING_CONFLICT", "A canvas connected during draft preparation. Read fresh context and retry."));
        this.clients.set(clientId, send);
        if (this.current) send({ phase: "hold", requestId: this.current.id, clientId });
        return {
            clientId,
            close: () => {
                this.clients.delete(clientId);
                if (this.current?.phase === "prepare") this.current.reject(fail("AUTHORING_CONFLICT", "A canvas disconnected before its draft was saved. Reconnect it before retrying."));
            },
        };
    }
    acknowledge({ requestId, clientId, ready }) {
        const current = this.current;
        if (!current || current.id !== requestId || current.phase !== "prepare" || !current.waiting.has(clientId))
            throw fail("AUTHORING_CONFLICT", "This draft preparation is no longer pending.");
        if (ready !== true) {
            current.reject(fail("DRAFT_NOT_READY", "A canvas has an unfinished, invalid or conflicting edit. Finish or save that edit before asking Copilot to change tabs or populate the builder."));
        } else {
            current.waiting.delete(clientId);
            if (!current.waiting.size) current.resolve();
        }
        return { acknowledged: true };
    }
    async perform(operation) {
        if (this.current) throw fail("AUTHORING_BUSY", "Another canvas authoring action is in progress. Wait for it to finish.");
        let resolve, reject;
        const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
        const current = { id: randomUUID(), phase: "prepare", waiting: new Set(this.clients.keys()), resolve, reject };
        this.current = current;
        const timer = setTimeout(() => reject(fail("DRAFT_NOT_READY", "A canvas did not confirm its draft was saved. Reopen an outdated or disconnected panel and retry.")), this.timeoutMs);
        try {
            for (const [clientId, send] of this.clients) send({ phase: "prepare", requestId: current.id, clientId });
            if (!current.waiting.size) resolve();
            await ready;
            clearTimeout(timer);
            current.phase = "apply";
            return await operation();
        } finally {
            clearTimeout(timer); this.current = null;
            for (const [clientId, send] of this.clients) send({ phase: "release", requestId: current.id, clientId });
        }
    }
}
