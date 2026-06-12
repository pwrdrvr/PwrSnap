// Login-item boot — launching with `--launched-at-login` must come up
// TRAY-ONLY: the command bus boots, but no library window is created.
// This is the headline guarantee of the launch-at-login feature (the
// whole point of starting at sign-in is hotkeys + tray without a
// window flash), and the create-on-demand recovery (`library:focus`)
// must still work from that state.
//
// The argv flag is the cross-platform detection seam: Windows registry
// and Linux autostart entries carry it literally; macOS SMAppService
// launches detect via `getLoginItemSettings().wasOpenedAtLogin`
// instead, which can't be simulated from a spec — the flag path keeps
// the boot branch itself covered everywhere.

import { expect, test } from "@playwright/test";
import { launchPwrSnapWindowless } from "./fixtures/electron-app";

/** Count live library windows in main — same predicate as the launch
 *  fixture's `waitForLibraryWindow` (renderer index.html, no
 *  `stage=region` hash from the pre-warmed selectors), but evaluated
 *  over Electron's BrowserWindow list so it sees windows Playwright
 *  hasn't attached to yet. */
async function countLibraryWindows(
  electronApp: Awaited<ReturnType<typeof launchPwrSnapWindowless>>["electronApp"]
): Promise<number> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().filter((win) => {
      if (win.isDestroyed()) return false;
      const url = win.webContents.getURL();
      return url.includes("/renderer/index.html") && !url.includes("stage=region");
    }).length;
  });
}

test("--launched-at-login boots tray-only; library still opens on demand", async () => {
  const app = await launchPwrSnapWindowless({
    extraArgs: ["--launched-at-login"]
  });
  try {
    // Boot is complete once the command bus answers — library:list is
    // registered late in the whenReady sequence, after the point where
    // the library window would have been created.
    await expect
      .poll(async () => {
        try {
          const result = await app.dispatch("library:list", {});
          return result.ok;
        } catch {
          // The E2E bridge installs at the END of whenReady — early
          // polls race it and throw; treat as "not booted yet".
          return false;
        }
      }, { timeout: 30_000 })
      .toBe(true);

    // The login-item branch must NOT have created a library window.
    expect(await countLibraryWindows(app.electronApp)).toBe(0);

    // Recovery: the same verb the tray's "Open Library" dispatches
    // creates the window on demand from the tray-only state.
    const focus = await app.dispatch("library:focus", {});
    expect(focus.ok).toBe(true);
    await expect
      .poll(async () => countLibraryWindows(app.electronApp), { timeout: 30_000 })
      .toBe(1);
  } finally {
    await app.close();
  }
});

test("a normal launch (no flag) still creates the library window", async () => {
  // Guard the inverse: the boot branch must not regress the default
  // path. (The rest of the suite implicitly covers this via the
  // windowed fixture, but pinning both arms here keeps the spec
  // self-contained when run in isolation.)
  const app = await launchPwrSnapWindowless({});
  try {
    await expect
      .poll(async () => countLibraryWindows(app.electronApp), { timeout: 30_000 })
      .toBe(1);
  } finally {
    await app.close();
  }
});
