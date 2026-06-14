// Tray popover sizing spec — guards the cluster of bugs PR #4 fixed:
//
//   1. The tray BrowserWindow's contentSize must match the renderer's
//      natural content height. We measure an `inline-block` wrapper
//      OUTSIDE the styled `.ps-tray` container (the styled element
//      has `overflow: hidden`, which under nested-overflow conditions
//      makes both `getBoundingClientRect` and `scrollHeight` return
//      the clipped extent rather than the natural content). The
//      wrapper sits outside that clipping chain and reports the
//      unconstrained height.
//
//   2. The renderer measures CSS pixels (post-zoom); main's
//      `setContentSize` takes DIP. When the session zoomFactor is
//      not 1.0, those units diverge — main multiplies by zoomFactor
//      to convert. Without that conversion, a Cmd-+'d session leaves
//      the tray clipped because we'd post 600 DIP when the content
//      genuinely needs 600 × 1.32 ≈ 792 DIP.
//
//   3. Opening the tray must NOT mutate the session zoomFactor. An
//      earlier attempt called `setZoomFactor(1)` on the tray's
//      webContents to "lock" zoom, but Chromium's HostZoomMap stores
//      zoom per-origin so that call propagated to the library window
//      (same dev-server / file:// origin) and reset its zoom too.
//      The fix was to leave zoom alone and convert units in main.
//
// All three are easy to break invisibly — the tray "looks fine" on
// the dev machine where it was tuned and silently mis-fits anywhere
// else. These specs lock the units and the no-side-effect behavior.
//
// Why we drive the tray via a test bridge helper instead of clicking
// a tray icon: in E2E mode the bootstrap skips `installTray()` (no
// NSStatusItem in headless tests), so we expose `showTrayPopoverForE2E`
// which wires the same resize channel + creates the same BrowserWindow
// the production click handler does — only the icon is bypassed.

import { expect, test } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

/**
 * Inspect the tray BrowserWindow. Returns null when the popover
 * hasn't been created yet. `contentSize` is in DIP (Electron's unit
 * for setContentSize); `wrapperCssHeight` is what the renderer's
 * `getBoundingClientRect()` reads on the inline-block wrapper, in
 * CSS pixels (post-zoom). The two are related by the session's
 * `zoomFactor`: contentSize ≈ ceil(wrapperCssHeight × zoomFactor).
 */
async function inspectTray(app: LaunchedApp): Promise<{
  exists: boolean;
  visible: boolean;
  contentSize: { width: number; height: number } | null;
  zoomFactor: number | null;
  wrapperCssHeight: number | null;
}> {
  return await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      !w.isDestroyed() && w.webContents.getURL().includes("stage=tray")
    );
    if (win === undefined) {
      return {
        exists: false,
        visible: false,
        contentSize: null,
        zoomFactor: null,
        wrapperCssHeight: null
      };
    }
    const [w, h] = win.getContentSize();
    let wrapperCssHeight: number | null = null;
    try {
      wrapperCssHeight = (await win.webContents.executeJavaScript(
        // The tray's outer measure target — the renderer-side wrapper
        // we attach `containerRef` to in TrayMenu.tsx. Selector is
        // brittle by design: if the JSX shape changes, the spec
        // should fail and force the implementer to update both.
        `(() => {
           const el = document.querySelector('#root > div');
           if (!el) return null;
           return el.getBoundingClientRect().height;
         })()`,
        true
      )) as number | null;
    } catch {
      wrapperCssHeight = null;
    }
    return {
      exists: true,
      visible: win.isVisible(),
      contentSize: { width: w, height: h },
      zoomFactor: win.webContents.zoomFactor,
      wrapperCssHeight
    };
  });
}

/** Open the tray popover via the E2E bridge. */
async function showTray(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(async () => {
    const bridge = (
      globalThis as unknown as { __PWRSNAP_TEST__: { showTrayPopover: () => void } }
    ).__PWRSNAP_TEST__;
    bridge.showTrayPopover();
  });
}

/** Hide the tray popover via the E2E bridge. */
async function hideTray(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(async () => {
    const bridge = (
      globalThis as unknown as { __PWRSNAP_TEST__: { hideTrayPopover: () => void } }
    ).__PWRSNAP_TEST__;
    bridge.hideTrayPopover();
  });
}

