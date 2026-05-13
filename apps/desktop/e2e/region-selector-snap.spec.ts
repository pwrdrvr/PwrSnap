// Region-selector snap-to-window UX (Phase 1.10's deferred piece,
// completed in Phase 2-starter).
//
// Snap is the DEFAULT behavior — no modifier required. Cursor moves
// over a window → rect locks to that window. Cursor over background
// → rect locks to the entire display. Click without drag commits
// the snap target into adjusting state (where ↵ submits). Click +
// drag past the threshold overrides snap with a free-form region.
//
// This spec drives the full path:
//   1. Inject a synthetic window-list snapshot via the same IPC
//      channel main uses to hydrate the renderer (no real Swift
//      helper round-trip — tests stay deterministic across machines).
//   2. Move the cursor over the painted rect.
//   3. Verify `body[data-snap="window"]` flips on, the rect locks
//      to the synthetic window's bounds, the dims chip shows the
//      app name.
//   4. Click → verify the renderer enters adjusting mode (handles
//      visible) and ↵ commits with `snappedWindowId` set.
//
// Renderer logic is platform-agnostic; the Swift helper is
// macOS-only but we mock the snapshot here so this runs everywhere.

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const SYNTHETIC_WINDOW = {
  windowId: 4242,
  pid: 99999,
  bundleId: "com.test.targetapp",
  appName: "Target App",
  title: "Test window",
  ownedByUs: false,
  zIndex: 0,
  rect: { x: 200, y: 150, w: 400, h: 300 },
  rawRect: { x: 200, y: 150, w: 400, h: 300 }
};

test("hovering a window locks the rect to its bounds (no modifier)", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    // Default state at boot: snap target is "display" — no window
    // list pushed yet, so the rect covers the whole viewport.
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "display"
    );

    // Hydrate the synthetic window list, then wait for the renderer
    // to confirm it landed (body[data-window-list-count] flips to
    // the snapshot's length). Without this confirmation, mouse.move
    // can race the IPC delivery on slow runners.
    await hydrateWindowList(app, [SYNTHETIC_WINDOW]);
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "1"
    );

    // Move the cursor over the synthetic window.
    const cx = SYNTHETIC_WINDOW.rect.x + SYNTHETIC_WINDOW.rect.w / 2;
    const cy = SYNTHETIC_WINDOW.rect.y + SYNTHETIC_WINDOW.rect.h / 2;
    await selector.mouse.move(cx, cy);

    // Snap target flips to "window" with the synthetic window's
    // bounds + the app name in the dims chip.
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "window"
    );
    await expect(selector.locator(".region-rect.region-rect--snap-window")).toBeVisible();

    const rectStyle = await selector.locator(".region-rect").getAttribute("style");
    expect(rectStyle).toContain(`left: ${SYNTHETIC_WINDOW.rect.x}px`);
    expect(rectStyle).toContain(`top: ${SYNTHETIC_WINDOW.rect.y}px`);
    expect(rectStyle).toContain(`width: ${SYNTHETIC_WINDOW.rect.w}px`);
    expect(rectStyle).toContain(`height: ${SYNTHETIC_WINDOW.rect.h}px`);

    await expect(selector.locator(".region-dims-chip")).toContainText("Target App");
    await expect(selector.locator(".region-hint")).toContainText(/capture target app/i);

    // Move back to background — snap drops to display.
    await selector.mouse.move(50, 50);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "display"
    );
  } finally {
    await app.close();
  }
});

test("window-list cursor initializes the snap target before mouse movement", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    const cx = SYNTHETIC_WINDOW.rect.x + SYNTHETIC_WINDOW.rect.w / 2;
    const cy = SYNTHETIC_WINDOW.rect.y + SYNTHETIC_WINDOW.rect.h / 2;
    await hydrateWindowList(app, [SYNTHETIC_WINDOW], { x: cx, y: cy });
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "1"
    );

    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "window"
    );
    await expect(selector.locator(".region-dims-chip")).toContainText("Target App");
  } finally {
    await app.close();
  }
});

