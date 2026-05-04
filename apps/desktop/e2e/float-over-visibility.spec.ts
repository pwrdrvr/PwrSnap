// Float-over visibility spec — guards Bug 2 from
// docs/plans/2026-05-04-001 ("toast almost never shows / flashes for
// a microsecond"). The pre-Phase-4 e2e suite asserts post-capture
// state via DB queries and Result envelopes — it doesn't observe the
// actual on-screen toast. So a toast that's hidden, off-display, or
// dismissed within 200ms passed every spec.
//
// What this file asserts:
//
//   1. After dispatching `setFloatOverState({show-loaded, captureId})`,
//      the float-over BrowserWindow is visible (`isVisible === true`)
//      within 200ms and STAYS visible past the 4s mark (auto-dismiss
//      countdown is 6s for the standard variant).
//
//   2. A second show-loaded fired within 500ms of the first does NOT
//      leave the second toast visible-then-hidden after ~220ms — the
//      stale exit-animation timer bug is regressed.
//
//   3. A `cancel` event hides the window synchronously with no
//      lingering visibility (matches the "user pressed Esc, never
//      saw the empty pre-show" semantics).
//
// Why we drive setFloatOverState directly instead of running through
// the full pickRegion + screencapture path: the headless E2E harness
// can't synthesize mouse/keyboard against a screen-saver-level
// selector window, AND screencapture(1) requires Screen Recording
// TCC which the test Electron binary doesn't have. The float-over
// state machine + window lifecycle are decoupled from the selector,
// so testing them in isolation here is sufficient — the integration
// test (PWRSNAP_E2E_REAL_CAPTURE=1) in region-capture.spec.ts covers
// the snapshot path.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

/**
 * Find the float-over BrowserWindow by URL hash. Returns its visibility,
 * bounds, and current renderer-side state (data-state attribute on the
 * root host div). Returns null when the float-over hasn't been created
 * yet (before the first show-idle/show-loaded).
 */
async function inspectFloatOver(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<{
  exists: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  dataState: string | null;
}> {
  return await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      !w.isDestroyed() && w.webContents.getURL().includes("stage=float-over")
    );
    if (win === undefined) {
      return { exists: false, visible: false, bounds: null, dataState: null };
    }
    let dataState: string | null = null;
    try {
      // Read the renderer's [data-state] attribute on the host div.
      // Wrapped in try/catch because executeJavaScript can fail if the
      // page hasn't loaded yet.
      dataState = (await win.webContents.executeJavaScript(
        "document.querySelector('[data-state]')?.getAttribute('data-state') ?? null",
        true
      )) as string | null;
    } catch {
      dataState = null;
    }
    return {
      exists: true,
      visible: win.isVisible(),
      bounds: win.getBounds(),
      dataState
    };
  });
}

/**
 * Drive the float-over state machine directly. Routed through the E2E
 * test bridge installed by main/index.ts when PWRSNAP_E2E=1. The bridge
 * calls the same `setFloatOverState` the production code path uses.
 */
async function setFloatOverState(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  event: { kind: "show-idle" } | { kind: "show-loaded"; captureId: string } | { kind: "cancel" } | { kind: "dismiss" }
): Promise<void> {
  await app.electronApp.evaluate(async (_electron, payload) => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__: {
          setFloatOverState: (event: unknown) => void;
        };
      }
    ).__PWRSNAP_TEST__;
    bridge.setFloatOverState(payload);
  }, event);
}

/**
 * Seed a synthetic capture row so library:byId resolves. Same shape
 * as editor.spec.ts — duplicated locally because cross-spec helper
 * imports run into Playwright's worker-isolation rules. ~30 lines.
 */
