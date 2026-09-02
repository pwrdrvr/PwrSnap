// The tray popover must leave the screen with NO fade — pinned against
// the real Electron/AppKit window, not a mock.
//
// The popover is a macOS `NSPanel` (`type: 'panel'` in createTrayWindow).
// AppKit resolves a panel's default `NSWindowAnimationBehaviorDefault` to
// `NSWindowAnimationBehaviorUtilityWindow`, so `[NSWindow orderOut:]` —
// what `BrowserWindow.hide()` calls — plays a ~0.2s fade-out rather than
// clearing the window on the next frame.
//
// That fade lands in the user's screenshots. A capture started from a
// tray button dismisses the popover and then waits a 50ms compositor
// flush before freezing the screen; 50ms into a 200ms fade the popover
// is still ~70% opaque, and the region/auto path CROPS THAT FROZEN
// SNAPSHOT — so a half-dissolved PwrSnap popover gets alpha-blended into
// the saved capture. Captures taken with the global hotkey (popover
// never open) come out clean, which is what made this look like a
// compositor problem rather than a window animation.
//
// The fix takes the panel to alpha 0 before ordering it out, and back to
// 1 before ordering it in. `getOpacity()` is the observable: after a
// dismiss it must read 0, which is the only way to know from outside
// that nothing is left painting itself into a screenshot. `isVisible()`
// cannot answer this — AppKit orders the window out at the START of the
// fade, so it reads false for the whole ~200ms the popover is still on
// screen.
//
// Unit-level companion (every dismiss path, both platforms):
// src/main/__tests__/tray-instant-hide.test.ts.

import { expect, type LaunchedApp, launchPwrSnap, test } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

async function inspectTray(app: LaunchedApp): Promise<{
  exists: boolean;
  visible: boolean;
  opacity: number | null;
}> {
  return await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=tray")
    );
    if (win === undefined) return { exists: false, visible: false, opacity: null };
    return { exists: true, visible: win.isVisible(), opacity: win.getOpacity() };
  });
}

/** Open the popover via the E2E bridge, retrying past ambient blur-
 *  dismiss churn (the popover auto-dismisses on blur with a 120ms
 *  debounce — real production behavior, and a loaded runner can blur it
 *  right after `showInactive()`). Same helper shape as tray-sizing. */
async function showTray(app: LaunchedApp): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await app.electronApp.evaluate(async () => {
      (
        globalThis as unknown as { __PWRSNAP_TEST__: { showTrayPopover: () => void } }
      ).__PWRSNAP_TEST__.showTrayPopover();
    });
    await new Promise((r) => setTimeout(r, 250));
    if ((await inspectTray(app)).visible) return;
  }
  throw new Error("tray popover would not stay visible after 4 show attempts");
}

/** Dismiss via the same entry point the capture flow uses
 *  (`hideTrayPopoverIfVisible`). */
async function hideTray(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(async () => {
    (
      globalThis as unknown as { __PWRSNAP_TEST__: { hideTrayPopover: () => void } }
    ).__PWRSNAP_TEST__.hideTrayPopover();
  });
}

test.describe("tray popover instant dismiss", () => {
  test.skip(
    !isMac,
    "the NSPanel fade-out this guards is macOS-only; other platforms never touch opacity"
  );

  test("capture-path dismiss leaves nothing fading on screen", async () => {
    const app = await launchPwrSnap();
    try {
      await showTray(app);

      const shown = await inspectTray(app);
      expect(shown.exists).toBe(true);
      expect(shown.visible).toBe(true);
      expect(shown.opacity).toBe(1);

      await hideTray(app);

      // Read back IMMEDIATELY — no settle. A fading panel would still be
      // painting here, and alpha 0 is the proof it is not.
      const hidden = await inspectTray(app);
      expect(hidden.visible).toBe(false);
      expect(hidden.opacity).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("re-showing restores the panel to full opacity", async () => {
    const app = await launchPwrSnap();
    try {
      await showTray(app);
      await hideTray(app);
      expect((await inspectTray(app)).opacity).toBe(0);

      await showTray(app);

      // Without the restore the popover comes back as a fully
      // transparent window that still takes clicks — worse than the bug.
      const reshown = await inspectTray(app);
      expect(reshown.visible).toBe(true);
      expect(reshown.opacity).toBe(1);
    } finally {
      await app.close();
    }
  });
});
