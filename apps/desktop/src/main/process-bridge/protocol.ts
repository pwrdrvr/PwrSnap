// Wire protocol for the agent ↔ library process bridge — the third
// command-bus transport alongside ipcMain and the (Phase 7) HTTP RPC
// server. Messages travel over the parent↔child Node IPC channel, which
// JSON-serializes payloads; everything here must survive that round trip.
//
// The `pwrsnapBridge` marker discriminates bridge traffic from any
// other `process.send` user sharing the pipe; the value doubles as the
// protocol version. Both processes run from the same binary, so version
// skew is impossible today — the field exists so a future mixed-version
// window (e.g. update-restart ordering) fails loudly instead of weirdly.

import {
  err,
  isLocalAgentCapability,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import type { CommandDispatchOptions, CommandPrincipal } from "../command-bus";
import type { ProcessRole } from "../process-role";

export const BRIDGE_PROTOCOL_VERSION = 2;

export type BridgeHelloMessage = {
  pwrsnapBridge: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "hello";
  role: ProcessRole;
  pid: number;
};

export type BridgeRequestMessage = {
  pwrsnapBridge: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "request";
  /** Correlation id, unique per sending endpoint (not globally). */
  id: number;
  /** Command-bus name, e.g. "library:openInLibrary". */
  name: string;
  req: unknown;
  /** Auth identity and other serializable command-bus metadata. */
  context: CommandDispatchOptions;
};

export type BridgeResponseMessage = {
  pwrsnapBridge: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "response";
  id: number;
  result: Result<unknown, PwrSnapError>;
};

export type BridgeEventMessage = {
  pwrsnapBridge: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "event";
  /** Renderer event channel, e.g. EVENT_CHANNELS.capturesChanged. */
  channel: string;
  payload: unknown;
};

export type BridgeCancelMessage = {
  pwrsnapBridge: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "cancel";
  /** Command-bus cancellation key (capture id or "global") — the
   *  receiving side calls `bus.cancel(key)` so a delete in one process
   *  aborts in-flight work (e.g. enrichment) in the other. */
  key: string;
};

export type BridgeMessage =
  | BridgeHelloMessage
  | BridgeRequestMessage
  | BridgeResponseMessage
  | BridgeEventMessage
  | BridgeCancelMessage;

function isProcessRole(value: unknown): value is ProcessRole {
  return value === "combined" || value === "agent" || value === "library";
}

function isCommandPrincipal(value: unknown): value is CommandPrincipal {
  return (
    value === "ipc" ||
    value === "rpc" ||
    value === "mcp" ||
    value === "seeder" ||
    value === "bridge"
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value));
}

function isSourceBounds(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const bounds = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key])
  );
}

function isLocalAgentContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const localAgent = value as Record<string, unknown>;
  return (
    typeof localAgent["clientId"] === "string" &&
    localAgent["clientId"].length > 0 &&
    Array.isArray(localAgent["capabilities"]) &&
    localAgent["capabilities"].every(isLocalAgentCapability)
  );
}

function isCommandDispatchOptions(value: unknown): value is CommandDispatchOptions {
  if (typeof value !== "object" || value === null) return false;
  const context = value as Record<string, unknown>;
  return (
    isCommandPrincipal(context["principal"]) &&
    isOptionalString(context["cancellationKey"]) &&
    isOptionalInteger(context["sourceWindowId"]) &&
    isSourceBounds(context["sourceBounds"]) &&
    isLocalAgentContext(context["localAgent"])
  );
}

/**
 * Narrow an incoming pipe message to a well-formed bridge message.
 * Anything else — other pipe traffic, garbage, future-version frames —
 * is the caller's cue to ignore it.
 */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message["pwrsnapBridge"] !== BRIDGE_PROTOCOL_VERSION) return false;
  switch (message["kind"]) {
    case "hello":
      return isProcessRole(message["role"]) && typeof message["pid"] === "number";
    case "request":
      return (
        typeof message["id"] === "number" &&
        typeof message["name"] === "string" &&
        isCommandDispatchOptions(message["context"])
      );
    case "response": {
      if (typeof message["id"] !== "number") return false;
      const result = message["result"];
      return (
        typeof result === "object" &&
        result !== null &&
        typeof (result as { ok?: unknown }).ok === "boolean"
      );
    }
    case "event":
      return typeof message["channel"] === "string";
    case "cancel":
      return typeof message["key"] === "string";
    default:
      return false;
  }
}

/**
 * Make a handler Result safe to put on the pipe. `cause` routinely holds
 * an Error (JSON-serializes to `{}`) or worse, something circular (send
 * throws) — and the peer process can't act on a foreign stack anyway.
 * Rebuild the error envelope from its serializable fields only.
 */
export function sanitizeResultForBridge(
  result: Result<unknown, PwrSnapError>
): Result<unknown, PwrSnapError> {
  if (result.ok) return result;
  const { kind, code, message } = result.error;
  return err({ kind, code, message });
}
