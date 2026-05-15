import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const HEAD_PAGE_SIZE = 100;
const PRIMARY_BUNDLE_ID = "com.pwrsnap.synth.recent-feed";

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

for (const filterCase of CASES) {
  test(`source-app filter loads ${filterCase.name} captures outside the initial virtualized page`, async () => {
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
            targetBundleId: string;
            targetLabel: string;
            targetCount: number;
            seedPrefix: string;
            headVisibleCount: number;
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
          const bridge = (
            globalThis as unknown as { __PWRSNAP_TEST__: Bridge }
          ).__PWRSNAP_TEST__;
          const now = Date.now();
          const recentCount = payload.headPageSize - payload.headVisibleCount;
          for (let i = 0; i < recentCount; i++) {
            bridge.seedCapture({
              id: `source-filter-recent-${payload.seedPrefix}-${i.toString().padStart(3, "0")}`,
              kind: "image",
              captured_at: new Date(now - i * 1000).toISOString(),
              source_app_bundle_id: payload.primaryBundleId,
              source_app_name: "Recent Feed",
              src_path: payload.pngPath,
              width_px: 800,
              height_px: 600,
              device_pixel_ratio: 1,
              byte_size: 70,
              sha256: `source-filter-recent-${payload.seedPrefix}-${i.toString().padStart(3, "0")}`
            });
          }

          for (let i = 0; i < payload.targetCount; i++) {
            const id = `source-filter-${payload.seedPrefix}-${i.toString().padStart(3, "0")}`;
            const capturedAt =
              i < payload.headVisibleCount
                ? new Date(now - (recentCount + i) * 1000).toISOString()
                : new Date(now - 24 * 60 * 60 * 1000 - i * 1000).toISOString();
            bridge.seedCapture({
              id,
              kind: "image",
              captured_at: capturedAt,
              source_app_bundle_id: payload.targetBundleId,
              source_app_name: payload.targetLabel,
              src_path: payload.pngPath,
              width_px: 800,
              height_px: 600,
              device_pixel_ratio: 1,
              byte_size: 70,
              sha256: id
            });
          }
        },
        {
          headPageSize: HEAD_PAGE_SIZE,
          pngPath,
          primaryBundleId: PRIMARY_BUNDLE_ID,
          targetBundleId: filterCase.bundleId,
          targetLabel: filterCase.sourceName,
          targetCount: filterCase.count,
          seedPrefix: filterCase.seedPrefix,
          headVisibleCount: filterCase.headVisibleCount
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
      await expect(window.getByRole("button", { name: filterCase.sidebarPattern })).toBeVisible();

      await window.evaluate((targetBundleId) => {
        type Dispatch = (name: string, req: unknown) => Promise<unknown>;
        const api = (
          globalThis as unknown as { pwrsnapApi: { dispatch: Dispatch } }
        ).pwrsnapApi;
        const original = api.dispatch.bind(api);
        api.dispatch = async (name: string, req: unknown): Promise<unknown> => {
          if (
            name === "library:list" &&
            typeof req === "object" &&
            req !== null &&
            "appBundleId" in req &&
            (req as { appBundleId?: unknown }).appBundleId === targetBundleId
          ) {
            await new Promise((resolve) => setTimeout(resolve, 75));
          }
          return original(name, req);
        };
      }, filterCase.bundleId);

      await window.getByRole("button", { name: filterCase.sidebarPattern }).click();

      const targetId = `source-filter-${filterCase.seedPrefix}-${filterCase.targetIndex
        .toString()
        .padStart(3, "0")}`;
      await expect
        .poll(async () =>
          window.evaluate(
            (id) => document.querySelectorAll(`.psl__cell[data-cell-id="${id}"]`).length,
            targetId
          )
        )
        .toBe(1);
    } finally {
      await app.close();
    }
  });
}
