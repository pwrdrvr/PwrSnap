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
import type { CommandDispatchOptions } from "../command-bus";
import { runWithChatToolCommandContext } from "./chat-tool-command-context";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:chat-tools");

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
  allowlist: ReadonlyArray<ToolSpec<unknown>> = LIBRARY_TOOL_ALLOWLIST,
  commandContext: CommandDispatchOptions = { principal: "ipc" }
): Promise<DynamicToolCallResponse> {
  const startedAt = Date.now();
  const response = await runWithChatToolCommandContext(commandContext, () =>
    dispatchToolCall(params, allowlist)
  );
  const context = {
    namespace: params.namespace,
    tool: params.tool,
    callId: params.callId,
    threadId: params.threadId,
    turnId: params.turnId,
    principal: commandContext.principal,
    durationMs: Date.now() - startedAt
  };
  if (response.success) {
    // Success traffic is useful during an active troubleshooting session but
    // intentionally stays out of the default info-level durable log.
    log.debug("chat tool call completed", context);
  } else {
    // The shared dispatcher converts unknown tools, invalid arguments, thrown
    // handlers, and command failures into success:false. Without this explicit
    // edge log the model sees the error but the user has no post-mortem trail.
    log.warn("chat tool call failed", {
      ...context,
      error: response.contentItems
        .filter((item) => item.type === "inputText")
        .map((item) => item.text)
        .join(" | ") || "tool returned no text error"
    });
  }
  return response;
}
