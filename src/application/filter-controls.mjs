import { generateBuilderQuery, validateBuilderDraft, validateBuilderSchema } from "../integrations/query-builder.mjs";

export function validateFilterControls(input, objects, parametersSupported) {
    const definition = validateBuilderDraft(input);
    const issues = [];
    for (const filter of definition.filters) {
        if (!filter.enabled) continue;
        try {
            if (!parametersSupported && (filter.isParameter || filter.isParameter2))
                throw new Error("This connection supports literal filters only. Turn off parameter mode or use an ADOMD connection.");
            // Compile an isolated predicate through the canonical engine, even before outputs exist.
            const probe = validateBuilderSchema({ version: 2, fields: [filter.field], filters: [filter], orderBy: [] }, objects);
            generateBuilderQuery(probe);
        } catch (error) {
            issues.push({ filterId: filter.id, message: error.message });
        }
    }
    return { valid: issues.length === 0, issues };
}
