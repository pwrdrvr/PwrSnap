import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const HEAD_PAGE_SIZE = 100;
const PRIMARY_BUNDLE_ID = "com.pwrsnap.synth.recent-feed";
const FIXTURE_PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000970485973000003e8000003e801b57b526b0000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082";

// CI's xvfb Electron runner occasionally spends more than a minute in
// launch/teardown for this large synthetic dataset when the full E2E
// suite runs before it. Keep the coverage in one BrowserWindow
// lifecycle so a slow first filter does not leave Playwright with a
// timed-out worker to clean up.
test.setTimeout(180_000);

type SourceFilterCase = {
  name: string;
  bundleId: string;
  sourceName: string;
  sidebarLabelPattern: RegExp;
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
    sidebarLabelPattern: /^(?:Splashtop Business|Macosx)$/,
    count: 47,
    targetIndex: 1,
    seedPrefix: "splashtop",
    // One row in the head page normally lets the sidebar refine the
    // bundle tail ("Macosx") to the OS name ("Splashtop Business"),
    // while the target row still sits outside the initially-loaded
    // rows. CI can observe the app_stats-only label first, which is
    // fine for this test: the bucket still needs to filter correctly.
    headVisibleCount: 1
  },
  {
    name: "Telegram",
    bundleId: "ru.keepcoder.Telegram",
    sourceName: "Telegram",
    sidebarLabelPattern: /^Telegram$/,
    count: 4,
    targetIndex: 0,
    seedPrefix: "telegram",
    // Telegram is a curated app id, so the sidebar can show the
    // friendly label from APP_INFO even when every Telegram capture
    // is beyond the first page.
    headVisibleCount: 0
  },
  {
    name: "LINE",
    bundleId: "jp.naver.line.mac",
    sourceName: "LINE",
    sidebarLabelPattern: /^LINE$/,
    count: 4,
    targetIndex: 0,
    seedPrefix: "line",
    // Regression: deriving from the bundle tail produced "Mac" until
    // a LINE row entered the loaded head page. The app_stats payload
    // must carry the captured app name up front.
    headVisibleCount: 0
  }
];

