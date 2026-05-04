// Region-selector snap-to-window UX (the deferred Phase 1.10 piece).
//
// When the user holds ⇧ during region selection, the rect snaps to
// whichever on-screen window the cursor is over, with an accent
// highlight. Click commits — the captured region matches that
// window's exact bounds, and `captures.source_app_*` is filled in
// from the snapped windowId.
//
// This spec drives the full path:
//   1. Inject a synthetic window-list snapshot via the same IPC
//      channel main uses to hydrate the renderer (no real Swift
//      helper round-trip — the test fixture controls the data so
//      assertions are deterministic across machines).
//   2. Hold Shift, move the cursor over the painted rect.
//   3. Verify `body[data-snap="true"]` flips on, the rect locks to
//      the synthetic window's bounds, and the dims chip shows the
//      app name.
//   4. Click → verify the renderer commits with `snappedWindowId`
//      set on the submitRegion payload.
//
// macOS-only? No — the renderer logic is platform-agnostic. The
// Swift helper is macOS-only, but we mock the snapshot here so the
// spec runs everywhere.

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const SYNTHETIC_WINDOW = {
  windowId: 4242,
  bundleId: "com.test.targetapp",
  appName: "Target App",
  title: "Test window",
  rect: { x: 200, y: 150, w: 400, h: 300 }
};

test("⇧ hover locks the rect to the window under the cursor", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);

    // Hydrate the renderer's window-list cache via the same IPC
    // channel main uses. Sending it directly from the test side via
    // webContents.send keeps the test independent of the Swift helper.
    await app.electronApp.evaluate(
      ({ BrowserWindow }, payload) => {
        const w = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
        );
        if (w === undefined) throw new Error("no selector window");
        w.webContents.send("region-selector:window-list", payload);
      },
      { windows: [SYNTHETIC_WINDOW] }
    );

    // Give the IPC a beat to land in the renderer.
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    // No snap yet — body attribute starts at "false".
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe("false");

    // Hold Shift, then move the cursor over the synthetic window.
    // Use `selector.keyboard.down` so the modifier sticks.
    await selector.keyboard.down("Shift");
    const cx = SYNTHETIC_WINDOW.rect.x + SYNTHETIC_WINDOW.rect.w / 2;
    const cy = SYNTHETIC_WINDOW.rect.y + SYNTHETIC_WINDOW.rect.h / 2;
    await selector.mouse.move(cx, cy);

    // Snap state engaged: data attribute flips, rect appears at the
    // window's exact bounds, dims chip shows the app name.
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe("true");
    await expect(selector.locator(".region-rect")).toBeVisible();

    const rectStyle = await selector.locator(".region-rect").getAttribute("style");
    expect(rectStyle).toContain(`left: ${SYNTHETIC_WINDOW.rect.x}px`);
    expect(rectStyle).toContain(`top: ${SYNTHETIC_WINDOW.rect.y}px`);
    expect(rectStyle).toContain(`width: ${SYNTHETIC_WINDOW.rect.w}px`);
    expect(rectStyle).toContain(`height: ${SYNTHETIC_WINDOW.rect.h}px`);

    await expect(selector.locator(".region-dims-chip")).toContainText("Target App");
    await expect(selector.locator(".region-hint")).toContainText(/capture target app/i);

    // Releasing Shift drops the snap back to free-draw mode.
    await selector.keyboard.up("Shift");
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe("false");
  } finally {
    await app.close();
  }
});

test("⇧+click commits with snappedWindowId", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetSelector(app);

    // Wait for the renderer to mount its window-list subscription.
    // Without this, hydrate races useEffect and the snapshot is lost.
    await selector.waitForFunction(() => document.body.dataset.snap !== undefined);

    // Install a one-shot ipcMain listener on the result channel.
    // Stubbing the renderer-side `pwrsnapApi.submitRegion` doesn't
    // work — contextBridge deep-freezes exposed objects — so we
    // intercept on the main side instead. The listener stashes
    // captured payloads on a global; the test reads them back.
    await app.electronApp.evaluate(({ ipcMain }) => {
      const captured: unknown[] = [];
      (
        globalThis as unknown as { __SNAP_PAYLOADS__: unknown[] }
      ).__SNAP_PAYLOADS__ = captured;
      const handler = (_event: unknown, payload: unknown) => {
        captured.push(payload);
      };
      // Run our listener BEFORE the production handler so we observe
      // every payload regardless of pendingResolver state.
      ipcMain.prependListener("region-selector:result", handler);
      (
        globalThis as unknown as { __SNAP_LISTENER__: typeof handler }
      ).__SNAP_LISTENER__ = handler;
    });

    // Hydrate the window list.
    await app.electronApp.evaluate(
      ({ BrowserWindow }, payload) => {
        const w = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
        );
        if (w === undefined) throw new Error("no selector window");
        w.webContents.send("region-selector:window-list", payload);
      },
      { windows: [SYNTHETIC_WINDOW] }
    );

    await selector.keyboard.down("Shift");
    const cx = SYNTHETIC_WINDOW.rect.x + SYNTHETIC_WINDOW.rect.w / 2;
    const cy = SYNTHETIC_WINDOW.rect.y + SYNTHETIC_WINDOW.rect.h / 2;
    await selector.mouse.move(cx, cy);
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe("true");

    await selector.mouse.click(cx, cy);
    await selector.keyboard.up("Shift");

    // Pull the captured payload back from main.
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

    expect(payloads).toHaveLength(1);
    const payload = payloads[0]!;
    expect(payload.ok).toBe(true);
    expect(payload.snappedWindowId).toBe(SYNTHETIC_WINDOW.windowId);
    expect(payload.rect).toEqual({
      x: SYNTHETIC_WINDOW.rect.x,
      y: SYNTHETIC_WINDOW.rect.y,
      w: SYNTHETIC_WINDOW.rect.w,
      h: SYNTHETIC_WINDOW.rect.h
    });
  } finally {
    await app.close();
  }
});

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
