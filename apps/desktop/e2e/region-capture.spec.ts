// Region-capture pixel-verification spec — macOS only.
//
// Drives a programmatic `capture:region` against a target window
// painted a known color, then samples the resulting PNG at the rect
// center to verify we captured the right area.
//
// macOS-only because:
//   1. screencapture(1) requires Screen Recording TCC permissions; CI
//      Linux runners can't grant them and Windows has no analog.
//   2. The xvfb compositor on Linux CI has its own capture path that
//      doesn't go through the macOS-specific code we want to exercise.
//
// On Linux CI this whole describe-block is skipped — `pnpm test:e2e`
// runs the smoke + target-windows specs and stops there. macOS
// developers (and a future macos-15 release-time runner) get full
// pixel-verification coverage.

import path from "node:path";
import { expect, test } from "@playwright/test";
import type { CaptureRecord } from "@pwrsnap/shared";
import { launchPwrSnap } from "./fixtures/electron-app";
import { spawnTargetWindows, type TargetWindowSpec } from "./fixtures/target-windows";
import { colorsClose, formatRgb, hexToRgb, samplePixel } from "./fixtures/pixel-sample";

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
// Real screen capture requires Screen Recording TCC permission for
// the running binary — a one-time approval the user grants in
// System Settings → Privacy & Security. The Playwright-launched
// Electron debug binary does not inherit Pwrsnap.app's grant, so
// this spec is opt-in via env. Locally:
//   1. Run `pnpm dev` once and approve "Electron" in the TCC dialog;
//   2. Re-run with PWRSNAP_E2E_REAL_CAPTURE=1 pnpm test:desktop-e2e.
const realCaptureOpt = process.env.PWRSNAP_E2E_REAL_CAPTURE === "1";

test.describe("region capture (macOS opt-in + Windows)", () => {
  // macOS uses screencapture(1); Windows uses desktopCapturer. Linux/xvfb has
  // its own capture path we don't exercise here.
  test.skip(!isMac && !isWin, "screen capture runs on macOS + Windows (Linux/xvfb excluded)");
  // On macOS the test Electron binary needs Screen Recording TCC perms, so the
  // pixel check is opt-in there (PWRSNAP_E2E_REAL_CAPTURE=1). Windows'
  // desktopCapturer needs no permission, so it always runs.
  test.skip(
    isMac && !realCaptureOpt,
    "on macOS set PWRSNAP_E2E_REAL_CAPTURE=1 (Screen Recording TCC); not needed on Windows"
  );

  test("captures the painted color from a target window", async () => {
    const app = await launchPwrSnap();
    try {
      // A red 240×180 tile near (300, 300) — well off the menu bar
      // and well inside any reasonable display.
      const target: TargetWindowSpec = {
        id: "tile-pixel-check",
        color: "#ff3322",
        rect: { x: 300, y: 300, width: 240, height: 180 }
      };
      const targets = await spawnTargetWindows(app.electronApp, [target]);

      try {
        // Resolve display-virtual-coords for the target rect. On
        // macOS the menu bar lives at y=0 of the primary display, so
        // a window placed at (300, 300) really does land at (300, 300)
        // in the global coord space.
        const primaryDisplayId = await app.electronApp.evaluate(({ screen }) => {
          return screen.getPrimaryDisplay().id;
        });

        // Give the compositor a frame to commit before we capture —
        // a freshly-spawned window is sometimes still painting on the
        // very next tick.
        await app.window.waitForTimeout(150);

        const result = await app.dispatch("capture:region", {
          // capture:region uses {x,y,w,h}; target rects use {width,height}
          // for BrowserWindow ergonomics. Translate at the boundary.
          rect: {
            x: target.rect.x,
            y: target.rect.y,
            w: target.rect.width,
            h: target.rect.height
          },
          displayId: primaryDisplayId
        });

        expect(result.ok, `capture:region failed: ${JSON.stringify(result)}`).toBe(true);
        if (!result.ok) return;
        const record: CaptureRecord = result.value;

        // Sample dead-center of the captured PNG and compare to the
        // painted color. Allow ±8 per channel for compositor jitter.
        const cx = Math.floor(record.width_px / 2);
        const cy = Math.floor(record.height_px / 2);
        const samplePath = record.legacy_src_path;
        if (samplePath === null) {
          throw new Error("region-capture spec: expected legacy_src_path on freshly captured record");
        }
        const sampled = await samplePixel(samplePath, cx, cy);
        const expected = hexToRgb(target.color);

        expect(
          colorsClose(sampled, expected, 12),
          `expected ${formatRgb(expected)} at center; got ${formatRgb(sampled)} (${path.basename(
            samplePath
          )})`
        ).toBe(true);
      } finally {
        await targets.close();
      }
    } finally {
      await app.close();
    }
  });
});