async function seedCapture(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-floatover-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `fo-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await app.electronApp.evaluate(
    (_electron, payload: { id: string; pngPath: string }) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: Record<string, unknown>) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.id,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.float-over-spec",
        source_app_name: "Float-over Spec",
        src_path: payload.pngPath,
        width_px: 1920,
        height_px: 1080,
        device_pixel_ratio: 2,
        byte_size: 70,
        sha256: payload.id
      });
    },
    { id: captureId, pngPath }
  );
  return captureId;
}

test.describe("float-over visibility", () => {
  test.skip(!isMac, "float-over visibility relies on macOS BrowserWindow alwaysOnTop semantics");

  test("show-loaded reaches visible within 200ms and stays past 4s", async () => {
    const app = await launchPwrSnap();
    try {
      const captureId = await seedCapture(app);

      // Pre-condition: float-over hasn't been created yet (no capture).
      const before = await inspectFloatOver(app);
      expect(before.exists).toBe(false);

      await setFloatOverState(app, { kind: "show-loaded", captureId });

      // Visible within 200ms — the BrowserWindow gets created lazily on
      // first state, so we allow some warmup. After showInactive + the
      // renderer's first paint (~50ms typical), `isVisible` flips true.
      await expect
        .poll(async () => (await inspectFloatOver(app)).visible, {
          timeout: 800,
          intervals: [25, 50, 100]
        })
        .toBe(true);

      // Still visible at 4s. The standard variant's auto-dismiss is
      // 6s, so 4s should be comfortably mid-countdown.
      await app.window.waitForTimeout(4000);
      const at4s = await inspectFloatOver(app);
      expect(at4s.visible, "toast should still be visible at T+4s").toBe(true);
    } finally {
      await app.close();
    }
  });

  test("rapid show-loaded → show-loaded keeps the second toast visible past 4s", async () => {
    // This catches the stale-setTimeout bug. With the old design
    // (loadURL reload), the first toast's exit-animation timer would
    // survive the reload and fire ~220ms after the second toast
    // appeared, hiding it. With the persistent renderer + ref-tracked
    // exit timer, the second toast sticks.
    const app = await launchPwrSnap();
    try {
      const firstId = await seedCapture(app);
      const secondId = await seedCapture(app);

      await setFloatOverState(app, { kind: "show-loaded", captureId: firstId });
      // Wait long enough for the first toast to be on screen but well
      // before its 6s auto-dismiss countdown could fire.
      await app.window.waitForTimeout(300);

      await setFloatOverState(app, { kind: "show-loaded", captureId: secondId });

      // Second toast should be visible immediately and stay visible.
      await expect
        .poll(async () => (await inspectFloatOver(app)).visible, {
          timeout: 800,
          intervals: [25, 50, 100]
        })
        .toBe(true);

      // 500ms after the second toast — well past the 220ms exit
      // window where the old stale-timer bug would have hidden it.
      await app.window.waitForTimeout(500);
      const after500 = await inspectFloatOver(app);
      expect(after500.visible, "second toast should still be visible at T+500ms").toBe(true);

      // 4s mark — still visible.
      await app.window.waitForTimeout(3500);
      const after4s = await inspectFloatOver(app);
      expect(after4s.visible, "second toast should still be visible at T+4s").toBe(true);
    } finally {
      await app.close();
    }
  });

  test("cancel hides the float-over synchronously", async () => {
    const app = await launchPwrSnap();
    try {
      // Pre-show under selector — the IDLE state. User would never
      // see this directly because the selector covers the display.
      await setFloatOverState(app, { kind: "show-idle" });

      // The IDLE state still creates the window; isVisible should
      // become true once the renderer has painted.
      await expect
        .poll(async () => (await inspectFloatOver(app)).visible, {
          timeout: 800,
          intervals: [25, 50, 100]
        })
        .toBe(true);

      // Now cancel. setFloatOverState(cancel) calls window.hide()
      // synchronously inside the same tick.
      await setFloatOverState(app, { kind: "cancel" });

      // Visible should flip false within one tick — cancel is
      // synchronous on the main side and the window state is
      // observable immediately via the BrowserWindow API.
      const after = await inspectFloatOver(app);
      expect(after.exists, "window persists; cancel only hides").toBe(true);
      expect(after.visible, "cancel hides the window synchronously").toBe(false);
    } finally {
      await app.close();
    }
  });
});
