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
import { isOverriddenDataRoot } from "../../persistence/paths";
import { setExtraTrayMenuItems } from "../../tray";
import { isFlagged, PROFILE_NAMES, type ProfileName } from "./profiles";
import { runProbeOnly, runProfile } from "./runner";

const log = getMainLogger("pwrsnap:dev-seeder");

export { runProbeOnly, runProfile } from "./runner";
export type { ProfileName } from "./profiles";

/**
 * Wire dev-seeder tray items. Gated on `PWRSNAP_DATA_ROOT` being set
 * — a normal `pnpm dev` launch against the user's real Library data
 * root does NOT show the "Seed perf dataset" / "Probe perf" submenus.
 * This is belt-and-braces on top of `assertCanWipe()`'s override
 * requirement: the wipe path can't destroy real user data either
 * way, but exposing the buttons at all invites misclicks and turns a
 * "structurally impossible" guarantee into a "throws an error" one.
 * Show the menu only when the developer has explicitly opted into a
 * perf-rooted data dir.
 */
export function registerDevSeeder(): void {
  if (!isOverriddenDataRoot()) {
    log.info(
      "dev seeder skipped — PWRSNAP_DATA_ROOT not set, " +
        "running against real user data root"
    );
    return;
  }
  log.info("dev seeder registered");
  installTrayItems();
}

function installTrayItems(): void {
  const items: MenuItemConstructorOptions[] = [
    {
      label: "Seed perf dataset",
      submenu: PROFILE_NAMES.map<MenuItemConstructorOptions>((name) => ({
        label: isFlagged(name) ? `${name} (stress)` : name,
        click: () => {
          void runProfileFromTray(name);
        }
      }))
    },
    {
      label: "Probe perf (no re-seed)",
      submenu: PROFILE_NAMES.map<MenuItemConstructorOptions>((name) => ({
        label: isFlagged(name) ? `${name} (stress)` : name,
        click: () => {
          void runProbeOnlyFromTray(name);
        }
      }))
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

async function runProbeOnlyFromTray(name: ProfileName): Promise<void> {
  try {
    const result = await runProbeOnly(name);
    log.info("tray-probe completed", {
      profile: result.profile,
      totalMs: result.totalMs,
      measurementPath: result.measurementPath
    });
  } catch (cause) {
    log.error("tray-probe failed", {
      profile: name,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