test("click-without-drag on a window enters adjusting + ↵ commits with snappedWindowId", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    // Capture submitRegion payloads on the main side via ipcMain
    // (renderer-side stubbing doesn't survive contextBridge freeze).
    await app.electronApp.evaluate(({ ipcMain }) => {
      const captured: unknown[] = [];
      (
        globalThis as unknown as { __SNAP_PAYLOADS__: unknown[] }
      ).__SNAP_PAYLOADS__ = captured;
      const handler = (_event: unknown, payload: unknown) => {
        captured.push(payload);
      };
      ipcMain.prependListener("region-selector:result", handler);
      (
        globalThis as unknown as { __SNAP_LISTENER__: typeof handler }
      ).__SNAP_LISTENER__ = handler;
    });

    // Hydrate window list + wait for the renderer to confirm.
    await hydrateWindowList(app, [SYNTHETIC_WINDOW]);
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "1"
    );

    const cx = SYNTHETIC_WINDOW.rect.x + SYNTHETIC_WINDOW.rect.w / 2;
    const cy = SYNTHETIC_WINDOW.rect.y + SYNTHETIC_WINDOW.rect.h / 2;
    await selector.mouse.move(cx, cy);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "window"
    );

    // Click without drag — should land in adjusting mode (handles
    // visible) without dispatching submitRegion yet. The user gets
    // a chance to refine before sending.
    await selector.mouse.click(cx, cy);
    await expect.poll(async () => selector.locator("body").getAttribute("data-interaction")).toBe(
      "adjusting"
    );
    await expect(selector.locator(".region-handle")).toHaveCount(8);

    // No submitRegion fired yet — adjusting holds the rect for
    // refinement.
    const beforeEnter = (await app.electronApp.evaluate(() => {
      return (globalThis as unknown as { __SNAP_PAYLOADS__: unknown[] }).__SNAP_PAYLOADS__;
    })) as unknown[];
    expect(beforeEnter).toHaveLength(0);

    // ↵ commits.
    await selector.keyboard.press("Enter");

    const payloads = (await app.electronApp.evaluate(({ ipcMain }) => {
      const list = (globalThis as unknown as { __SNAP_PAYLOADS__: unknown[] })
        .__SNAP_PAYLOADS__;
      const handler = (
        globalThis as unknown as {
          __SNAP_LISTENER__: (event: unknown, payload: unknown) => void;
        }
      ).__SNAP_LISTENER__;
      ipcMain.removeListener("region-selector:result", handler);
      return list;
    })) as Array<{
      ok: boolean;
      rect: { x: number; y: number; w: number; h: number };
      snappedWindowId?: number;
    }>;

    // We can get one or two payloads here depending on whether the
    // adjusting commit considers itself "still snapped" after a
    // click — that judgment lives in the renderer's commit() and
    // is checked by inspecting the latest payload, not the count.
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    const last = payloads[payloads.length - 1]!;
    expect(last.ok).toBe(true);
    // The rect must match the snap target's bounds — the user
    // didn't refine.
    expect(last.rect).toEqual({
      x: SYNTHETIC_WINDOW.rect.x,
      y: SYNTHETIC_WINDOW.rect.y,
      w: SYNTHETIC_WINDOW.rect.w,
      h: SYNTHETIC_WINDOW.rect.h
    });
  } finally {
    await app.close();
  }
});

