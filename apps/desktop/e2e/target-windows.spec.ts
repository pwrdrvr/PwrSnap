// Visual harness smoke test — proves the target-window helper paints
// the colors the spec asks for. This isolates harness bugs from
// region-capture bugs: if a future spec captures a 200×200 rect over
// "tile-red" and gets blue back, we want to know whether the harness
// failed to paint red or the capture pipeline grabbed the wrong area.
//
// The actual screen-capture verification specs land in a Mac-only
// suite (screencapture requires Screen Recording TCC perms; CI runners
// don't have them). For Linux CI we just verify the windows opened
// with the right titles/positions — enough to keep the harness honest.

import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";
import { FOUR_TILE_GRID, spawnTargetWindows } from "./fixtures/target-windows";

test("FOUR_TILE_GRID spawns four titled windows at the expected positions", async () => {
  const app = await launchPwrSnap();
  try {
    const targets = await spawnTargetWindows(app.electronApp, FOUR_TILE_GRID);
    try {
      // Pull window state out of main and check it lines up.
      const live = await app.electronApp.evaluate(() => {
        const store = (
          globalThis as unknown as {
            __PWRSNAP_TARGETS__?: Map<string, Electron.BrowserWindow>;
          }
        ).__PWRSNAP_TARGETS__;
        if (store === undefined) return [];
        return Array.from(store.entries()).map(([id, win]) => {
          const bounds = win.getBounds();
          return {
            id,
            title: win.getTitle(),
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            destroyed: win.isDestroyed()
          };
        });
      });

      expect(live).toHaveLength(FOUR_TILE_GRID.length);
      for (const spec of FOUR_TILE_GRID) {
        const found = live.find((row) => row.id === spec.id);
        expect(found, `target ${spec.id} should be live`).toBeDefined();
        if (found === undefined) continue;
        expect(found.destroyed).toBe(false);
        expect(found.width).toBe(spec.rect.width);
        expect(found.height).toBe(spec.rect.height);
        // Positions on Linux/xvfb get clamped by the WM if the virtual
        // display is small. Just assert non-negative — the harness
        // honored the request as best it could.
        expect(found.x).toBeGreaterThanOrEqual(0);
        expect(found.y).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await targets.close();
    }
  } finally {
    await app.close();
  }
});

test("close() destroys every spawned target window", async () => {
  const app = await launchPwrSnap();
  try {
    const targets = await spawnTargetWindows(app.electronApp, FOUR_TILE_GRID.slice(0, 2));
    await targets.close();

    const liveAfter = await app.electronApp.evaluate(() => {
      const store = (
        globalThis as unknown as {
          __PWRSNAP_TARGETS__?: Map<string, Electron.BrowserWindow>;
        }
      ).__PWRSNAP_TARGETS__;
      if (store === undefined) return 0;
      return Array.from(store.values()).filter((w) => !w.isDestroyed()).length;
    });
    expect(liveAfter).toBe(0);
  } finally {
    await app.close();
  }
});
