// PwrSnap's approval policy for the SHARED (pooled) ACP agent process.
//
// The agent-acp client makes no trust decision of its own — it forwards every
// `session/request_permission` to the host handler we register here, enriched
// with `mcpServerNames` (the MCP servers PwrSnap configured for the session)
// and the resolved `threadId`. We own the policy:
//
//   • A tool call that targets one of OUR configured MCP servers (PwrSnap wired
//     it up — it's the `pwrsnap` bridge serving the library/sizzle tools) is
//     pre-approved. The user already trusts PwrSnap to edit their captures; the
//     agent shouldn't prompt to use PwrSnap's own tools.
//   • Anything else — the agent's OWN built-in tools (shell / file / web) — is
//     denied. PwrSnap chat is an image assistant; it has no business running a
//     shell. (A future surface could route these to a user prompt instead.)
//
// Why the policy lives here and not in the kit: PwrSnap knows EXACTLY which
// servers it configured, so it can recognize its own tools precisely instead of
// the shared library guessing by string shape. The matching is unavoidably
// string-based (each ACP CLI names MCP tool calls differently), but anchoring
// it on the host's own server names — and keeping it in the host — means the
// kit stays pure transport and every host owns its own trust decisions.

import type { NormalizedApprovalDecision } from "@pwrdrvr/agent-core";
import type { Logger } from "@pwrdrvr/agent-core";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Pull every text string out of an ACP `content` array. The block can be
 *  shaped `{ type: "text", text }` or, as Qwen sends, nested:
 *  `{ type: "content", content: { type: "text", text } }`. The tool name often
 *  lives here ("Requesting approval to Call mcp__pwrsnap__list_layers") even
 *  when the agent's `title` is just the args. */
function contentStrings(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    const direct = readString(rec, "text");
    if (direct) out.push(direct.toLowerCase());
    const nested = asRecord(rec.content);
    const nestedText = nested ? readString(nested, "text") : undefined;
    if (nestedText) out.push(nestedText.toLowerCase());
  }
  return out;
}

/** Identifying strings an agent might put the MCP tool name into on a
 *  `session/request_permission`. Different ACP CLIs use different fields — the
 *  toolCallId, the human title, an explicit tool-name field, and/or the nested
 *  `content` blocks — so we gather all of them. */
function toolCallStrings(toolCall: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of [
    "toolCallId",
    "tool_call_id",
    "title",
    "name",
    "toolName",
    "tool_name",
    "kind"
  ]) {
    const v = readString(toolCall, key);
    if (v) out.push(v.toLowerCase());
  }
  out.push(...contentStrings(toolCall.content));
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<unserializable>";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text;
}

/** Does an identifying string reference the MCP server `name`? Covers the
 *  conventions ACP agents use to name an MCP tool call, so PwrSnap's tools are
 *  recognized regardless of which CLI is driving:
 *   • Gemini / Qwen — `mcp_<server>_<tool>` id, `"<tool> (<server> MCP Server)"` title
 *   • standard MCP (Claude-style, Kimi, …) — `mcp__<server>__<tool>` id
 *   • raw namespaced tool name — `<server>_<tool>` / `<server>.<tool>` / `<server>:<tool>`
 *  Anchored on the server name (PwrSnap's distinctive "pwrsnap"), with a left
 *  word boundary so a short name can't match mid-word and the agent's OWN tools
 *  never match. */
function stringReferencesServer(candidate: string, name: string): boolean {
  if (candidate.includes(`(${name} mcp`) || candidate.includes(`${name} mcp server`)) {
    return true;
  }
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(name)}[._:/-]`, "i");
  return re.test(candidate);
}

/** Argument names that ONLY PwrSnap's tools take. The agent's own built-in
 *  tools (shell/file/web) have no concept of a capture / project, so an args
 *  blob carrying one of these is unmistakably a call to one of OUR tools. This
 *  is the fallback signal for agents (e.g. Qwen Code) that send an opaque
 *  toolCallId and stuff the ARGS into the title — leaving no tool name or
 *  server name anywhere to match on. */
const PWRSNAP_TOOL_ARG_SIGNATURES = ["capture_id", "project_id", "scene_id", "layer_id"];

/** True when a `session/request_permission` targets one of PwrSnap's own tools.
 *  Two independent signals, because ACP agents are wildly inconsistent about
 *  what they put in a permission request:
 *   1. The tool call references a host-configured MCP SERVER name
 *      (`params.mcpServerNames`) — Gemini/Kimi/Grok name the call after it.
 *   2. The tool call's args carry a PwrSnap-distinctive ARGUMENT name — for
 *      agents that hide the tool identity entirely (Qwen). Only our tools use
 *      these argument names, so this never matches the agent's own tools. */
export function permissionTargetsConfiguredMcpServer(params: Record<string, unknown>): boolean {
  const toolCall = asRecord(params.toolCall);
  if (!toolCall) return false;
  const candidates = toolCallStrings(toolCall);

  // Signal 1 — names a configured MCP server.
  const serverNames = readStringArray(params.mcpServerNames);
  if (
    serverNames.some((rawName) => {
      const name = rawName.toLowerCase();
      return candidates.some((candidate) => stringReferencesServer(candidate, name));
    })
  ) {
    return true;
  }

  // Signal 2 — carries a PwrSnap-distinctive argument name. The args can ride in
  // the title (Qwen), an explicit `rawInput`/`arguments`/`input`, so fold them
  // all into one haystack.
  const argsBlob = [
    ...candidates,
    safeJson(toolCall.rawInput).toLowerCase(),
    safeJson(toolCall.arguments).toLowerCase(),
    safeJson(toolCall.input).toLowerCase()
  ].join(" ");
  return PWRSNAP_TOOL_ARG_SIGNATURES.some((sig) => argsBlob.includes(sig));
}

/** The host approval handler registered on the pooled ACP client: pre-approve
 *  PwrSnap's own MCP tools, deny everything else (the agent's built-in tools).
 *
 *  Logging is asymmetric on purpose: an APPROVE is the common, expected case and
 *  the tool's actual execution is already logged at the MCP bridge ("mcp tool
 *  call"), so we stay quiet (one terse debug line). A DENY is the anomaly worth
 *  catching — it's the shape of a future "agent X got rejected" bug — so we log
 *  it at WARN with the full toolCall + param keys for diagnosis. */
export function makePooledAcpApprovalHandler(
  logger: Pick<Logger, "debug" | "warn">
): (method: string, params: unknown) => Promise<NormalizedApprovalDecision> {
  return async (_method, params) => {
    const record = asRecord(params) ?? {};
    const approve = permissionTargetsConfiguredMcpServer(record);
    if (approve) {
      const toolCall = asRecord(record.toolCall);
      logger.debug?.("acp permission approved", {
        toolCallId: toolCall ? readString(toolCall, "toolCallId") : undefined,
        title: toolCall ? readString(toolCall, "title") : undefined
      });
      return "approved";
    }
    logger.warn?.("acp permission denied", {
      mcpServerNames: readStringArray(record.mcpServerNames),
      paramKeys: Object.keys(record),
      toolCall: truncate(safeJson(record.toolCall), 2000)
    });
    return "denied";
  };
}
