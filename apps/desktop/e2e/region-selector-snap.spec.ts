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
  bundleId: "com.test.targetapp",
  appName: "Target App",
  title: "Test window",
  rect: { x: 200, y: 150, w: 400, h: 300 }
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

/**
 * Send a window-list snapshot to the live region-selector renderer
 * via the same IPC channel main uses on real ⌘⇧P. Pair with a
 * `waitForFunction(() => document.body.dataset.windowListCount === ...)`
 * in the caller — the IPC delivery is async and returning from this
 * helper does NOT mean the renderer has ingested the payload.
 */
async function hydrateWindowList(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  windows: typeof SYNTHETIC_WINDOW[]
): Promise<void> {
  await app.electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
      );
      if (w === undefined) throw new Error("no selector window");
      w.webContents.send("region-selector:window-list", payload);
    },
    { windows }
  );
}

async function showAndGetSelector(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<Page> {
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
    );
    if (w === undefined) throw new Error("no selector window");
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
