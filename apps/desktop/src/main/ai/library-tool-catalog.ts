// Generator + dispatcher derived from `LIBRARY_TOOL_ALLOWLIST`.
//
//   • `buildLibraryToolCatalog()` — the `DynamicToolSpec[]` PwrSnap
//     registers with Codex on `thread/start`.
//   • `dispatchLibraryToolCall()` — routes an incoming `DynamicToolCall`
//     back to its allowlist entry: matches namespace + tool, zod-validates
//     the arguments, runs the entry's single bus dispatch, and wraps the
//     outcome as a `DynamicToolCallResponse`.
//
// Failure policy (plan §F2 #5 / §F4 C1): NEVER throw across the tool-call
// boundary. Unknown tool, namespace mismatch, bad arguments, and dispatch
// errors all return `{ success: false }` with a text contentItem describing
// the problem, so the agent can self-correct on its next turn.

import {
  buildToolCatalog,
  dispatchToolCall
} from "@pwrdrvr/agent-client";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { ToolSpec } from "./define-tool";
import { LIBRARY_TOOL_ALLOWLIST } from "./library-tool-allowlist";

/**
 * Build the `DynamicToolSpec[]` registered with Codex on `thread/start`.
 * Pure projection of the allowlist — empty allowlist ⇒ empty catalog.
 *
 * @param allowlist override the source list (tests inject a fixture array).
 */
export function buildLibraryToolCatalog(
  allowlist: ReadonlyArray<ToolSpec<unknown>> = LIBRARY_TOOL_ALLOWLIST
): DynamicToolSpec[] {
  return buildToolCatalog(allowlist);
}

/**
 * Route an incoming `DynamicToolCall` to its allowlist entry and run it.
 * Always resolves — never throws — so a malformed or unknown call comes
 * back as a `success: false` response the agent can recover from.
 *
 * @param params the protocol call params (`namespace`, `tool`, `arguments`).
 * @param allowlist override the source list (tests inject a fixture array).
 */
export async function dispatchLibraryToolCall(
  params: DynamicToolCallParams,
  allowlist: ReadonlyArray<ToolSpec<unknown>> = LIBRARY_TOOL_ALLOWLIST
): Promise<DynamicToolCallResponse> {
  return dispatchToolCall(params, allowlist);
}
