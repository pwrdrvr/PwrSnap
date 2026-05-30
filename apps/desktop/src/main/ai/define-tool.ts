// Type-safe tool-definition primitive for the Library Chat tool catalog.
//
// PwrSnap's Library Chat exposes its tool catalog to Codex as
// `DynamicToolSpec[]` (registered on `thread/start`). Every tool ultimately
// resolves to ONE command-bus dispatch — "bus is the floor" (agent-native
// parity). A `ToolSpec` pairs an agent-readable description + a zod argument
// schema (the audit surface) with the single `dispatch` body that runs the
// underlying `bus.dispatch(...)`.
//
// `defineTool` is an identity helper: it exists purely so each call site
// keeps its own `TArgs` inference (the `argsSchema`'s inferred type flows
// into the `dispatch` body) without anyone writing `any`. The allowlist is
// then a homogeneous `ToolSpec<unknown>[]`; the generator + dispatcher in
// `library-tool-catalog.ts` treat the array uniformly.

import { z } from "zod";
import type {
  DynamicToolCallOutputContentItem,
  DynamicToolSpec
} from "@pwrsnap/codex-app-server-protocol/v2";

/**
 * Namespace every Library Chat tool lives under. A string-literal union so
 * the dispatcher can match `DynamicToolCallParams.namespace` exactly. Only
 * one member exists today; add members here if a future surface needs its
 * own namespace.
 */
export type ToolNamespace = "pwrsnap_library" | "pwrsnap_sizzle";

/**
 * Result of a tool `dispatch`. Mirrors the command bus's `Result` shape but
 * flattened to a plain string error — the agent only ever sees text, so we
 * collapse the structured `PwrSnapError` to a message at the tool boundary.
 */
export type ToolDispatchResult =
  | { ok: true; data: unknown }
  // For tools that return rich content the agent must SEE rather than
  // read as JSON — chiefly `render_composite`, which returns an
  // `inputImage` content item (a data URL) so the model can ground its
  // reasoning on the actual canvas pixels. The dispatcher passes these
  // through verbatim instead of JSON-stringifying.
  | { ok: true; contentItems: DynamicToolCallOutputContentItem[] }
  | { ok: false; error: string };

/**
 * One Library Chat tool. The single audit unit: description (what the agent
 * reads), `argsSchema` (what the agent must satisfy — validated before
 * dispatch), and `dispatch` (the one `bus.dispatch(...)` it resolves to).
 */
export type ToolSpec<TArgs> = {
  namespace: ToolNamespace;
  /** snake_case agent-facing name, e.g. "library_list". */
  name: string;
  /** Agent-readable, terse. Shown verbatim to Codex. */
  description: string;
  /** zod schema for the tool arguments; also the source of `inputSchema`. */
  argsSchema: z.ZodType<TArgs>;
  /**
   * Behaviour hints surfaced to the agent / approval UI. Optional per
   * tool; omit (rather than set `undefined`) when not applicable —
   * `exactOptionalPropertyTypes` is on.
   */
  annotations?: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
  };
  /**
   * The single command-bus dispatch this tool resolves to. Receives the
   * zod-validated args (typed as `TArgs`) plus the calling thread id.
   */
  dispatch: (args: TArgs, ctx: { threadId: string }) => Promise<ToolDispatchResult>;
};

/**
 * Identity helper that preserves `TArgs` inference at each call site, so a
 * tool's `dispatch` body is fully type-checked against its own `argsSchema`
 * without any cast. Use it for every allowlist entry:
 *
 * ```ts
 * defineTool({
 *   namespace: "pwrsnap_library",
 *   name: "library_list",
 *   description: "List captures in the library.",
 *   argsSchema: z.object({ limit: z.number().int().positive().max(200).optional() }),
 *   annotations: { readOnlyHint: true, idempotentHint: true },
 *   dispatch: async (args, ctx) => { ... }  // args.limit is `number | undefined`
 * });
 * ```
 */
export function defineTool<TArgs>(spec: ToolSpec<TArgs>): ToolSpec<TArgs> {
  return spec;
}

/**
 * Convert a `ToolSpec` into the protocol `DynamicToolSpec` registered with
 * Codex on `thread/start`. The `inputSchema` is derived from the tool's zod
 * `argsSchema` via zod v4's `z.toJSONSchema()` (JSON Schema draft 2020-12).
 */
export function toDynamicToolSpec(spec: ToolSpec<unknown>): DynamicToolSpec {
  return {
    namespace: spec.namespace,
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.argsSchema) as DynamicToolSpec["inputSchema"]
  };
}
