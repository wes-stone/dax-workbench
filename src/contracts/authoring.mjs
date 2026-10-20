import { builderProposalProperties, builderProposalRequired } from "./builder-proposal.mjs";

export const QUERY_AUTHORING_GUIDANCE = [
    "Builder-first for net-new queries: start with a useful editable visual base, not a blank builder beside hand-written DAX. Read fresh context, resolve native schema fields, and use populate_builder to fill output fields, supported filters, sorting and query-local measures together with generated DAX. Reuse the empty tab created by connection selection; otherwise create a named tab without overwriting existing work. A fully representable query stays linked with autoUpdate:true.",
    "Preserve semantics before convenience. Separate builder filters are combined with AND; an In filter is membership within one field, not OR across columns or a tuple-preserving filter. Do not replace dynamic predicates with lists observed in a result sample, drop an OR branch, or change grain, null handling or measure context to make the query fit. Check whether a supported query-local measure can express a calculation exactly before declaring it editor-only.",
    "For a mixed request, populate the useful representable base with autoUpdate:false, label it as a base only, and state exactly which logic is missing and how its scope differs. Then read fresh context and use propose_query for the complete exact DAX, retaining the saved builder selections. The person reviews the proposal; the base is not the completed answer and must not be executed as a substitute. Do not claim the advanced editor and base are synchronized, put hand-written advanced logic inside generated builder markers, or re-enable linking over that logic. If no meaningful base exists, or the person explicitly asks for text-only DAX, explain why and use the editor directly rather than inventing token selections.",
    "For review-only requests, use propose_builder for the representable base and explain any required freeform extension; do not populate, apply or accept on the person's behalf. For edits to existing freeform queries, preserve the editor and existing builder; offer a separate base instead of overwriting or reverse-parsing arbitrary DAX.",
    "After authoring a new query, recommend one or two relevant follow-up queries when useful, including an option beyond the simple builder when it adds analytical value. Explain the question it answers, what requires freeform DAX (for example cross-column OR or a multi-stage virtual table), and any model/data prerequisites. Suggestions are optional and unexecuted; do not create extra tabs, invent missing fields, or imply results. Distinguish what was built, what remains a reviewable extension, and what is merely recommended.",
    "Authoring and recommendations never grant execution or result access. Run only the explicitly requested final query under existing grants after reading its actual editor text; do not run a broader base to gather values for an approximation. Demo Contoso supports only its four shipped recipes, so advanced demo ideas require a compatible real model and must be labelled accordingly.",
].join("\n");
export const builderContextDescription = "Read saved builder selections, literal filters, sort order, model identity, revisions and builder-first authoring guidance. No parameter bindings or result values.";
export const populateBuilderDescription = "For requested net-new authoring, prefer a useful schema-validated visual base: populate fields, filters, sorting, local measures and generated DAX together using fresh get_builder_context revisions. Fully representable queries stay linked by default. For unsupported logic, populate an explicitly labelled base with autoUpdate:false, then propose the exact freeform extension; do not approximate filters or claim equivalence. Saves connected drafts first; never executes, accepts a proposal or changes grants.";
export const proposeQueryDescription = "Stage exact DAX as a reviewable editor change; never apply or run it. For net-new queries, first populate the useful representable builder base with autoUpdate:false when an unsupported extension is needed; retain selections and explain the scope gap. Use text-only directly only when requested or no meaningful base exists. Never replace cross-column OR with non-equivalent In filters. Read fresh context after population; arbitrary DAX does not synchronize the builder.";

const revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const identifier = { type: "string", minLength: 1, maxLength: 128 };
export const surfaceSchema = { type: "string", enum: ["builder", "editor"] };
export const documentAuthoringProperties = {
    operation: { type: "string", enum: ["create", "select", "rename", "close", "reopen"] },
    version: revision, activeDocumentId: identifier, documentId: identifier,
    title: { type: "string", minLength: 1, maxLength: 100 },
    surface: surfaceSchema,
};
export const documentAuthoringRequired = ["operation", "version", "activeDocumentId"];
export const connectionListProperties = {
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    registryRevision: { type: "string", pattern: "^[a-f0-9]{64}$", description: "For continuation pages, retain the registryRevision from the first page." },
};
export const connectionSelectionProperties = {
    version: revision, activeDocumentId: identifier,
    registryRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    connectionId: { type: "string", minLength: 1, maxLength: 256 },
    title: documentAuthoringProperties.title,
    surface: surfaceSchema,
};
export const connectionSelectionRequired = ["version", "activeDocumentId", "registryRevision", "connectionId"];
export const populateBuilderProperties = {
    ...builderProposalProperties,
    autoUpdate: { type: "boolean", description: "Keep the generated editor block synchronized with visual edits. Defaults to true for fully representable queries. Use false for a base awaiting a freeform extension; manual DAX edits pause linking. Never executes." },
    surface: surfaceSchema,
};
export const populateBuilderRequired = builderProposalRequired;
