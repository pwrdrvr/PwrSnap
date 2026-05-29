// The Library Chat tool allowlist — the single audit surface for which
// command-bus verbs the AI surface may invoke (agent-native parity:
// "bus is the floor").
//
// ┌─ How this grows ──────────────────────────────────────────────────┐
// │ Phase 1 fills this array. The pattern is strict and intentional:   │
// │                                                                    │
// │   • READ-ONLY tools land first (list / read / current-capture).    │
// │     They carry `annotations: { readOnlyHint: true }`.              │
// │   • MUTATING tools (rename / tag / delete / overlay edits) land    │
// │     after the read path is proven, each with `destructiveHint`     │
// │     where appropriate so the approval UI can gate them.            │
// │                                                                    │
// │ EVERY entry is a `defineTool(...)` whose `dispatch` body makes      │
// │ exactly ONE `bus.dispatch(<verb>, args, { principal: "mcp" })`     │
// │ call and flattens the `Result` to `{ ok, data } | { ok, error }`.  │
// │ One tool ⇒ one bus verb ⇒ one audit point. Do not let a tool fan   │
// │ out to multiple verbs or do work outside the bus — that breaks the │
// │ audit story and the parity guarantee.                              │
// │                                                                    │
// │ This array IS the catalog. `buildLibraryToolCatalog()` maps it to  │
// │ `DynamicToolSpec[]` for `thread/start`; `dispatchLibraryToolCall`  │
// │ routes incoming `DynamicToolCall`s back through these same         │
// │ entries. Adding a tool here is the whole change — registration     │
// │ and dispatch are derived.                                          │
// └────────────────────────────────────────────────────────────────────┘

import type { ToolSpec } from "./define-tool";

// The two commented-out entries below are a TEMPLATE for Phase 1. They are
// commented out so the empty array compiles cleanly today; uncomment + adapt
// (and drop them into `LIBRARY_TOOL_ALLOWLIST`) when wiring real tools.
//
// import { z } from "zod";
// import { bus } from "../command-bus";
// import { defineTool } from "./define-tool";
//
// /** READ-ONLY example: list captures in the library. */
// const libraryListTool = defineTool({
//   namespace: "pwrsnap_library",
//   name: "library_list",
//   description:
//     "List captures in the user's library, newest first. Returns capture " +
//     "rows with id, title, app, and timestamps. Use to find a capture by " +
//     "context before acting on it.",
//   argsSchema: z.object({
//     limit: z.number().int().positive().max(200).optional(),
//     appBundleId: z.string().optional()
//   }),
//   annotations: { readOnlyHint: true, idempotentHint: true },
//   dispatch: async (args) => {
//     const result = await bus.dispatch(
//       "library:list",
//       { limit: args.limit, appBundleId: args.appBundleId },
//       { principal: "mcp" }
//     );
//     return result.ok
//       ? { ok: true, data: result.value }
//       : { ok: false, error: result.error.message };
//   }
// });
//
// /** READ-ONLY example: fetch the capture currently open in the editor. */
// const currentCaptureTool = defineTool({
//   namespace: "pwrsnap_library",
//   name: "current_capture",
//   description:
//     "Get the capture currently open in the Library editor, if any. " +
//     "Returns the full capture record or null when nothing is open.",
//   argsSchema: z.object({}),
//   annotations: { readOnlyHint: true, idempotentHint: true },
//   dispatch: async (_args, _ctx) => {
//     const result = await bus.dispatch(
//       "library:byId",
//       { id: /* resolved current capture id */ "" },
//       { principal: "mcp" }
//     );
//     return result.ok
//       ? { ok: true, data: result.value }
//       : { ok: false, error: result.error.message };
//   }
// });

/**
 * The live tool catalog. EMPTY until Phase 1 — see the module header + the
 * commented template above for the entry shape. Entries are stored as
 * `ToolSpec<unknown>` because the array is heterogeneous; `defineTool`
 * preserves each entry's own `TArgs` inference at its definition site, so
 * dispatch bodies stay fully typed despite the erased element type here.
 */
export const LIBRARY_TOOL_ALLOWLIST: ToolSpec<unknown>[] = [];
