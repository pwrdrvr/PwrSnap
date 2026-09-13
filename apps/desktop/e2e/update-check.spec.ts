// Help → Check for Updates, end to end.
//
// Driven through the dev/QA fake (`simulateDevUpdateCheck`) rather than
// GitHub — which is the point: the fake walks the same status machine a real
// check does, so the Library's update card is driven here exactly as it would
// be by a real download. The harness launches with `NODE_ENV=production` and
// skips `initAppUpdater`, so the fake has to be put back explicitly with
// `PWRSNAP_E2E_UPDATE_FAKE=1`; `PWRSNAP_E2E_UPDATE_STEP_MS` then paces it so
// the Cancel button — which only exists mid-download — is a target rather
// than a race.
//
// No platform branch. Unlike PwrGit's, this app's check has no per-platform
// early answer: `checkForAppUpdatesNow` reaches the fake on Linux, macOS and
// Windows alike, so the same assertions hold on the Linux CI lane.
//
// Unit-level companions: src/main/__tests__/auto-updater-cancel.test.ts (the
// cancel paths in main) and the update feature's renderer tests.

import { expect, launchPwrSnap, test, type LaunchedApp } from "./fixtures/electron-app";

const FAKE_VERSION = "420.0.0";
/** Slow enough that the mid-download card is a target, not a race. Seven
 *  percent ticks at this pace give roughly six seconds to act. */
const UPDATE_STEP_MS = 800;

async function launchWithFakeUpdates(): Promise<LaunchedApp> {
  return await launchPwrSnap({
    env: {
      PWRSNAP_E2E_UPDATE_FAKE: "1",
      PWRSNAP_E2E_UPDATE_STEP_MS: String(UPDATE_STEP_MS)
    }
  });
}

/** Click the real menu item, not the command bus: the bus verb is Settings'
 *  "manual" trigger, which deliberately reports inline and raises no card. */
async function clickCheckForUpdates(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find(
        (candidate) => candidate.label === "Check for Updates"
      );
      if (item !== undefined) {
        item.click();
        return;
      }
    }
    throw new Error("Menu item not found: Check for Updates");
  });
}

test.describe("Help → Check for Updates", () => {
  test("reports itself live and ends on an actionable offer", async () => {
    const app = await launchWithFakeUpdates();
    try {
      const card = app.window.locator(".app-toast-stack .app-update-banner").first();
      // Nothing before the ask: startup and periodic checks stay silent.
      await expect(card).toHaveCount(0);

      await clickCheckForUpdates(app);

      await expect(card).toContainText("Checking for updates");
      // The card reports work in flight, so it carries a progress track and
      // NOT the countdown strip that would dismiss it out from under a
      // running check.
      await expect(card.locator(".app-update-banner__track")).toBeVisible();
      await expect(card.locator(".app-update-banner__timer")).toHaveCount(0);

      await expect(card).toContainText("Downloading update", { timeout: 20_000 });
      await expect(card).toContainText(`PwrSnap v${FAKE_VERSION}`);
      await expect(card.locator(".app-update-banner__meter")).toContainText("MB of");
      await expect(card.locator("[role='progressbar']")).toHaveAttribute(
        "aria-valuenow",
        /\d+/
      );

      // And it ends on the one thing there is to do about it.
      await expect(app.window.locator(".app-toast-stack")).toContainText(
        `Restart to update to v${FAKE_VERSION}.`,
        { timeout: 30_000 }
      );
      await expect(app.window.getByRole("button", { name: "Restart" })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("Cancel stops the download and says so without crying failure", async () => {
    const app = await launchWithFakeUpdates();
    try {
      await clickCheckForUpdates(app);

      const card = app.window.locator(".app-toast-stack .app-update-banner").first();
      await expect(card).toContainText("Downloading update", { timeout: 20_000 });

      await card.getByRole("button", { name: "Cancel" }).click();

      const notice = app.window.locator(".app-toast-stack .app-update-banner").first();
      await expect(notice).toContainText("Download canceled", { timeout: 20_000 });
      await expect(notice).toContainText(`PwrSnap v${FAKE_VERSION} is still available`);
      // A cancel is not a failure — nothing broke, so no danger tint.
      await expect(
        app.window.locator(".app-toast-stack .app-update-banner--error")
      ).toHaveCount(0);
      // Now it IS a finished notice, so it goes on the dismiss countdown.
      await expect(notice.locator(".app-update-banner__timer")).toBeVisible();
      await expect(notice.locator(".app-update-banner__track")).toHaveCount(0);

      // Nothing was downloaded, so nothing is offered to restart into.
      await expect(app.window.getByRole("button", { name: "Restart" })).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test("a check nobody asked the Library about shows only the end result", async () => {
    // Settings' own Check for Updates button (and every background check) go
    // through the same status machine, and must raise NO live card: they never
    // emit the user-initiated channel the card is gated on. The only thing
    // that reaches the Library is the actionable offer at the end.
    const app = await launchPwrSnap({
      env: { PWRSNAP_E2E_UPDATE_FAKE: "1", PWRSNAP_E2E_UPDATE_STEP_MS: "400" }
    });
    try {
      const pending = app.dispatch("app:update:check", {});

      await expect
        .poll(
          async () => {
            const status = await app.dispatch("app:update:status", {});
            return status.ok ? status.value.status : "unreadable";
          },
          { timeout: 15_000 }
        )
        .toBe("downloading");
      await expect(app.window.locator(".app-update-banner__track")).toHaveCount(0);

      await pending;
      await expect(app.window.locator(".app-toast-stack")).toContainText(
        `Restart to update to v${FAKE_VERSION}.`,
        { timeout: 20_000 }
      );
      // Still no progress card, even now — it was never the Library's to show.
      await expect(app.window.locator(".app-update-banner__track")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