/**
 * Set the zoomFactor on the tray window's webContents. Because zoom
 * is stored per-origin in the session HostZoomMap, this also affects
 * the library window — that's the realistic dynamic in production
 * (user Cmd-+'s in the library, opens the tray, tray inherits the
 * shared zoom). Tests that need to verify isolation set zoom on the
 * library directly via `setLibraryZoom`.
 */
async function setTrayZoom(app: LaunchedApp, factor: number): Promise<void> {
  await app.electronApp.evaluate(async ({ BrowserWindow }, target: number) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      !w.isDestroyed() && w.webContents.getURL().includes("stage=tray")
    );
    if (win === undefined) throw new Error("tray window not created");
    win.webContents.setZoomFactor(target);
  }, factor);
}

/** Set zoomFactor on the library (main) window's webContents. */
async function setLibraryZoom(app: LaunchedApp, factor: number): Promise<void> {
  await app.electronApp.evaluate(async ({ BrowserWindow }, target: number) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !/[#&?]stage=/.test(w.webContents.getURL())
    );
    if (win === undefined) throw new Error("library window not found");
    win.webContents.setZoomFactor(target);
  }, factor);
}

/** Read zoomFactor of the library (main) window's webContents. */
async function getLibraryZoom(app: LaunchedApp): Promise<number> {
  return await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !/[#&?]stage=/.test(w.webContents.getURL())
    );
    if (win === undefined) throw new Error("library window not found");
    return win.webContents.zoomFactor;
  });
}

/**
 * Wait until the tray's contentSize stops changing for `stableMs`
 * milliseconds. The renderer's measurement → IPC → setContentSize
 * round-trip takes a frame or two and can fire multiple times during
 * font swap-in or image decode; polling for a stable value keeps the
 * spec from racing the steady state.
 */
