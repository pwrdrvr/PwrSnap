// Wire protocol for the agent ↔ library process bridge — the third
// command-bus transport alongside ipcMain and the (Phase 7) HTTP RPC
// server. Messages travel over the parent↔child Node IPC channel, which
// JSON-serializes payloads; everything here must survive that round trip.
//
// The `pwrsnapBridge: 1` marker discriminates bridge traffic from any
// other `process.send` user sharing the pipe; the value doubles as the
// protocol version. Both processes run from the same binary, so version
// skew is impossible today — the field exists so a future mixed-version
// window (e.g. update-restart ordering) fails loudly instead of weirdly.

import { err, type PwrSnapError, type Result } from "@pwrsnap/shared";
import type { ProcessRole } from "../process-role";

export const BRIDGE_PROTOCOL_VERSION = 1;

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
      return typeof message["id"] === "number" && typeof message["name"] === "string";
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
