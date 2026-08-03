import { shell } from "electron";
import {
  EVENT_CHANNELS,
  err,
  ok,
  type RendererErrorReport,
  type RendererErrorSource
} from "@pwrsnap/shared";
import { readAppLogSnapshot, subscribeAppLogEntries } from "../app-logs";
import { bus } from "../command-bus";
import { broadcastRendererEventToLocalWindows } from "../events";
import {
  getMainLogFilePath,
  getMainLogger,
  isMainLogDebugCollectionEnabled,
  setMainLogDebugCollectionEnabled
} from "../log";
import { showLogsWindow } from "../window";

const rendererErrorLog = getMainLogger("pwrsnap:renderer:error");
let unsubscribeLogEntries: (() => void) | null = null;

function snapshot() {
  return readAppLogSnapshot({
    debugCollectionEnabled: isMainLogDebugCollectionEnabled(),
    logFilePath: getMainLogFilePath()
  });
}

/** Library-owned handlers for the live log viewer and its durable file. */
export function registerLogsHandlers(): void {
  if (unsubscribeLogEntries === null) {
    unsubscribeLogEntries = subscribeAppLogEntries((entry) => {
      broadcastRendererEventToLocalWindows(EVENT_CHANNELS.logEntry, entry);
    });
  }

  bus.register("logs:read", async () => ok(snapshot()));

  bus.register("logs:setDebugCollection", async (req) => {
    if (typeof req.enabled !== "boolean") {
      return err({
        kind: "validation",
        code: "invalid_log_debug_collection",
        message: "logs:setDebugCollection requires a boolean enabled value"
      });
    }
    setMainLogDebugCollectionEnabled(req.enabled);
    return ok(snapshot());
  });

  bus.register("logs:openWindow", async (_req, ctx) => {
    showLogsWindow({
      ...(ctx.sourceWindowId !== undefined ? { sourceWindowId: ctx.sourceWindowId } : {}),
      ...(ctx.sourceBounds !== undefined ? { sourceBounds: ctx.sourceBounds } : {})
    });
    return ok(undefined);
  });

  bus.register("logs:revealFile", async () => {
    const logFilePath = getMainLogFilePath();
    if (logFilePath === undefined) {
      return err({
        kind: "unknown",
        code: "log_file_unavailable",
        message: "The PwrSnap log file path is unavailable"
      });
    }
    shell.showItemInFolder(logFilePath);
    return ok(undefined);
  });
}

/**
 * Common (agent + library) handler so every renderer failure reaches the
 * durable log owned by the process that created that BrowserWindow.
 */
export function registerRendererErrorHandler(): void {
  bus.register("renderer:reportError", async (req) => {
    if (!isRendererErrorReport(req)) {
      return err({
        kind: "validation",
        code: "invalid_renderer_error_report",
        message: "renderer:reportError received an invalid or oversized report"
      });
    }
    rendererErrorLog.error("report", req);
    return ok(undefined);
  });
}

export function _disposeLogEntrySubscriptionForTests(): void {
  unsubscribeLogEntries?.();
  unsubscribeLogEntries = null;
}

const RENDERER_ERROR_SOURCES = new Set<RendererErrorSource>([
  "error-boundary",
  "window-error",
  "unhandled-rejection"
]);

function isRendererErrorReport(value: unknown): value is RendererErrorReport {
  if (!isRecord(value)) return false;
  if (!RENDERER_ERROR_SOURCES.has(value.source as RendererErrorSource)) return false;
  if (!isBoundedString(value.timestamp, 128)) return false;
  if (!isBoundedString(value.href, 4096)) return false;
  if (!isBoundedString(value.userAgent, 2048)) return false;
  if (!isBoundedString(value.message, 16_384)) return false;
  for (const key of ["name", "filename", "stage"] as const) {
    if (value[key] !== undefined && !isBoundedString(value[key], 4096)) return false;
  }
  for (const key of ["stack", "componentStack"] as const) {
    if (value[key] !== undefined && !isBoundedString(value[key], 64 * 1024)) return false;
  }
  for (const key of ["lineno", "colno"] as const) {
    const coordinate = value[key];
    if (coordinate !== undefined &&
      (typeof coordinate !== "number" || !Number.isInteger(coordinate) || coordinate < 0)) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
