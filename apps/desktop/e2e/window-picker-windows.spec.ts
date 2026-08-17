// Windows native window-picker integration coverage.
//
// Unlike region-selector-snap.spec.ts, this does not inject a synthetic
// window-list payload. It creates normal top-level BrowserWindows at known DIP
// rectangles, starts the real capture:interactive flow, lets the bundled C++
// helper enumerate their HWNDs, and verifies the selector renders each native
// window at the same bounds Electron reports, within the small frame rounding
// difference between Electron and DWM. This pins the physical-pixel -> DIP
// conversion required when Windows display scaling is above 100%.

import { type Page } from "@playwright/test";
import { expect, launchPwrSnap, test } from "./fixtures/electron-app";
import {
  spawnTargetWindows,
  type TargetWindowSpec
} from "./fixtures/target-windows";

const WINDOWS_FRAME_TOLERANCE_CSS_PX = 3;

test.skip(process.platform !== "win32", "native HWND enumeration is Windows-only");

test("placed native windows are detected and highlighted at their Electron DIP bounds", async () => {
  const app = await launchPwrSnap();
  try {
    const display = await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
      // The Library is not part of this fixture scene. Hiding it also ensures
      // each probe point is covered by exactly one controlled target window.
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL().includes("stage=library")) win.hide();
      }
      const primary = screen.getPrimaryDisplay();
      return { bounds: primary.bounds, scaleFactor: primary.scaleFactor };
    });

    const specs: readonly TargetWindowSpec[] = [
      {
        id: "picker-coral",
        title: "PwrSnap picker fixture coral",
        color: "#ff5533",
        rect: {
          x: display.bounds.x + 70,
          y: display.bounds.y + 110,
          width: 260,
          height: 190
        },
        nativePickerTarget: true
      },
      {
        id: "picker-blue",
        title: "PwrSnap picker fixture blue",
        color: "#2277ff",
        rect: {
          x: display.bounds.x + 380,
          y: display.bounds.y + 330,
          width: 280,
          height: 200
        },
        nativePickerTarget: true
      }
    ];
    const targets = await spawnTargetWindows(app.electronApp, specs);
    try {
      const liveBounds = await app.electronApp.evaluate(() => {
        const store = (
          globalThis as unknown as {
            __PWRSNAP_TARGETS__?: Map<string, Electron.BrowserWindow>;
          }
        ).__PWRSNAP_TARGETS__;
        if (store === undefined) return [];
        return Array.from(store.entries()).map(([id, win]) => ({
          id,
          bounds: win.getBounds()
        }));
      });
      expect(liveBounds).toHaveLength(specs.length);

      // Start the actual command-bus flow without awaiting it here: it remains
      // pending until Escape cancels the picker near the end of the test.
      await app.electronApp.evaluate((_electron) => {
        const globalState = globalThis as unknown as {
          __PWRSNAP_TEST__?: {
            dispatch: (name: string, req: unknown) => Promise<unknown>;
          };
          __WINDOW_PICKER_DISPATCH__?: Promise<unknown>;
        };
        const bridge = globalState.__PWRSNAP_TEST__;
        if (bridge === undefined) throw new Error("PWRSNAP_E2E bridge missing");
        globalState.__WINDOW_PICKER_DISPATCH__ = bridge.dispatch(
          "capture:interactive",
          { mode: "window" }
        );
      });

      const selector = await waitForVisibleSelector(app);
      await selector.waitForFunction(
        (minimum) => Number(document.body.dataset.windowListCount ?? "0") >= minimum,
        specs.length
      );
      await expect(selector.locator("body")).toHaveAttribute("data-mode", "window");

      const rendererScale = await selector.evaluate(
        (displayWidth) => window.innerWidth / displayWidth,
        display.bounds.width
      );
      for (const spec of specs) {
        const live = liveBounds.find((candidate) => candidate.id === spec.id);
        expect(live, `live bounds for ${spec.id}`).toBeDefined();
        if (live === undefined) continue;

        const local = {
          x: live.bounds.x - display.bounds.x,
          y: live.bounds.y - display.bounds.y,
          width: live.bounds.width,
          height: live.bounds.height
        };
        await lockWindowSnap(
          selector,
          (local.x + local.width / 2) * rendererScale,
          (local.y + local.height / 2) * rendererScale
        );

        const rendered = await selector.locator(".region-rect").evaluate((element) => {
          const html = element as HTMLElement;
          return {
            x: Number.parseFloat(html.style.left),
            y: Number.parseFloat(html.style.top),
            width: Number.parseFloat(html.style.width),
            height: Number.parseFloat(html.style.height)
          };
        });
        expectRectNear(rendered, {
          x: local.x * rendererScale,
          y: local.y * rendererScale,
          width: local.width * rendererScale,
          height: local.height * rendererScale
        });
      }

      await selector.keyboard.press("Escape");
      await app.electronApp.evaluate(async (_electron) => {
        const pending = (
          globalThis as unknown as { __WINDOW_PICKER_DISPATCH__?: Promise<unknown> }
        ).__WINDOW_PICKER_DISPATCH__;
        await pending;
      });
    } finally {
      await targets.close();
    }
  } finally {
    await app.close();
  }
});

async function waitForVisibleSelector(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<Page> {
  await expect
    .poll(async () => {
      return app.electronApp.evaluate(({ BrowserWindow }) => {
        const selector = BrowserWindow.getAllWindows().find(
          (win) =>
            !win.isDestroyed() &&
            win.webContents.getURL().includes("stage=region")
        );
        return selector?.isVisible() ?? false;
      });
    })
    .toBe(true);

  await expect
    .poll(() => {
      return app.electronApp.windows().some((page) => page.url().includes("stage=region"));
    })
    .toBe(true);
  const selector = app.electronApp
    .windows()
    .find((page) => page.url().includes("stage=region"));
  if (selector === undefined) throw new Error("visible region selector page missing");
  return selector;
}

async function lockWindowSnap(selector: Page, x: number, y: number): Promise<void> {
  await expect
    .poll(async () => {
      await selector.mouse.move(x, y);
      return selector.locator("body").getAttribute("data-snap");
    })
    .toBe("window");
}

function expectRectNear(
  actual: Readonly<Record<"x" | "y" | "width" | "height", number>>,
  expected: Readonly<Record<"x" | "y" | "width" | "height", number>>
): void {
  // BrowserWindow.getBounds() describes Electron's window rectangle, while the
  // native picker intentionally uses DWMWA_EXTENDED_FRAME_BOUNDS (the visible
  // frame). Windows can round those rectangles apart by a couple of DIP/CSS
  // pixels, especially when a display is scaled above 100%.
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${key}: expected ${expected[key]}, received ${actual[key]}`
    ).toBeLessThanOrEqual(WINDOWS_FRAME_TOLERANCE_CSS_PX);
  }
}
