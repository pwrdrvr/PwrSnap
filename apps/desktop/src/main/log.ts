// Tiny logger shim. Phase 1 keeps it intentionally small — just enough to
// satisfy the lifted PwrAgnt JSON-RPC + transport modules. Phase 3 will
// expand to match PwrAgnt's structured-payload compaction (its
// apps/desktop/src/main/log.ts) when renderer-error
// reporting + telemetry need it.

import electronLog from "electron-log/main.js";
import { inspect } from "node:util";

let initialized = false;
let stdioErrorHandlersInstalled = false;

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
  installStdioErrorHandlers();
  guardConsoleTransport();
  electronLog.initialize();
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
      return [`${message.date.toISOString().slice(11, 23)} (${message.scope ?? "?"})`, ...parts];
    };
  }
}

export function getMainLogger(scope: string) {
  return electronLog.scope(scope);
}