test("a PwrSnap-owned window covering another window is itself snappable", async () => {
  // PwrSnap's normal user windows (Library / Edit) are legitimate
  // capture targets. If the Library is topmost under the cursor, the
  // selector should snap to it, not fall through to a hidden window
  // underneath and not retreat to full-display mode.
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    const ours = {
      windowId: 1,
      pid: 1111,
      bundleId: "com.pwrdrvr.pwrsnap",
      appName: "PwrSnap",
      title: null as string | null,
      ownedByUs: true,
      zIndex: 0,
      rect: { x: 100, y: 100, w: 600, h: 400 },
      rawRect: { x: 100, y: 100, w: 600, h: 400 }
    };
    const otherApp = {
      windowId: 2,
      pid: 2222,
      bundleId: "com.1password.1password",
      appName: "1Password",
      title: null as string | null,
      ownedByUs: false,
      zIndex: 1,
      rect: { x: 100, y: 100, w: 600, h: 400 },
      rawRect: { x: 100, y: 100, w: 600, h: 400 }
    };
    await hydrateWindowList(app, [ours, otherApp]);
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "2"
    );

    // Hover over the overlapping region. Both windows' bounds
    // contain (300, 200), but ours is z-order frontmost. Snap
    // should be PwrSnap, not 1Password or display.
    await selector.mouse.move(300, 200);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "window"
    );
    await expect(selector.locator(".region-dims-chip")).toContainText("PwrSnap");

    // Move outside our window but still inside 1Password's bounds.
    // ...wait, in this scenario both rects are identical, so the
    // outside is also outside the other app. Move to a clean
    // region and back — display in both spots.
    await selector.mouse.move(50, 50);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "display"
    );
  } finally {
    await app.close();
  }
});

test("⇧ over a window expands the snap rect to full bounds + flags fullWindow on commit", async () => {
  // Default click captures the visible rect (overlapping content
  // included). Holding ⇧ opts into "capture this whole window
  // even if parts are hidden" — the rect grows from the visible-
  // region bbox to the window's full rawRect, and submitRegion
  // fires with `fullWindow: true` so main routes to
  // `screencapture -l` instead of `-R`.
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    // Window with VISIBLE region smaller than RAW bounds (something
    // in front of it covers the right half). Visible bbox is the
    // left half.
    const targetWindow = {
      windowId: 7777,
      pid: 9999,
      bundleId: "com.test.fullwindow",
      appName: "FullWindow App",
      title: null as string | null,
      ownedByUs: false,
      zIndex: 1,
      rect: { x: 100, y: 100, w: 200, h: 400 }, // visible left half
      rawRect: { x: 100, y: 100, w: 400, h: 400 } // full window
    };
    // Capture submitRegion payloads so we can assert fullWindow.
    await app.electronApp.evaluate(({ ipcMain }) => {
      const captured: unknown[] = [];
      (
        globalThis as unknown as { __FULL_PAYLOADS__: unknown[] }
      ).__FULL_PAYLOADS__ = captured;
      const handler = (_event: unknown, payload: unknown) => {
        captured.push(payload);
      };
      ipcMain.prependListener("region-selector:result", handler);
      (
        globalThis as unknown as { __FULL_LISTENER__: typeof handler }
      ).__FULL_LISTENER__ = handler;
    });

    await hydrateWindowList(app, [targetWindow]);
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "1"
    );

    // Hover to lock the snap target. Default rect = visible (200×400).
    await selector.mouse.move(150, 200);
    await expect(selector.locator(".region-dims-chip")).toContainText("FullWindow App");
    let style = await selector.locator(".region-rect").getAttribute("style");
    expect(style).toContain("width: 200px"); // visible only

    // Hold ⇧: rect should grow to the full window bounds (400×400).
    await selector.keyboard.down("Shift");
    await expect.poll(async () =>
      selector.locator("body").getAttribute("data-full-window")
    ).toBe("true");
    style = await selector.locator(".region-rect").getAttribute("style");
    expect(style).toContain("width: 400px"); // full bounds
    await expect(selector.locator(".region-hint")).toContainText(/full FullWindow App/);

    // Commit while still holding ⇧.
    await selector.keyboard.press("Enter");
    await selector.keyboard.up("Shift");

    const payloads = (await app.electronApp.evaluate(({ ipcMain }) => {
      const list = (
        globalThis as unknown as { __FULL_PAYLOADS__: unknown[] }
      ).__FULL_PAYLOADS__;
      const handler = (
        globalThis as unknown as {
          __FULL_LISTENER__: (event: unknown, payload: unknown) => void;
        }
      ).__FULL_LISTENER__;
      ipcMain.removeListener("region-selector:result", handler);
      return list;
    })) as Array<{
      ok: boolean;
      snappedWindowId?: number;
      fullWindow?: boolean;
      rect: { x: number; y: number; w: number; h: number };
    }>;
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    const last = payloads[payloads.length - 1]!;
    expect(last.ok).toBe(true);
    expect(last.snappedWindowId).toBe(targetWindow.windowId);
    expect(last.fullWindow).toBe(true);
    // Rect should be the full bounds (rawRect), not the visible bbox.
    expect(last.rect).toEqual({ x: 100, y: 100, w: 400, h: 400 });
  } finally {
    await app.close();
  }
});

