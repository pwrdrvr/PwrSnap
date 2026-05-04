// Verifies the macOS menu-bar-overlay behavior on the region selector.
//
// macOS won't let an ordinary always-on-top window draw over the menu
// bar — even at `screen-saver` level. Our fix calls
// `setSimpleFullScreen(true)` immediately after `win.show()`, which
// flips the window into a borderless overlay that does cover the menu
// bar (the same trick CleanShot / Shottr / SnagIt use).
//
// This spec verifies the platform contract directly: drive the same
// `show()` + `setSimpleFullScreen(true)` sequence our helpers run, and
// assert the window's live bounds + the renderer's reported viewport
// reach all the way to the top of the display (y=0, height=display
// height) — the only way that's true is if the menu bar is being
// covered.
//
// We don't drive the full `capture:interactive` → pickRegion path here
// because Playwright's Electron driver tends to race
// `display-metrics-changed` fired by the simple-fullscreen transition
// against the main window's load lifecycle. Driving the API directly
// makes the assertion deterministic.
//
// macOS-only — `setSimpleFullScreen` is a no-op on Linux / Windows.

import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

test.describe("region selector menu-bar overlay (macOS)", () => {
  test.skip(!isMac, "setSimpleFullScreen is macOS-only");

  test("simple-fullscreen extends the window past the menu bar", async () => {
    const app = await launchPwrSnap();
    try {
      // Start state: hidden, not in overlay mode, bounds match display
      // bounds (we constructed it that way), but the OS hasn't yet
      // committed those bounds because the window is hidden.
      const before = await readSelectorState(app);
      expect(before).not.toBeNull();
      expect(before!.simpleFullScreen).toBe(false);
      expect(before!.visible).toBe(false);

      // Drive the same sequence pickRegion runs and capture both the
      // overlay state and the post-restore state in a single evaluate.
      // Splitting it into two evaluates wedges Playwright's IPC against
      // Cocoa's mid-transition simple-fullscreen state — the second
      // evaluate hangs until the test timeout. Doing it inline keeps
      // the round-trip outside Cocoa's transition window.
      //
      // Without setSimpleFullScreen, macOS clamps the window's y
      // position below the menu bar (~25-37px depending on display)
      // and reduces its visible height to match the workArea. With
      // setSimpleFullScreen(true), the window covers display.bounds
      // in full — y stays at the display's top and height matches
      // display.height.
      const probe = await app.electronApp.evaluate(async ({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
        );
        if (win === undefined) throw new Error("no selector window");
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

        win.show();
        win.setSimpleFullScreen(true);

        // Cocoa needs a frame to commit the simple-fullscreen
        // transition; reading bounds inside the same synchronous turn
        // can block. Yield to the event loop briefly.
        await new Promise((r) => setTimeout(r, 200));

        const overlay = {
          simpleFullScreen: win.isSimpleFullScreen(),
          visible: win.isVisible(),
          bounds: win.getBounds()
        };

        // Restore inside the same evaluate so we never leave Cocoa
        // mid-transition between IPC round-trips.
        win.setSimpleFullScreen(false);
        await new Promise((r) => setTimeout(r, 200));
        win.hide();
        const restored = {
          simpleFullScreen: win.isSimpleFullScreen(),
          visible: win.isVisible()
        };

        return {
          overlay,
          restored,
          displayBounds: display.bounds,
          workArea: display.workArea
        };
      });

      // The overlay covers the full display, including the menu bar
      // strip that the workArea excludes.
      expect(probe.overlay.simpleFullScreen).toBe(true);
      expect(probe.overlay.visible).toBe(true);
      expect(probe.overlay.bounds.y).toBe(probe.displayBounds.y);
      expect(probe.overlay.bounds.height).toBe(probe.displayBounds.height);

      // Sanity: this assertion is only meaningful on a display that
      // actually has a menu bar (workArea < displayBounds). Virtual
      // / headless displays sometimes report the two equal — flag it
      // so we know whether we're testing what we think.
      expect(probe.workArea.height).toBeLessThan(probe.displayBounds.height);

      // Restored state — pre-warm shape ready for the next ⌘⇧P.
      expect(probe.restored.simpleFullScreen).toBe(false);
      expect(probe.restored.visible).toBe(false);
    } finally {
      await app.close();
    }
  });
});

type SelectorState = {
  id: number;
  visible: boolean;
  simpleFullScreen: boolean;
};

async function readSelectorState(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<SelectorState | null> {
  return app.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=region")
    );
    if (win === undefined) return null;
    return {
      id: win.id,
      visible: win.isVisible(),
      simpleFullScreen: win.isSimpleFullScreen()
    };
  });
}