async function waitForStableSize(
  app: LaunchedApp,
  { stableMs = 300, timeoutMs = 5000 }: { stableMs?: number; timeoutMs?: number } = {}
): Promise<{ width: number; height: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: { width: number; height: number } | null = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const info = await inspectTray(app);
    if (info.contentSize !== null) {
      if (last !== null && info.contentSize.height === last.height && info.contentSize.width === last.width) {
        if (Date.now() - stableSince >= stableMs) {
          return info.contentSize;
        }
      } else {
        last = info.contentSize;
        stableSince = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `tray contentSize never stabilized within ${timeoutMs}ms; last=${JSON.stringify(last)}`
  );
}

test.describe("tray popover sizing", () => {
  test.skip(
    !isMac && process.platform !== "win32",
    "tray popover sizing runs on macOS + Windows (Linux/xvfb excluded)"
  );

  test("sizes to natural content height at default zoom", async () => {
    const app = await launchPwrSnap();
    try {
      // Pre-condition: no tray window yet.
      const before = await inspectTray(app);
      expect(before.exists).toBe(false);

      await showTray(app);
      await waitForStableSize(app);

      const info = await inspectTray(app);
      expect(info.exists).toBe(true);
      expect(info.visible).toBe(true);
      expect(info.contentSize).not.toBeNull();
      expect(info.zoomFactor).not.toBeNull();
      expect(info.wrapperCssHeight).not.toBeNull();

      // Sanity: contentSize lands inside main's clamp (200..880).
      expect(info.contentSize!.height).toBeGreaterThanOrEqual(200);
      expect(info.contentSize!.height).toBeLessThanOrEqual(880);
      // Width is fixed at TRAY_WIDTH = 440 in tray.ts.
      expect(info.contentSize!.width).toBe(440);

      // Default zoom is 1.0, so wrapper CSS height ≈ contentSize DIP.
      // Allow ±2 px for rounding (Math.ceil in main, sub-pixel layout).
      expect(info.zoomFactor).toBe(1);
      expect(info.contentSize!.height).toBeGreaterThanOrEqual(
        Math.floor(info.wrapperCssHeight!) - 1
      );
      expect(info.contentSize!.height).toBeLessThanOrEqual(
        Math.ceil(info.wrapperCssHeight!) + 1
      );
    } finally {
      await app.close();
    }
  });

  test("sizes correctly under non-1.0 zoom", async () => {
    // Three things this spec guards:
    //   • The CSS-px → DIP conversion (ceil(cssHeight × zoomFactor))
    //   • The remeasure-on-zoom-changed IPC plumbing (main →
    //     events:popover:remeasure → renderer → re-post)
    //   • The popover sizing recovers if zoom is non-1.0 from the
    //     start (e.g. user Cmd-+'d in the library before opening
    //     the tray)
    const app = await launchPwrSnap();
    try {
      await showTray(app);
      await waitForStableSize(app);

      const before = await inspectTray(app);
      expect(before.zoomFactor).toBe(1);

      // Bump zoom on the tray's webContents. HostZoomMap propagates
      // this to all webContents on the same origin, then fires
      // `zoom-changed` on each, which (per main/tray.ts) sends
      // `events:popover:remeasure` to the renderer, which re-posts
      // through the resize channel.
      const ZOOM = 1.5;
      const beforeHeight = before.contentSize!.height;
      await setTrayZoom(app, ZOOM);

      // setZoomFactor → zoom-changed → events:popover:remeasure →
      // renderer re-post → setContentSize spans several frames. On the
      // slower VS2026 runner image that round-trip can outlast
      // waitForStableSize's stability window, so a bare waitForStableSize()
      // returns the *pre-zoom* size — the flake. Gate on the contentSize
      // actually growing toward the zoomed value before settling; a height
      // that never grows fails here (a genuine remeasure-plumbing
      // regression) instead of passing through at the unzoomed value.
      await expect
        .poll(async () => (await inspectTray(app)).contentSize?.height ?? 0, {
          timeout: 8000,
          message: "tray contentSize never grew after zoom — remeasure round-trip didn't land"
        })
        .toBeGreaterThan(beforeHeight + 20);

      // contentSize should re-stabilize at a value matching the new
      // measurement × zoomFactor.
      await waitForStableSize(app);
      const after = await inspectTray(app);
      expect(after.zoomFactor).toBeCloseTo(ZOOM, 2);
      expect(after.wrapperCssHeight).not.toBeNull();

      // The math: contentSize height (DIP) ≈ ceil(wrapper CSS px × zoomFactor).
      // Allow ±2 DIP slack for rounding + sub-pixel layout — what we're
      // really asserting is "main applied the zoom conversion."
      // Without it, contentSize would equal wrapperCssHeight (the bug).
      const expectedDip = Math.ceil(after.wrapperCssHeight! * ZOOM);
      expect(after.contentSize!.height).toBeGreaterThanOrEqual(expectedDip - 2);
      expect(after.contentSize!.height).toBeLessThanOrEqual(expectedDip + 2);

      // Cross-check: the unzoomed value would be wrapperCssHeight
      // (no conversion). Verify we are NOT at that value — i.e., the
      // conversion is actually happening, not silently passing
      // through. Skipped when zoom is so close to 1 that the values
      // coincide; ZOOM=1.5 keeps them comfortably apart.
      expect(after.contentSize!.height).not.toBe(Math.ceil(after.wrapperCssHeight!));
    } finally {
      await app.close();
    }
  });

  test("opening the tray does not reset the library window's zoom", async () => {
    // Regression test for the "lock zoom on popovers" misadventure.
    // The previous attempt called `setZoomFactor(1)` on the tray's
    // webContents to defend against a stale Cmd-+ persisting across
    // dev restarts. But Chromium's HostZoomMap stores zoom per-origin,
    // so that call propagated to the library (same origin) and reset
    // its zoom every time the user opened the tray.
    //
    // The current implementation leaves session zoom alone and
    // converts CSS px → DIP in main. This spec asserts the side-
    // effect-free behavior: showing/hiding the tray must not mutate
    // the library's zoomFactor.
    const app = await launchPwrSnap();
    try {
      const TARGET_ZOOM = 1.32;
      await setLibraryZoom(app, TARGET_ZOOM);

      // Verify it took.
      const beforeOpen = await getLibraryZoom(app);
      expect(beforeOpen).toBeCloseTo(TARGET_ZOOM, 2);

      await showTray(app);
      await waitForStableSize(app);

      // After showing the tray, library zoom must be unchanged.
      const afterShow = await getLibraryZoom(app);
      expect(afterShow).toBeCloseTo(TARGET_ZOOM, 2);

      await hideTray(app);

      // After hiding too — the previous-previous attempt also reset
      // zoom on hide via a session-level call.
      const afterHide = await getLibraryZoom(app);
      expect(afterHide).toBeCloseTo(TARGET_ZOOM, 2);
    } finally {
      await app.close();
    }
  });
});
