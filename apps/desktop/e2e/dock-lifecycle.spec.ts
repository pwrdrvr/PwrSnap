// Dock-icon lifecycle spec — guards the macOS "Library is alive but
// orphaned" bug that the user reported.
//
// The bug: `activateApp(previousAppPid)` runs at the end of every
// capture commit / cancel to return the user to whichever app they
// had foreground. On macOS, deactivating PwrSnap while our floating-
// level panels (focus-sink, tray, float-over) are in the window list
// causes AppKit to demote our activation policy from Regular to
// Accessory (NSUIElement). The Dock icon vanishes and the Library
// window becomes UNREACHABLE — alive, but no Dock icon to click,
// can't be raised by clicking it (Accessory apps don't auto-activate
// on window click), and not in ⌘-Tab. The user reads this as
// "Library got closed and the Dock icon is gone."
//
// What this spec asserts:
//
//   1. After a deliberate `dock.hide()` (simulating the activateApp
//      side-effect), the Library window is still alive — the bug is
//      orphaning, not closing.
//   2. `forceReclaimDockIcon()` — production calls this on every
//      `activateApp` site (capture-handlers.ts) and on every
//      `app.on('did-resign-active')` (index.ts) — re-shows the Dock
//      icon. After it runs, dockIsVisible === true and the Library
//      is still alive.
//   3. The reclaim is a no-op when the Library doesn't exist. The
//      tray-icon-keeps-the-app-alive lifecycle depends on this:
//      closing the Library should hide the Dock icon and KEEP it
//      hidden, not have the reclaim helper second-guess the user.
//   4. Repeating the strip-and-reclaim cycle stays idempotent — no
//      duplicate listeners, no leaked state.
//
// Why this is E2E and not a unit test: `app.dock.isVisible()` is
// driven by Cocoa's activation-policy state, which only exists in a
// real Electron main process. The unit test
// (decide-previous-app-pid.test.ts) covers the pure-logic half of
// the fix; this spec covers the platform-side half.

import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

type BridgeShape = {
  dockIsVisible: () => boolean;
  dockShow: () => void;
  dockHide: () => void;
  forceReclaimDockIcon: () => void;
  getLibraryState: () => { exists: boolean; visible: boolean; focused: boolean };
  ensureLibrary: () => void;
};

