// E2E coverage for the Library DetailRail's vertical activity-bar
// refresh. Verifies that:
//
//   • The rail renders three vertical tabs: Info / OCR / Chat.
//   • Switching tabs swaps the panel body.
//   • The persistent footer (L/M/H copy + actions) is visible on
//     every tab.
//   • Pinning + unpinning via clicking the active tab works.
//
// Mirrors the editor-activity-bar spec for the Library surface. The
// Library rail uses its own per-window pin state (separate from the
// editor's settings-persisted state).
//
// macOS-only: the `library:openInLibrary` → OPEN_FOCUS reducer chain
// races on Linux/Chromium-Xvfb — same surface the existing
// library-focus-scroll.spec.ts (issue #scroll-restoration) and
// library-focus-phase32.spec.ts skip on non-macOS for. The renderer's
// `pendingOpenId` two-stage effect waits for `useLibrary`'s captures
// refetch to surface the freshly-seeded capture, and on Xvfb that
// refetch lands either late or not at all within the 15s wait. The
// DetailRail never mounts, the test sees no `psl-right-tab-*` icon.
// PwrSnap is macOS-first through Phase 7 (per AGENTS.md), so skipping
// the Linux variant matches the project's existing posture; unit tests
// cover the same render shape (DetailRail.test.tsx, 19 specs incl.
// 4 dedicated to the vertical tabs + ARIA wiring).

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

test.setTimeout(120_000);

test.describe("Library DetailRail — vertical activity bar (macOS)", () => {
  // Same precedent + rationale as library-focus-scroll.spec.ts and
  // library-focus-phase32.spec.ts: the Library Focus entry path through
  // `library:openInLibrary` races on Linux/Xvfb (the renderer's
  // pendingOpenId effect waits for useLibrary's refetch to surface
  // the freshly-seeded capture; on Xvfb the refetch lands late or not
  // at all within the 15s timeout). PwrSnap is macOS-first through
  // Phase 7. Renderer-level coverage lives in DetailRail.test.tsx.
  test.skip(!isMac, "Library Focus entry via library:openInLibrary is macOS-only.");

test("library-right-rail: renders Info/OCR/Chat vertical tabs with persistent footer", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = app.window;

    // Open the capture in Library Focus.
    await app.dispatch("library:openInLibrary", { captureId });

    // Wait for the DetailRail to mount in Focus mode.
    await win
      .locator('[data-testid="psl-right-tab-info"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    // All three tabs are present.
    await expect(
      win.locator('[data-testid="psl-right-tab-info"]')
    ).toHaveCount(1);
    await expect(
      win.locator('[data-testid="psl-right-tab-ocr"]')
    ).toHaveCount(1);
    await expect(
      win.locator('[data-testid="psl-right-tab-chat"]')
    ).toHaveCount(1);

    // Persistent footer is always present.
    await expect(
      win.locator('[data-testid="psl-right-footer"]')
    ).toHaveCount(1);

    // Default tab is Info — the DetailTab inputs (Title / Description /
    // Filename) are visible.
    await expect(win.locator(".psl__field-input").first()).toBeVisible();

    // Switch to OCR.
    await win.locator('[data-testid="psl-right-tab-ocr"]').click();
    await win
      .locator(".psl__ocr-tab")
      .waitFor({ state: "visible", timeout: 5_000 });

    // Footer still visible.
    await expect(
      win.locator('[data-testid="psl-right-footer"]')
    ).toBeVisible();

    // Switch to Chat.
    await win.locator('[data-testid="psl-right-tab-chat"]').click();
    await win
      .locator('[data-testid="chat-panel"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(
      win.locator('[data-testid="chat-context"]')
    ).toBeVisible();

    // Footer is still visible — the rail's footer is independent of
    // the active tab.
    await expect(
      win.locator('[data-testid="psl-right-footer"]')
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("library-right-rail: clicking active tab unpins to hover-pop", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = app.window;

    await app.dispatch("library:openInLibrary", { captureId });
    await win
      .locator('[data-testid="psl-right-tab-info"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    // Pinned panel rendered (default state).
    await win
      .locator('[data-testid="psl-right-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Click active Info tab → unpin → hover-pop visible.
    await win.locator('[data-testid="psl-right-tab-info"]').click();
    await expect(
      win.locator('[data-testid="psl-right-panel-pinned"]')
    ).toHaveCount(0);
    await win
      .locator('[data-testid="psl-right-panel-hover"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Click another tab → re-pin and switch.
    await win.locator('[data-testid="psl-right-tab-ocr"]').click();
    await win
      .locator('[data-testid="psl-right-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(win.locator(".psl__ocr-tab")).toBeVisible();
  } finally {
    await app.close();
  }
});

}); // describe — Library DetailRail (macOS)

// ---- Shared helpers --------------------------------------------------

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-rightrail-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `rightrail-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await app.electronApp.evaluate(
    (_electron, payload: { id: string; pngPath: string }) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: {
              id: string;
              kind: "image" | "video";
              captured_at: string;
              source_app_bundle_id: string | null;
              source_app_name: string | null;
              legacy_src_path: string | null;
              width_px: number;
              height_px: number;
              device_pixel_ratio: number;
              byte_size: number;
              sha256: string;
            }) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.id,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.spec",
        source_app_name: "Right Rail Spec",
        legacy_src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id
      });
    },
    { id: captureId, pngPath }
  );
  return captureId;
}
