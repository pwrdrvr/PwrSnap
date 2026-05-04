// Tiny logger shim. Phase 1 keeps it intentionally small — just enough to
// satisfy the lifted PwrAgnt JSON-RPC + transport modules. Phase 3 will
// expand to match PwrAgnt's structured-payload compaction (see
// ~/github/PwrAgnt/apps/desktop/src/main/log.ts) when renderer-error
// reporting + telemetry need it.

import electronLog from "electron-log/main.js";
import { inspect } from "node:util";

let initialized = false;

export function initializeMainLogger(): void {
  if (initialized) {
    return;
  }
  initialized = true;
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
