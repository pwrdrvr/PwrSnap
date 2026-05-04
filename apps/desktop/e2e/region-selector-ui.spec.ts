// Region-selector renderer UX spec — drives the actual selector
// BrowserWindow without touching the OS screencapture path. This
// covers the Phase 1.10 state machine: drawing → adjusting, handle
// presence, the move-cursor interior, the keyboard hint copy.
//
// Runs on every platform — the selector is pure DOM. Real ⌘⇧P →
// screencapture round-trips live in region-capture.spec.ts under the
// macOS-only opt-in gate.

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

/** Find the pre-warmed region-selector BrowserWindow by URL hash. */
async function showAndGetRegionSelector(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<Page> {
  // Force-show the pre-warmed selector for the primary display so it
  // becomes interactive (BrowserWindow.show()).
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const selector = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
    );
    if (selector === undefined) throw new Error("no region-selector window found");
    selector.show();
    selector.focus();
  });
  // Wait until Playwright sees a window with the region hash — the
  // selector window was created at boot but only becomes a Page after
  // it loads its URL; the .show() above guarantees it has by now.
  for (let i = 0; i < 30; i++) {
    const selector = app.electronApp
      .windows()
      .find((w) => w.url().includes("stage=region"));
    if (selector !== undefined) return selector;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("region-selector page did not appear in Playwright window list");
}

test("idle selector starts in snap mode with display target by default", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetRegionSelector(app);
    // Snap mode is the default — no rect-null state any more. With
    // no window list yet (or none under the cursor), the snap target
    // is "display" and the rect covers the whole viewport.
    await expect.poll(async () => selector.locator("body").getAttribute("data-snap")).toBe(
      "display"
    );
    await expect(selector.locator(".region-rect")).toBeVisible();
    await expect(selector.locator(".region-rect")).toHaveClass(/region-rect--snap-display/);
    // Hint contract: snap mode tells the user what `click` does
    // (commits the snap target) and what `drag` does (free region).
    await expect(selector.locator(".region-hint")).toContainText(/capture/i);
    await expect(selector.locator(".region-hint")).toContainText(/region/i);
    await expect(selector.locator(".region-hint")).toContainText(/esc.*cancel/i);
  } finally {
    await app.close();
  }
});

test("dragging on the canvas creates a rect with 8 handles", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetRegionSelector(app);
    const root = selector.locator(".region-root");
    await expect(root).toBeVisible();

    const box = await root.boundingBox();
    if (box === null) throw new Error("region-root has no bounding box");

    // Drag a comfortably-sized rect in the middle of the window.
    const startX = box.x + 200;
    const startY = box.y + 200;
    const endX = box.x + 500;
    const endY = box.y + 400;
    await selector.mouse.move(startX, startY);
    await selector.mouse.down();
    await selector.mouse.move(endX, endY, { steps: 10 });
    await selector.mouse.up();

    // After mouseup the state machine settles into "adjusting" — the
    // rect persists with handles + interior + dims chip.
    await expect(selector.locator(".region-rect")).toBeVisible();
    await expect(selector.locator(".region-rect-interior")).toBeVisible();
    await expect(selector.locator(".region-handle")).toHaveCount(8);
    await expect(selector.locator(".region-dims-chip")).toBeVisible();
    await expect(selector.locator(".region-dims-chip")).toContainText(/300/); // width
    await expect(selector.locator(".region-dims-chip")).toContainText(/200/); // height

    // And the hint flips to the post-drag affordances.
    await expect(selector.locator(".region-hint")).toContainText(/commit/i);
    await expect(selector.locator(".region-hint")).toContainText(/nudge/i);
  } finally {
    await app.close();
  }
});

test("Escape from adjusting drops back to snap mode", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetRegionSelector(app);
    const root = selector.locator(".region-root");
    const box = await root.boundingBox();
    if (box === null) throw new Error("region-root has no bounding box");

    // Draw a rect (drag past threshold) so we land in adjusting.
    await selector.mouse.move(box.x + 100, box.y + 100);
    await selector.mouse.down();
    await selector.mouse.move(box.x + 300, box.y + 300, { steps: 5 });
    await selector.mouse.up();

    await expect(selector.locator(".region-rect.region-rect--adjustable")).toBeVisible();

    // Esc cancels — renderer fires submitRegion(ok:false) and resets
    // back to snap mode. The rect persists (now full-display snap)
    // so the next interaction has something to bind to. Handles go
    // away because we're no longer adjusting.
    await selector.keyboard.press("Escape");
    await expect.poll(async () => selector.locator("body").getAttribute("data-interaction")).toBe(
      "snap"
    );
    await expect(selector.locator(".region-handle")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("arrow keys nudge the adjustable rect by 1px (10 with shift)", async () => {
  const app = await launchPwrSnap();
  try {
    const selector = await showAndGetRegionSelector(app);
    const root = selector.locator(".region-root");
    const box = await root.boundingBox();
    if (box === null) throw new Error("region-root has no bounding box");
    await selector.mouse.move(box.x + 200, box.y + 200);
    await selector.mouse.down();
    await selector.mouse.move(box.x + 400, box.y + 350, { steps: 5 });
    await selector.mouse.up();

    const beforeStyle = await selector.locator(".region-rect").getAttribute("style");
    expect(beforeStyle).toContain("left:");
    expect(beforeStyle).toContain("top:");

    // Read the left/top values from the inline style so we can assert
    // a precise +1 / +10 delta.
    const before = parseRectStyle(beforeStyle);

    await selector.keyboard.press("ArrowRight");
    await selector.keyboard.press("ArrowDown");
    const afterArrow = parseRectStyle(
      await selector.locator(".region-rect").getAttribute("style")
    );
    expect(afterArrow.left).toBe(before.left + 1);
    expect(afterArrow.top).toBe(before.top + 1);

    await selector.keyboard.press("Shift+ArrowRight");
    await selector.keyboard.press("Shift+ArrowDown");
    const afterShift = parseRectStyle(
      await selector.locator(".region-rect").getAttribute("style")
    );
    expect(afterShift.left).toBe(afterArrow.left + 10);
    expect(afterShift.top).toBe(afterArrow.top + 10);
  } finally {
    await app.close();
  }
});

function parseRectStyle(style: string | null): { left: number; top: number } {
  if (style === null) throw new Error("rect has no inline style");
  const left = /left:\s*(-?\d+(?:\.\d+)?)px/.exec(style)?.[1];
  const top = /top:\s*(-?\d+(?:\.\d+)?)px/.exec(style)?.[1];
  if (left === undefined || top === undefined) {
    throw new Error(`could not parse left/top from style: ${style}`);
  }
  return { left: Number.parseFloat(left), top: Number.parseFloat(top) };
}
