// Type-safe tool-definition primitive for PwrSnap's chat tool catalogs.
//
// The generic machinery — `defineTool`, the `ToolSpec` shape,
// `toDynamicToolSpec` (zod → DynamicToolSpec), and `ToolDispatchResult` — now
// comes from @pwrdrvr/agent-client. PwrSnap keeps only its domain-specific
// `ToolNamespace` discipline on top: the allowlist call sites must use a
// PwrSnap namespace literal, not an arbitrary string, so a typo is a compile
// error. The kit's `defineTool` accepts any `string` namespace; this module's
// `defineTool` narrows that to `ToolNamespace` and delegates to the kit at
// runtime (the kit body is an identity helper, so there's no behavior change).
//
// Every tool still ultimately resolves to ONE command-bus dispatch — "bus is
// the floor" (agent-native parity). A `ToolSpec` pairs an agent-readable
// description + a zod argument schema (the audit surface) with the single
// `dispatch` body that runs the underlying `bus.dispatch(...)`.

import type { z } from "zod";
import {
  defineTool as kitDefineTool,
  toDynamicToolSpec as kitToDynamicToolSpec,
  type ToolDispatchResult as KitToolDispatchResult,
  type AnyToolSpec
} from "@pwrdrvr/agent-client";
import type { DynamicToolSpec } from "@pwrsnap/codex-app-server-protocol/v2";

/**
 * Namespace every PwrSnap chat tool lives under. A string-literal union so the
 * dispatcher can match `DynamicToolCallParams.namespace` exactly and the
 * allowlist call sites can't drift onto an unrecognized namespace.
 */
export type ToolNamespace = "pwrsnap_library" | "pwrsnap_sizzle";

/**
 * Result of a tool `dispatch`. Re-exported from the kit (identical shape):
 * mirrors the command bus's `Result` but flattened to a plain string error —
 * the agent only ever sees text, so the structured `PwrSnapError` is collapsed
 * to a message at the tool boundary. The `contentItems` arm carries rich
 * content the agent must SEE rather than read as JSON (chiefly
 * `render_composite`'s `inputImage`).
 */
export type ToolDispatchResult = KitToolDispatchResult;

/**
 * One PwrSnap chat tool. Structurally the kit's `ToolSpec<TArgs>` but with the
 * namespace narrowed to {@link ToolNamespace}. The single audit unit:
 * description (what the agent reads), `argsSchema` (what the agent must
 * satisfy — validated before dispatch), and `dispatch` (the one
 * `bus.dispatch(...)` it resolves to).
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
   * Behaviour hints surfaced to the agent / approval UI. Optional per tool;
   * omit (rather than set `undefined`) when not applicable —
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
 * without any cast — and constrains `namespace` to {@link ToolNamespace}.
 * Delegates to the kit's `defineTool` (also an identity helper) at runtime.
 */
export function defineTool<TArgs>(spec: ToolSpec<TArgs>): ToolSpec<TArgs> {
  // The kit's `defineTool` widens `namespace` to `string`; cast back to the
  // PwrSnap-narrowed `ToolSpec<TArgs>` since the runtime body is identity.
  return kitDefineTool(spec) as ToolSpec<TArgs>;
}

/**
 * Convert a `ToolSpec` into the protocol `DynamicToolSpec` registered with
 * Codex on `thread/start`. Delegates to the kit (zod v4 `z.toJSONSchema()`,
 * JSON Schema draft 2020-12).
 */
export function toDynamicToolSpec(spec: ToolSpec<unknown>): DynamicToolSpec {
  return kitToDynamicToolSpec(spec as AnyToolSpec) as DynamicToolSpec;
}
