// Keeps electron-log's file transport out of the operator's real log
// directory for the whole desktop-main suite.
//
// Outside Electron, electron-log names its log directory after the nearest
// package.json it can find (`productName`, else `name`) and writes to the
// platform default under the home directory — on macOS that is
// `~/Library/Logs/<name>/main.log`. Run from the repo root that resolves to
// `pwrsnap-workspace`; run with `apps/desktop` as the cwd or main module it
// resolves to `PwrSnap`, which IS the installed app's log. Every
// `getMainLogger(...).warn(...)` a fixture provokes (a quarantined corrupt
// settings file, an unhydrated store) then lands in that file, interleaved
// with the real app's lines and naming vitest temp paths — which reads as a
// real incident to anyone diagnosing the app.
//
// The fix is a path redirect, not `level = false`: production code turns the
// file transport back on (`setMainLogDebugCollectionEnabled` writes
// `transports.file.level`), and a disabled transport would also skip the
// app-logs hook that `initializeMainLogger` installs on it. Pointing
// `resolvePathFn` at one fixed temp dir keeps the transport live and the
// output bounded (electron-log rotates at `maxSize`), without leaving a new
// directory behind per test file.
//
// electron-log is an externalized CJS dependency, so this patches the same
// instance `src/main/log.ts` imports, and `vi.resetModules()` does not hand
// a test a fresh, unpatched copy. Pinned by
// `__tests__/electron-log-isolation.test.ts`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import mainLog from "electron-log/main.js";
import nodeLog from "electron-log/node.js";

const VITEST_LOG_DIR = join(tmpdir(), "pwrsnap-vitest-logs");

for (const logger of [mainLog, nodeLog]) {
  logger.transports.file.resolvePathFn = (variables) =>
    join(VITEST_LOG_DIR, variables.fileName ?? "main.log");
}
