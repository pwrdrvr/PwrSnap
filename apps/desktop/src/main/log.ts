// Tiny logger shim. Phase 1 keeps it intentionally small — just enough to
// satisfy the lifted PwrAgnt JSON-RPC + transport modules. Phase 3 will
// expand to match PwrAgnt's structured-payload compaction (its
// apps/desktop/src/main/log.ts) when renderer-error
// reporting + telemetry need it.

import electronLog from "electron-log/main.js";
import { inspect } from "node:util";
import { parseProcessRoleFlag } from "./process-role";

let initialized = false;
let stdioErrorHandlersInstalled = false;

export const MAIN_LOG_FILE_LEVEL = "info";
export const MAIN_LOG_FILE_MAX_SIZE_BYTES = 1024 * 1024;

type StdioError = Error & {
  code?: unknown;
};

function isClosedStdioError(error: unknown): error is StdioError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = (error as StdioError).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function disableConsoleTransport(): void {
  electronLog.transports.console.level = false;
}

function rethrowUnexpectedStdioError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function handleStdioError(error: unknown): void {
  if (isClosedStdioError(error)) {
    disableConsoleTransport();
    return;
  }

  rethrowUnexpectedStdioError(error);
}

function installStdioErrorHandlers(): void {
  if (stdioErrorHandlersInstalled) {
    return;
  }

  stdioErrorHandlersInstalled = true;
  process.stdout.on("error", handleStdioError);
  process.stderr.on("error", handleStdioError);
}

function guardConsoleTransport(): void {
  const transport = electronLog.transports.console;
  const writeFn = transport.writeFn;

  transport.writeFn = (options) => {
    if (transport.level === false) {
      return;
    }

    try {
      writeFn(options);
    } catch (error) {
      if (isClosedStdioError(error)) {
        disableConsoleTransport();
        return;
      }

      throw error;
    }
  };
}

export function initializeMainLogger(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // Two-process split: the agent and library are separate Electron
  // processes that share one app name → one logs dir. Left at the
  // electron-log default both would append to (and rotate) the SAME
  // `main.log` — interleaved lines, racing rotations. The library child
  // is the only process spawned with an explicit role flag (the full
  // role isn't resolved until later in bootstrap), so key off that: it
  // writes to its own `library.log`. Combined/agent keep `main.log`.
  const roleFlag = parseProcessRoleFlag(process.argv);
  if (roleFlag === "library") {
    electronLog.transports.file.fileName = "library.log";
  }
  // Short tag on the LIBRARY child's lines only, so interleaved
  // dev-terminal output (both processes inherit one stdio) — and any
  // concatenation of the two log files — is attributable at a glance.
  // Combined/agent get NO tag: single-process mode keeps the exact
  // pre-split line format, so turning the experiment off changes
  // nothing about the logs.
  const tagPrefix = roleFlag === "library" ? "lib " : "";

  installStdioErrorHandlers();
  guardConsoleTransport();
  electronLog.initialize();
  // Keep persistent logs useful without accidentally recreating Codex-style
  // TRACE/DEBUG write churn. electron-log rotates by default, but we make the
  // SSD-facing bounds explicit here instead of relying on package defaults.
  electronLog.transports.file.level = MAIN_LOG_FILE_LEVEL;
  electronLog.transports.file.maxSize = MAIN_LOG_FILE_MAX_SIZE_BYTES;
  // electron-log's default formatter calls util.inspect with depth=2,
  // which collapses any nested object two levels deep into "[Object]"
  // — useless for diagnostic logs that ship structured rects /
  // candidates / etc. Bump depth so we actually see what we logged.
  // Format hook applies to both console + file transports.
  for (const transport of [electronLog.transports.console, electronLog.transports.file]) {
    transport.format = ({ message }) => {
      const parts = message.data.map((d) =>
        typeof d === "string" ? d : inspect(d, { depth: 6, breakLength: 120, colors: false })
      );
      return [
        `${message.date.toISOString().slice(11, 23)} ${tagPrefix}(${message.scope ?? "?"})`,
        ...parts
      ];
    };
  }
}

export function getMainLogger(scope: string) {
  return electronLog.scope(scope);
}
