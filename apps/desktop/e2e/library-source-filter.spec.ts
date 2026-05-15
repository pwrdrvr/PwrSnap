import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const HEAD_PAGE_SIZE = 100;
const PRIMARY_BUNDLE_ID = "com.pwrsnap.synth.recent-feed";

// CI's xvfb Electron runner occasionally spends tens of seconds in
// launch/teardown for this large synthetic dataset. Keep the coverage
// in one BrowserWindow lifecycle so a slow first filter does not leave
// Playwright with a timed-out worker to clean up.
test.setTimeout(90_000);

type SourceFilterCase = {
  name: string;
  bundleId: string;
  sourceName: string;
  sidebarPattern: RegExp;
  count: number;
  targetIndex: number;
  seedPrefix: string;
  headVisibleCount: number;
};

const CASES: SourceFilterCase[] = [
  {
    name: "Splashtop Business",
    bundleId: "com.splashtop.stb.macosx",
    sourceName: "Splashtop Business",
    sidebarPattern: /Splashtop Business\s+47/,
    count: 47,
    targetIndex: 1,
    seedPrefix: "splashtop",
    // One row in the head page lets the sidebar refine the bundle
    // tail ("Macosx") to the OS name ("Splashtop Business"), while
    // the target row still sits outside the initially-loaded rows.
    headVisibleCount: 1
  },
  {
    name: "Systempreferences",
    bundleId: "com.apple.systempreferences",
    sourceName: "System Settings",
    sidebarPattern: /Systempreferences\s+1/,
    count: 1,
    targetIndex: 0,
    seedPrefix: "systempreferences",
    // Mirrors the real screenshot label: no loaded record has refined
    // the app_stats-only label to "System Settings" yet.
    headVisibleCount: 0
  },
  {
    name: "Telegram",
    bundleId: "ru.keepcoder.Telegram",
    sourceName: "Telegram",
    sidebarPattern: /Telegram\s+4/,
    count: 4,
    targetIndex: 0,
    seedPrefix: "telegram",
    // Telegram is a curated app id, so the sidebar can show the
    // friendly label from APP_INFO even when every Telegram capture
    // is beyond the first page.
    headVisibleCount: 0
  }
];

test("source-app filters load captures outside the initial virtualized page", async () => {
  const app = await launchPwrSnap();
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-source-filter-"));
    const pngPath = path.join(dir, "fixture.png");
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
      "hex"
    );
    await writeFile(pngPath, pngBytes);

    await app.electronApp.evaluate(
      (
        _electron,
        payload: {
          headPageSize: number;
          pngPath: string;
          primaryBundleId: string;
          cases: Array<{
            bundleId: string;
            sourceName: string;
            count: number;
            seedPrefix: string;
            headVisibleCount: number;
          }>;
        }
      ) => {
        type Bridge = {
          seedCapture: (input: {
            id: string;
            kind: "image" | "video";
            captured_at: string;
            source_app_bundle_id: string | null;
            source_app_name: string | null;
            src_path: string;
            width_px: number;
            height_px: number;
            device_pixel_ratio: number;
            byte_size: number;
            sha256: string;
          }) => unknown;
        };
        const bridge = (globalThis as unknown as { __PWRSNAP_TEST__: Bridge }).__PWRSNAP_TEST__;
        const now = Date.now();
        const recentCount = payload.headPageSize - Math.max(
          ...payload.cases.map((filterCase) => filterCase.headVisibleCount)
        );

        for (let i = 0; i < recentCount; i++) {
          bridge.seedCapture({
            id: `source-filter-recent-${i.toString().padStart(3, "0")}`,
            kind: "image",
            captured_at: new Date(now - i * 1000).toISOString(),
            source_app_bundle_id: payload.primaryBundleId,
            source_app_name: "Recent Feed",
            src_path: payload.pngPath,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 70,
            sha256: `source-filter-recent-${i.toString().padStart(3, "0")}`
          });
        }

        let olderOffsetSeconds = 0;
        for (const filterCase of payload.cases) {
          for (let i = 0; i < filterCase.count; i++) {
            const id = `source-filter-${filterCase.seedPrefix}-${i.toString().padStart(3, "0")}`;
            const capturedAt =
              i < filterCase.headVisibleCount
                ? new Date(now - (recentCount + olderOffsetSeconds + i) * 1000).toISOString()
                : new Date(
                    now - 24 * 60 * 60 * 1000 - (olderOffsetSeconds + i) * 1000
                  ).toISOString();
            bridge.seedCapture({
              id,
              kind: "image",
              captured_at: capturedAt,
              source_app_bundle_id: filterCase.bundleId,
              source_app_name: filterCase.sourceName,
              src_path: payload.pngPath,
              width_px: 800,
              height_px: 600,
              device_pixel_ratio: 1,
              byte_size: 70,
              sha256: id
            });
          }
          olderOffsetSeconds += filterCase.count;
        }
      },
      {
        headPageSize: HEAD_PAGE_SIZE,
        pngPath,
        primaryBundleId: PRIMARY_BUNDLE_ID,
        cases: CASES.map(({ bundleId, sourceName, count, seedPrefix, headVisibleCount }) => ({
          bundleId,
          sourceName,
          count,
          seedPrefix,
          headVisibleCount
        }))
      }
    );

    await app.electronApp.evaluate((electronModule) => {
      const { BrowserWindow } = electronModule;
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send("events:captures:changed", { changedIds: [] });
      }
    });

    const window = app.window;
    for (const filterCase of CASES) {
      const sourceButton = window.getByRole("button", { name: filterCase.sidebarPattern });
      await expect(sourceButton).toBeVisible({ timeout: 10_000 });

      await sourceButton.scrollIntoViewIfNeeded({ timeout: 10_000 });
      await sourceButton.click({ timeout: 10_000 });

      const targetId = `source-filter-${filterCase.seedPrefix}-${filterCase.targetIndex
        .toString()
        .padStart(3, "0")}`;
      await expect(window.locator(`.psl__cell[data-cell-id="${targetId}"]`)).toHaveCount(1, {
        timeout: 10_000
      });
    }
  } finally {
    await app.close();
  }
});
