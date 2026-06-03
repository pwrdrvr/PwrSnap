// Injection seams that bind PwrSnap into the @pwrdrvr/agent-kit packages.
//
// The agent-kit transport / discovery / client packages are host-agnostic:
// they never import Electron and never touch PwrSnap's logger. They accept
// the host's `Logger`, an `OpenExternal`, and identity/config strings as
// dependencies. This module produces those bindings from PwrSnap's own
// substrate so the rest of main can hand them to the packages.
//
// KTD-S1 (consume-agent-kit plan): inject, don't fork.

import { shell } from "electron";
import type { Logger, OpenExternal } from "@pwrdrvr/agent-core";
import { getMainLogger } from "../log";

/**
 * Adapt a PwrSnap `getMainLogger(scope)` instance to the agent-kit `Logger`
 * interface. electron-log's scoped logger accepts varargs, so forwarding
 * `(message, fields?)` is a structural fit — but the kit's `Logger` is a
 * narrow 4-method contract, so we wrap it explicitly rather than rely on the
 * scoped logger's broader (and differently-typed) surface satisfying it.
 */
export function toAgentKitLogger(scope: string): Logger {
  const log = getMainLogger(scope);
  const forward =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, fields?: Record<string, unknown>): void => {
      if (fields === undefined) {
        log[level](message);
      } else {
        log[level](message, fields);
      }
    };
  return {
    debug: forward("debug"),
    info: forward("info"),
    warn: forward("warn"),
    error: forward("error")
  };
}

/**
 * The host `OpenExternal` for the agent-kit login flow. Codex login scrapes
 * an OAuth URL and hands it here; PwrSnap opens it in the user's browser via
 * Electron `shell.openExternal`, keeping Electron out of the kit packages.
 */
export const openExternal: OpenExternal = async (url: string): Promise<void> => {
  await shell.openExternal(url);
};

/** Identity sent as `clientInfo.name` at Codex `initialize`. PwrSnap hardcoded
 *  this string before; it now travels into the kit clients as config so the
 *  value Codex sees is preserved. */
export const PWRSNAP_CLIENT_NAME = "pwrsnap";
export const PWRSNAP_CLIENT_TITLE = "PwrSnap";

/** `serviceName` applied at `thread/start`. Matches the string PwrSnap's
 *  in-tree clients passed before the migration. */
export const PWRSNAP_SERVICE_NAME = "pwrsnap";
