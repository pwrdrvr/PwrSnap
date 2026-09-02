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

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";
import { hideTray, inspectTrayWindow, showTray } from "./fixtures/tray";

const isMac = process.platform === "darwin";

test.describe("tray popover instant dismiss", () => {
  test.skip(
    !isMac,
    "the NSPanel fade-out this guards is macOS-only; other platforms never touch opacity"
  );

  // One app instance: an Electron cold start costs seconds on the macOS
  // runner, and the re-show half can't fail independently of the dismiss
  // half anyway — it replays the same setup.
  test("dismiss leaves nothing fading, and re-show restores full opacity", async () => {
    const app = await launchPwrSnap();
    try {
      // `showTray` returns the state read in the same round-trip that
      // confirmed visibility — asserting on a fresh read here would race
      // the blur-dismiss debounce it just outwaited.
      const shown = await showTray(app);
      expect(shown.exists).toBe(true);
      expect(shown.visible).toBe(true);
      expect(shown.opacity).toBe(1);

      await hideTray(app);

      // Read back IMMEDIATELY — no settle. A fading panel would still be
      // painting here, and alpha 0 is the proof it is not. No retry
      // needed: nothing re-shows the popover behind our back.
      const hidden = await inspectTrayWindow(app);
      expect(hidden.visible).toBe(false);
      expect(hidden.opacity).toBe(0);

      // Without the restore the popover comes back as a fully
      // transparent window that still takes clicks — worse than the bug.
      const reshown = await showTray(app);
      expect(reshown.visible).toBe(true);
      expect(reshown.opacity).toBe(1);
    } finally {
      await app.close();
    }
  });
});