test("source-app filters load captures outside the initial virtualized page", async () => {
  const app = await launchPwrSnap();
  try {
    const window = app.window;
    await expect(window.getByRole("button", { name: /All Captures\s+0/ })).toBeVisible({
      timeout: 10_000
    });
    await disableAnimations(window);

    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-source-filter-"));
    const pngPath = path.join(dir, "fixture.png");
    await writeFile(pngPath, fixturePngBytes());

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

    await broadcastCapturesChanged(app);

    for (const filterCase of CASES) {
      await waitForAppStat(app, filterCase.bundleId, filterCase.count);
      await clickSourceFilterButton(window, filterCase);

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

test("active source-app filter refetches after capture stats change", async () => {
  const filterCase = CASES.find((candidate) => candidate.seedPrefix === "telegram");
  if (filterCase === undefined) throw new Error("telegram case missing");

  const app = await launchPwrSnap();
  try {
    const window = app.window;
    await expect(window.getByRole("button", { name: /All Captures\s+0/ })).toBeVisible({
      timeout: 10_000
    });
    await disableAnimations(window);

    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-source-filter-refresh-"));
    const pngPath = path.join(dir, "fixture.png");
    await writeFile(pngPath, fixturePngBytes());

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
        for (let i = 0; i < payload.headPageSize; i++) {
          bridge.seedCapture({
            id: `source-filter-refresh-recent-${i.toString().padStart(3, "0")}`,
            kind: "image",
            captured_at: new Date(now - i * 1000).toISOString(),
            source_app_bundle_id: payload.primaryBundleId,
            source_app_name: "Recent Feed",
            src_path: payload.pngPath,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 70,
            sha256: `source-filter-refresh-recent-${i.toString().padStart(3, "0")}`
          });
        }
        for (let i = 0; i < payload.targetCount; i++) {
          const id = `source-filter-refresh-${payload.seedPrefix}-${i.toString().padStart(3, "0")}`;
          bridge.seedCapture({
            id,
            kind: "image",
            captured_at: new Date(now - 24 * 60 * 60 * 1000 - i * 1000).toISOString(),
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
        seedPrefix: filterCase.seedPrefix
      }
    );

    await broadcastCapturesChanged(app);

    await waitForAppStat(app, filterCase.bundleId, filterCase.count);
    await clickSourceFilterButton(window, filterCase);

    const targetId = "source-filter-refresh-telegram-000";
    await expect.poll(() => countGridCells(window, targetId), { timeout: 15_000 }).toBe(1);

    await app.electronApp.evaluate(
      (
        _electron,
        payload: {
          pngPath: string;
          targetBundleId: string;
          targetLabel: string;
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
        bridge.seedCapture({
          id: "source-filter-refresh-telegram-new",
          kind: "image",
          captured_at: new Date(Date.now() + 1000).toISOString(),
          source_app_bundle_id: payload.targetBundleId,
          source_app_name: payload.targetLabel,
          src_path: payload.pngPath,
          width_px: 800,
          height_px: 600,
          device_pixel_ratio: 1,
          byte_size: 70,
          sha256: "source-filter-refresh-telegram-new"
        });
      },
      {
        pngPath,
        targetBundleId: filterCase.bundleId,
        targetLabel: filterCase.sourceName
      }
    );

    await broadcastCapturesChanged(app);

    await waitForAppStat(app, filterCase.bundleId, filterCase.count + 1);
    await expect
      .poll(() => countGridCells(window, "source-filter-refresh-telegram-new"), { timeout: 15_000 })
      .toBe(1);
    await expect.poll(() => countGridCells(window, targetId), { timeout: 15_000 }).toBe(1);
  } finally {
    await app.close();
  }
});

test("top-level filters do not appear as empty source-app rows after leaving Unknown app focus", async () => {
  const app = await launchPwrSnap();
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-source-filter-unknown-"));
    const pngPath = path.join(dir, "fixture.png");
    await writeFile(pngPath, fixturePngBytes());

    await app.electronApp.evaluate(
      (_electron, payload: { pngPath: string }) => {
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
        bridge.seedCapture({
          id: "source-filter-unknown-null-bundle",
          kind: "image",
          captured_at: new Date().toISOString(),
          source_app_bundle_id: null,
          source_app_name: null,
          src_path: payload.pngPath,
          width_px: 800,
          height_px: 600,
          device_pixel_ratio: 1,
          byte_size: 70,
          sha256: "source-filter-unknown-null-bundle"
        });
      },
      { pngPath }
    );

    await broadcastCapturesChanged(app);

    const window = app.window;
    await disableAnimations(window);
    await waitForAppStat(app, null, 1);

    const unknownSourceButton = window
      .locator("button.psl__nav")
      .filter({ has: window.locator(".psl__nav-label", { hasText: /^Unknown app$/ }) })
      .filter({ has: window.locator(".psl__nav-count", { hasText: /^1$/ }) });
    await expect(unknownSourceButton).toHaveCount(1, { timeout: 30_000 });

    await unknownSourceButton.first().click();
    await expect(window.locator(".psl__cell[data-cell-id='source-filter-unknown-null-bundle']")).toHaveCount(1, {
      timeout: 10_000
    });

    await window.locator(".psl__cell[data-cell-id='source-filter-unknown-null-bundle']").click();
    await expect(window.locator(".psl")).toHaveAttribute("data-mode", "focus", {
      timeout: 10_000
    });

    await window
      .locator("button.psl__nav")
      .filter({ has: window.locator(".psl__nav-label", { hasText: /^Today$/ }) })
      .click();

    const unknownSourceRows = window
      .locator("button.psl__nav")
      .filter({ has: window.locator(".psl__nav-label", { hasText: /^Unknown app$/ }) });
    await expect(unknownSourceRows).toHaveCount(1);
    await expect(unknownSourceRows.first().locator(".psl__nav-count")).toHaveText("1");
  } finally {
    await app.close();
  }
});

function fixturePngBytes(): Buffer {
  return Buffer.from(FIXTURE_PNG_HEX, "hex");
}

async function broadcastCapturesChanged(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<void> {
  await app.electronApp.evaluate((electronModule) => {
    const { BrowserWindow } = electronModule;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("events:captures:changed", { changedIds: [] });
    }
  });
}

async function waitForAppStat(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  bundleId: string | null,
  expectedCount: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await app.dispatch("library:list", { limit: 1, includeDeleted: true });
        if (!result.ok) return -1;
        return result.value.appStats?.find((stat) => stat.bundleId === bundleId)?.count ?? 0;
      },
      {
        timeout: 15_000,
        message: `waiting for app_stats ${bundleId}=${expectedCount}`
      }
    )
    .toBe(expectedCount);
}

async function disableAnimations(page: Awaited<ReturnType<typeof launchPwrSnap>>["window"]): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `
  });
}

async function clickSourceFilterButton(
  page: Awaited<ReturnType<typeof launchPwrSnap>>["window"],
  filterCase: SourceFilterCase
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ patternSource, patternFlags }) => {
            const pattern = new RegExp(patternSource, patternFlags);
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button.psl__nav"));
            for (const button of buttons) {
              const label = button.querySelector(".psl__nav-label")?.textContent?.trim() ?? "";
              if (!pattern.test(label)) continue;
              if (button.classList.contains("is-active")) return true;
              button.click();
              return false;
            }
            return false;
          },
          {
            patternSource: filterCase.sidebarLabelPattern.source,
            patternFlags: filterCase.sidebarLabelPattern.flags
          }
        ),
      {
        timeout: 30_000,
        message: `activating source filter ${filterCase.name}`
      }
    )
    .toBe(true);
}

async function countGridCells(page: Awaited<ReturnType<typeof launchPwrSnap>>["window"], id: string): Promise<number> {
  return page.evaluate(
    (targetId) => document.querySelectorAll(`.psl__cell[data-cell-id="${targetId}"]`).length,
    id
  );
}
