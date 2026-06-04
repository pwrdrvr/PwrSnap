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

import { z } from "zod";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { ToolSpec } from "./define-tool";
import { toDynamicToolSpec } from "./define-tool";
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
  return allowlist.map(toDynamicToolSpec);
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
  const entry = allowlist.find((tool) => tool.name === params.tool);
  if (entry === undefined) {
    return errorResponse(`Unknown tool: ${params.tool}`);
  }

  // `namespace` is `string | null` on the wire. We accept a missing/null
  // namespace (Codex may omit it) but reject an explicit mismatch.
  if (params.namespace !== null && params.namespace !== entry.namespace) {
    return errorResponse(
      `Tool "${params.tool}" is not in namespace "${params.namespace}".`
    );
  }

  const parsed = entry.argsSchema.safeParse(params.arguments);
  if (!parsed.success) {
    return errorResponse(
      `Invalid arguments for "${params.tool}": ${formatZodError(parsed.error)}`
    );
  }

  let result: Awaited<ReturnType<ToolSpec<unknown>["dispatch"]>>;
  try {
    result = await entry.dispatch(parsed.data, { threadId: params.threadId });
  } catch (cause) {
    return errorResponse(
      `Tool "${params.tool}" failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  if (!result.ok) {
    return errorResponse(result.error);
  }

  // A tool that returns pre-built content items (e.g. render_composite's
  // inputImage) passes them through verbatim so the model SEES the image
  // rather than a JSON blob.
  if ("contentItems" in result) {
    return { success: true, contentItems: result.contentItems };
  }

  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(result.data) }]
  };
}

function errorResponse(message: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }]
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