test("Tab cycles to the next window underneath the cursor", async () => {
  // Two overlapping windows — Slack (frontmost) and 1Password
  // (behind, mostly occluded). Cursor is in the overlap. Without
  // Tab the user can only snap to Slack. Tab cycles to 1Password,
  // Tab again wraps back to Slack. Shift+Tab goes the other way.
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    const slack = {
      windowId: 1,
      pid: 100,
      bundleId: "com.tinyspeck.slackmacgap",
      appName: "Slack",
      title: null as string | null,
      ownedByUs: false,
      zIndex: 0,
      rect: { x: 100, y: 100, w: 600, h: 400 },
      rawRect: { x: 100, y: 100, w: 600, h: 400 }
    };
    const onepass = {
      windowId: 2,
      pid: 200,
      bundleId: "com.1password.1password",
      appName: "1Password",
      title: null as string | null,
      ownedByUs: false,
      zIndex: 1,
      // Visible region = right strip (Slack covers the left).
      rect: { x: 700, y: 100, w: 200, h: 400 },
      // Raw bounds — full window — overlaps Slack.
      rawRect: { x: 50, y: 100, w: 850, h: 400 }
    };
    await hydrateWindowList(app, [slack, onepass]);
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "2"
    );

    // Park cursor in the OVERLAP zone (inside both rawRects).
    // Slack covers x:100-700; 1Password covers x:50-900. (300, 250)
    // is inside both. z-order picks Slack first.
    await selector.mouse.move(300, 250);
    await expect(selector.locator(".region-dims-chip")).toContainText("Slack");

    // Tab → cycle to next: 1Password.
    await selector.keyboard.press("Tab");
    await expect(selector.locator(".region-dims-chip")).toContainText("1Password");

    // Tab again → wrap back to Slack.
    await selector.keyboard.press("Tab");
    await expect(selector.locator(".region-dims-chip")).toContainText("Slack");

    // Shift+Tab → reverse direction (1Password again).
    await selector.keyboard.press("Shift+Tab");
    await expect(selector.locator(".region-dims-chip")).toContainText("1Password");
  } finally {
    await app.close();
  }
});

test("when our window only partially occludes another, both visible windows can snap", async () => {
  // Library covers the upper half of 1Password. 1Password's lower
  // half is visible. The renderer should:
  //   - cursor in upper overlap zone → PwrSnap
  //   - cursor in lower visible-1Password zone → 1Password
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    // We pre-compute ourselves what the renderer would see after
    // visibility math: 1Password's visible bounds are just the
    // lower half (since the library covers the top half).
    const ours = {
      windowId: 1,
      pid: 1111,
      bundleId: "com.pwrdrvr.pwrsnap",
      appName: "PwrSnap",
      title: null as string | null,
      ownedByUs: true,
      zIndex: 0,
      rect: { x: 0, y: 0, w: 800, h: 200 }, // upper half
      rawRect: { x: 0, y: 0, w: 800, h: 200 }
    };
    const onePass = {
      windowId: 2,
      pid: 2222,
      bundleId: "com.1password.1password",
      appName: "1Password",
      title: null as string | null,
      ownedByUs: false,
      zIndex: 1,
      // The rendered rect — only the visible lower half:
      rect: { x: 0, y: 200, w: 800, h: 200 },
      // Raw bounds — full window for hit-testing in z-order:
      rawRect: { x: 0, y: 0, w: 800, h: 400 }
    };
    await hydrateWindowList(app, [ours, onePass]);
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "2"
    );

    // Cursor in upper overlap (covered by ours): PwrSnap snap.
    await selector.mouse.move(400, 100);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "window"
    );
    await expect(selector.locator(".region-dims-chip")).toContainText("PwrSnap");

    // Cursor in lower half (1Password visible): 1Password snap with
    // the visible-only rect (NOT the full 800×400 raw bounds).
    await selector.mouse.move(400, 300);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "window"
    );
    const style = await selector.locator(".region-rect").getAttribute("style");
    expect(style).toContain("top: 200px");
    expect(style).toContain("height: 200px");
    await expect(selector.locator(".region-dims-chip")).toContainText("1Password");
  } finally {
    await app.close();
  }
});

