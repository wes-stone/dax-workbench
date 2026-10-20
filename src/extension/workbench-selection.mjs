import { fail, requireId } from "../application/policy.mjs";

export const WORKBENCH_SELECTION_KEY = "preferences:workbench-resume";

function selection(saved) {
    if (saved.value === null && saved.revision === 0) return null;
    const value = saved.value;
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1
        || !value || value.version !== 1 || Object.keys(value).length !== 2
        || typeof value.workbenchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.workbenchId))
        throw fail("WORKBENCH_SELECTION_CORRUPT", "The saved workbench selection is invalid. Existing workbenches were not changed; no empty replacement was opened.");
    return value.workbenchId;
}

export class WorkbenchSelection {
    constructor(native) { this.native = native; }
    async resolve(explicitId) {
        if (explicitId !== undefined) return requireId(explicitId);
        await this.native.start();
        const saved = await this.native.request("store.read", { key: WORKBENCH_SELECTION_KEY });
        return selection(saved) ?? "default";
    }
    async remember(id) {
        requireId(id);
        for (let attempt = 0; attempt < 3; attempt++) {
            const saved = await this.native.request("store.read", { key: WORKBENCH_SELECTION_KEY });
            if (selection(saved) === id) return;
            try {
                await this.native.request("store.write", {
                    key: WORKBENCH_SELECTION_KEY, expectedRevision: saved.revision,
                    value: { version: 1, workbenchId: id },
                });
                return;
            } catch (error) {
                if (!["REVISION_CONFLICT", "STORE_CONFLICT"].includes(error.code)) throw error;
            }
        }
        throw fail("WORKBENCH_SELECTION_CONFLICT", "Another canvas changed the saved workbench selection. Reopen this canvas; existing workbenches were not changed.");
    }
}
