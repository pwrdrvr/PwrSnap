// Dev-only seeder entry point. Adds tray menu items + exposes
// `runProfile()` as the API the CLI flag (`--seed=<profile>`) drives.
//
// This file (and every other file in this directory) is built into
// the bundle ONLY in development. The caller in main/index.ts gates
// the dynamic `import("./dev/seeder")` on `import.meta.env.DEV` —
// electron-vite statically replaces that boolean at build time, so
// Rollup drops the dynamic import + this entire chunk in production.

import type { MenuItemConstructorOptions } from "electron";

import { getMainLogger } from "../../log";
import { setExtraTrayMenuItems } from "../../tray";
import { isFlagged, PROFILE_NAMES, type ProfileName } from "./profiles";
import { runProfile } from "./runner";

const log = getMainLogger("pwrsnap:dev-seeder");

export { runProfile } from "./runner";
export type { ProfileName } from "./profiles";

export function registerDevSeeder(): void {
  log.info("dev seeder registered");
  installTrayItems();
}

function installTrayItems(): void {
  const items: MenuItemConstructorOptions[] = [
    {
      label: "Seed perf dataset",
      submenu: [
        ...PROFILE_NAMES.map<MenuItemConstructorOptions>((name) => ({
          label: isFlagged(name) ? `${name} (stress)` : name,
          click: () => {
            void runProfileFromTray(name);
          }
        }))
      ]
    }
  ];
  setExtraTrayMenuItems(items);
}

async function runProfileFromTray(name: ProfileName): Promise<void> {
  try {
    const result = await runProfile(name, { allowFlagged: isFlagged(name) });
    log.info("tray-seed completed", {
      profile: result.profile,
      rows: result.totalRows,
      totalMs: result.totalMs,
      measurementPath: result.measurementPath
    });
  } catch (cause) {
    log.error("tray-seed failed", {
      profile: name,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