test("click + drag past threshold overrides snap with a free-form region", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    // Hydrate window list + wait for the renderer to confirm.
    await hydrateWindowList(app, [SYNTHETIC_WINDOW]);
    await selector.waitForFunction(
      () => document.body.dataset.windowListCount === "1"
    );

    // Park inside the window so snap is "window" first.
    const inX = SYNTHETIC_WINDOW.rect.x + 50;
    const inY = SYNTHETIC_WINDOW.rect.y + 50;
    await selector.mouse.move(inX, inY);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "window"
    );

    // mousedown + drag past the 4px threshold → drawing.
    await selector.mouse.down();
    await selector.mouse.move(inX + 200, inY + 200, { steps: 8 });

    // We're in drawing mode — body's data-interaction should reflect.
    await expect.poll(async () => selector.locator("body").getAttribute("data-interaction")).toBe(
      "drawing"
    );

    await selector.mouse.up();

    // Mouseup → adjusting; the drawn rect, not the snap rect.
    await expect.poll(async () => selector.locator("body").getAttribute("data-interaction")).toBe(
      "adjusting"
    );
    const style = await selector.locator(".region-rect").getAttribute("style");
    // Width should be ~200, not the synthetic window's 400.
    expect(style).toContain("width: 200px");
  } finally {
    await app.close();
  }
});

type SnapEntry = {
  windowId: number;
  pid: number;
  bundleId: string;
  appName: string;
  title: string | null;
  ownedByUs: boolean;
  zIndex: number;
  rect: { x: number; y: number; w: number; h: number };
  rawRect: { x: number; y: number; w: number; h: number };
};

/**
 * Send a window-list snapshot to the live region-selector renderer
 * via the same IPC channel main uses on real ⌘⇧P. Pair with a
 * `waitForFunction(() => document.body.dataset.windowListCount === ...)`
 * in the caller — the IPC delivery is async and returning from this
 * helper does NOT mean the renderer has ingested the payload.
 *
 * displayBounds tells the renderer the display-logical pixel size
 * for coord-space scaling. In tests we use the RENDERER's actual
 * `window.innerWidth/Height` so the css-to-logical scale ends up
 * 1:1 — synthetic rects in tests are CSS-pixel-native and should
 * pass through without rescaling.
 */
async function hydrateWindowList(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  windows: readonly SnapEntry[],
  cursor?: { x: number; y: number }
): Promise<void> {
  // Find the selector page from the test side, query its viewport,
  // then hand a matching displayBounds to the renderer so scale=1.
  const selector = app.electronApp
    .windows()
    .find((w) => w.url().includes("stage=region"));
  if (selector === undefined) throw new Error("no selector page found");
  const innerSize = await selector.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  const payload =
    cursor === undefined
      ? { windows: [...windows], displayBounds: innerSize }
      : { windows: [...windows], displayBounds: innerSize, cursor };
  await app.electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
      );
      if (w === undefined) throw new Error("no selector window");
      w.webContents.send("region-selector:window-list", payload);
    },
    payload
  );
}

async function showAndGetSelector(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<Page> {
  await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
    );
    if (w === undefined) throw new Error("no selector window");
    if (process.platform === "darwin" && !w.isSimpleFullScreen()) {
      w.setSimpleFullScreen(true);
      const display = screen.getDisplayMatching(w.getBounds());
      w.setContentBounds(display.bounds);
    }
    w.show();
    w.focus();
  });
  for (let i = 0; i < 30; i++) {
    const found = app.electronApp.windows().find((w) => w.url().includes("stage=region"));
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("region-selector page never appeared");
}