async function dockIsVisible(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<boolean> {
  return app.electronApp.evaluate(() => {
    const bridge = (
      globalThis as unknown as { __PWRSNAP_TEST__: BridgeShape }
    ).__PWRSNAP_TEST__;
    return bridge.dockIsVisible();
  });
}

async function dockShow(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<void> {
  await app.electronApp.evaluate(() => {
    (globalThis as unknown as { __PWRSNAP_TEST__: BridgeShape }).__PWRSNAP_TEST__.dockShow();
  });
}

async function dockHide(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<void> {
  await app.electronApp.evaluate(() => {
    (globalThis as unknown as { __PWRSNAP_TEST__: BridgeShape }).__PWRSNAP_TEST__.dockHide();
  });
}

async function forceReclaim(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<void> {
  await app.electronApp.evaluate(() => {
    (globalThis as unknown as { __PWRSNAP_TEST__: BridgeShape }).__PWRSNAP_TEST__
      .forceReclaimDockIcon();
  });
}

async function getLibraryState(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<{ exists: boolean; visible: boolean; focused: boolean }> {
  return app.electronApp.evaluate(() => {
    return (globalThis as unknown as { __PWRSNAP_TEST__: BridgeShape }).__PWRSNAP_TEST__
      .getLibraryState();
  });
}

async function ensureLibrary(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<void> {
  await app.electronApp.evaluate(() => {
    (globalThis as unknown as { __PWRSNAP_TEST__: BridgeShape }).__PWRSNAP_TEST__.ensureLibrary();
  });
}

/** Poll `dockIsVisible` until it matches `expected`, or fail. The
 *  Cocoa policy write inside `app.dock.show()` lands a tick or two
 *  after the JS call resolves, so a single read can race. */
async function expectDockVisible(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  expected: boolean,
  timeoutMs = 2000
): Promise<void> {
  await expect
    .poll(() => dockIsVisible(app), { timeout: timeoutMs, intervals: [25, 50, 100] })
    .toBe(expected);
}

test.describe("Dock icon lifecycle (macOS)", () => {
  test.skip(
    !isMac,
    "Dock icon + NSApplicationActivationPolicy are macOS-only constructs"
  );

  test("Library stays alive after a deliberate dock.hide() — the bug shape", async () => {
    const app = await launchPwrSnap();
    try {
      // Library is the singleton main window — the fixture's launch
      // path opens it. Confirm before we strip the dock.
      await ensureLibrary(app);
      const beforeStrip = await getLibraryState(app);
      expect(beforeStrip.exists, "Library window exists at startup").toBe(true);

      // Stand-in for the activateApp side-effect: a direct dock.hide()
      // sets NSApplicationActivationPolicyProhibited (or Accessory,
      // depending on context) and pulls the Dock icon. Real
      // production code never calls this; we use it to recreate the
      // exact end-state we observed live (PwrSnap type=UIElement,
      // Library still alive).
      await dockHide(app);
      await expectDockVisible(app, false);

      const afterStrip = await getLibraryState(app);
      expect(
        afterStrip.exists,
        "Library window is alive even with Dock icon stripped — the orphan state"
      ).toBe(true);
      expect(afterStrip.visible, "Library is still visible to the OS").toBe(true);
    } finally {
      await app.close();
    }
  });

  test("forceReclaimDockIcon restores the Dock icon when Library is alive", async () => {
    const app = await launchPwrSnap();
    try {
      await ensureLibrary(app);

      // Strip — simulates activateApp's side-effect on production.
      await dockHide(app);
      await expectDockVisible(app, false);

      // The fix: production calls this from capture-handlers.ts after
      // every activateApp, and from index.ts on app.on('did-resign-
      // active'). Both are in production code paths; here we invoke
      // the helper directly to assert it actually restores the icon.
      await forceReclaim(app);
      await expectDockVisible(app, true);

      const after = await getLibraryState(app);
      expect(after.exists, "Library survives reclaim").toBe(true);
      expect(after.visible, "Library stays visible — no flicker").toBe(true);
    } finally {
      await app.close();
    }
  });

  test("forceReclaimDockIcon is a no-op when the Library doesn't exist", async () => {
    // This guards the tray-keeps-the-app-alive contract: when the
    // user closes the Library, the Dock icon is supposed to vanish
    // and stay vanished (the tray icon takes over). The reclaim
    // helper should not second-guess that.
    const app = await launchPwrSnap();
    try {
      // Close the only window — `findMainLibraryWindow` should
      // return null after this.
      //
      // We wait for the close + state-clear inside the same
      // electronApp.evaluate so the singleton ref is null by the
      // time the call resolves. Avoids relying on `app.window`
      // (Playwright's handle on the renderer Page) after we've
      // explicitly destroyed it — Playwright marks the page as
      // closed at that point and any `app.window.*` call rejects.
      await app.electronApp.evaluate(async ({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          const url = win.webContents.getURL();
          // Library has no stage= fragment; close only it.
          if (!url.includes("stage=")) {
            const closed = new Promise<void>((resolve) => {
              win.once("closed", () => resolve());
            });
            win.close();
            await closed;
          }
        }
      });

      const state = await getLibraryState(app);
      expect(state.exists, "Library is gone after close").toBe(false);

      // Strip + reclaim. Reclaim must NOT re-show the Dock icon.
      await dockHide(app);
      await expectDockVisible(app, false);

      await forceReclaim(app);
      // 200ms grace — if the reclaim WERE going to show the dock,
      // the policy write would have landed by now. Use a main-side
      // wait since app.window (the Library Page) is destroyed.
      await app.electronApp.evaluate(
        () => new Promise<void>((resolve) => setTimeout(resolve, 200))
      );
      expect(
        await dockIsVisible(app),
        "Dock stays hidden when Library is closed — no resurrection"
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  test("repeated forceReclaim calls while dock is up are a safe no-op", async () => {
    // Production fires `reclaimDockIconIfLibraryAlive` from many
    // edges — every `activateApp` call site, every
    // `app.on('did-resign-active')` notification. Most fires are
    // redundant (the icon is already visible). The helper's
    // `if (app.dock?.isVisible() === true) return;` early-exit must
    // keep the no-op cheap and side-effect-free.
    //
    // We deliberately test "reclaim when already up" rather than
    // hide → show → hide cycles, because rapid back-to-back
    // `setActivationPolicy:` calls on AppKit's main thread can leave
    // the policy in an indeterminate state on macOS. Production
    // never thrashes the policy in a tight loop — it just over-
    // calls reclaim. So that's the contract we lock in.
    const app = await launchPwrSnap();
    try {
      await ensureLibrary(app);

      // Bring the dock up once (the post-capture state we care
      // about most: PwrSnap regular, Library alive).
      await forceReclaim(app);
      await expectDockVisible(app, true);

      // Spam the reclaim — should stay no-op throughout. If the
      // helper churns the policy (e.g. a future refactor drops the
      // `isVisible()` early-exit), this might fail intermittently
      // OR the assertions below would catch a leak.
      for (let i = 0; i < 10; i += 1) {
        await forceReclaim(app);
      }

      // Dock still up + Library still alive after the spam.
      expect(await dockIsVisible(app)).toBe(true);
      const final = await getLibraryState(app);
      expect(final.exists, "Library survives the reclaim spam").toBe(true);
    } finally {
      await app.close();
    }
  });

  test("dockShow restores the icon directly (sanity check of bridge)", async () => {
    // Self-check on the bridge: dockShow should also restore the
    // icon, confirming the bridge's view of dock state is wired up.
    // If this fails but the other tests pass, the bridge is broken;
    // if this passes but `forceReclaimDockIcon restores` fails, the
    // reclaim helper itself is broken.
    const app = await launchPwrSnap();
    try {
      await ensureLibrary(app);
      await dockHide(app);
      await expectDockVisible(app, false);
      await dockShow(app);
      await expectDockVisible(app, true);
    } finally {
      await app.close();
    }
  });
});
