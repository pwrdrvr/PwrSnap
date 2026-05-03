// Tiny logger shim. Phase 1 keeps it intentionally small — just enough to
// satisfy the lifted PwrAgnt JSON-RPC + transport modules. Phase 3 will
// expand to match PwrAgnt's structured-payload compaction (see
// ~/github/PwrAgnt/apps/desktop/src/main/log.ts) when renderer-error
// reporting + telemetry need it.

import electronLog from "electron-log/main.js";

let initialized = false;

export function initializeMainLogger(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  electronLog.initialize();
}

export function getMainLogger(scope: string) {
  return electronLog.scope(scope);
}
