// Dev-only seeder entry point. Registers tray menu items + CLI flag
// handlers + extra command-bus commands used to populate large
// synthetic datasets for perf measurement.
//
// This file (and every other file in this directory) is built into
// the bundle ONLY in development. The caller in main/index.ts gates
// the dynamic `import("./dev/seeder")` on `import.meta.env.DEV` —
// electron-vite statically replaces that boolean at build time, so
// Rollup drops the dynamic import + this entire chunk in production.
//
// Phase 2 fills this in (profiles, runner, wipe, tray menu, CLI
// flag). Phase 1 ships the placeholder so the build path is wired.

import { getMainLogger } from "../../log";

const log = getMainLogger("pwrsnap:dev-seeder");

export function registerDevSeeder(): void {
  log.info("dev seeder registered (placeholder — Phase 2 wires the runner)");
}
