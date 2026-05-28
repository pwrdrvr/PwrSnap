// Recording flow E2E — covers the post-capture video float-over
// rendered against a seeded video row, without spawning a real
// recorder.
//
// Why no real recording: the Swift binary needs Screen Recording
// TCC + ScreenCaptureKit. The Playwright Electron harness has
// neither granted, so a real recording would hang on the TCC
// prompt forever and time out. The recording-service itself is
// covered by main-side unit tests
// (apps/desktop/src/main/recording/__tests__/recording-service.test.ts).
// The command-bus envelope (recording:state / cancel / restart,
// permissions:readiness / request) is covered by
// (apps/desktop/src/main/handlers/__tests__/recording-handlers-bus.test.ts).
// This spec only retains tests that inspect real BrowserWindow
// lifecycle + rendered DOM, which the bus mock can't reproduce.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

// "recording flow — command bus" — five IPC-envelope tests moved to
// apps/desktop/src/main/handlers/__tests__/recording-handlers-bus.test.ts.
// Each was a launchPwrSnap + single bus.dispatch + Result assertion; the
// entire test budget was spent in the cold-start and they made up the
// dominant share of the Linux/xvfb worker-teardown flakes on PR #125
// (CI runs 26549457564 + 26550169080). The video float-over tests below
// keep their E2E shape — they inspect real BrowserWindow lifecycle and
// rendered DOM, which the bus mock can't reproduce.

test.describe("video float-over", () => {
  test.skip(!isMac, "float-over relies on macOS BrowserWindow alwaysOnTop semantics");

  /**
   * Seed both the captures row AND the video_captures metadata row
   * via the test bridge so library:byId returns a hydrated video
   * record. Also writes a tiny fake MP4 so the protocol handler
   * doesn't 404 on the `<video>` element's metadata load.
   */
  async function seedVideoCapture(
    app: Awaited<ReturnType<typeof launchPwrSnap>>
  ): Promise<string> {
    const captureId = `vid-e2e-${Date.now().toString(36)}`;
    const captureDir = path.join(app.homeRoot, "Documents", "PwrSnap");
    await mkdir(captureDir, { recursive: true });
    const mp4Path = path.join(captureDir, `${captureId}.mp4`);
    // Tiny placeholder — the renderer's `<video>` element won't
    // successfully decode this but it'll render the element, which
    // is what the spec asserts on. The Range-aware protocol handler
    // serves the byte range so the network request returns 206 and
    // the element transitions to `metadata` ready state.
    await writeFile(mp4Path, Buffer.from("fake mp4 placeholder bytes"));

    await app.electronApp.evaluate(
      (_electron, payload: { id: string; path: string }) => {
        const bridge = (
          globalThis as unknown as {
            __PWRSNAP_TEST__: {
              seedCapture: (input: Record<string, unknown>) => unknown;
              seedVideoMetadata: (input: Record<string, unknown>) => void;
            };
          }
        ).__PWRSNAP_TEST__;
        bridge.seedCapture({
          id: payload.id,
          kind: "video",
          captured_at: new Date().toISOString(),
          source_app_bundle_id: null,
          source_app_name: null,
          src_path: payload.path,
          width_px: 1920,
          height_px: 1080,
          device_pixel_ratio: 1,
          byte_size: 25,
          sha256: payload.id
        });
        bridge.seedVideoMetadata({
          captureId: payload.id,
          durationSec: 12.5,
          containerFormat: "mp4",
          hasSystemAudio: true,
          hasMicrophoneAudio: false,
          subject: {
            kind: "region",
            rect: { x: 0, y: 0, w: 1920, h: 1080 },
            displayId: 1
          }
        });
      },
      { id: captureId, path: mp4Path }
    );
    return captureId;
  }

  async function findFloatOverPage(
    app: Awaited<ReturnType<typeof launchPwrSnap>>
  ): Promise<ReturnType<typeof app.electronApp.windows>[number] | null> {
    for (const page of app.electronApp.windows()) {
      const url = page.url();
      if (url.includes("stage=float-over")) return page;
    }
    return null;
  }

  test("video asset renders <video> + GIF/MP4 buttons + Discard footer action", async () => {
    const app = await launchPwrSnap();
    try {
      const captureId = await seedVideoCapture(app);

      // Drive the float-over to LOADED for our seeded record.
      await app.electronApp.evaluate(
        (_electron, payload: { id: string }) => {
          const bridge = (
            globalThis as unknown as {
              __PWRSNAP_TEST__: {
                setFloatOverState: (event: unknown) => void;
              };
            }
          ).__PWRSNAP_TEST__;
          bridge.setFloatOverState({ kind: "show-loaded", captureId: payload.id });
        },
        { id: captureId }
      );

      // Wait for the float-over BrowserWindow to materialize.
      await expect
        .poll(async () => (await findFloatOverPage(app)) !== null, { timeout: 5000 })
        .toBe(true);
      const floatOver = await findFloatOverPage(app);
      if (floatOver === null) throw new Error("float-over window never appeared");

      // Video preview element (not <img>) sits in the fo__preview slot.
      await expect(floatOver.locator(".fo__preview video")).toBeVisible({ timeout: 5000 });
      await expect(floatOver.locator(".fo__preview img")).toHaveCount(0);

      // Header reads "Recording saved" with duration in the subtitle.
      await expect(floatOver.locator(".fo__hdr-title")).toHaveText("Recording saved");
      await expect(floatOver.locator(".fo__hdr-sub")).toContainText("12.5s");

      // GIF + MP4 cards in the copy row, in that order.
      const copyButtons = floatOver.locator(".fo__copy button.fo__copy-btn");
      await expect(copyButtons).toHaveCount(2);
      await expect(copyButtons.nth(0).locator(".fo__copy-label")).toHaveText("GIF");
      await expect(copyButtons.nth(1).locator(".fo__copy-label")).toHaveText("MP4");

      // Discard button in the footer.
      await expect(floatOver.locator(".fo__foot-btn", { hasText: "Discard" })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("Library Stage renders source_app_name from a window-subject video capture", async () => {
    // Pins the end-to-end behavior that motivated adding appName +
    // appBundleId to the window variant of RecordingSubject and
    // plumbing them through recording-service.stop() into the
    // captures row. Before the fix, all video rows wrote null app
    // metadata and the Library Stage rendered "Unknown app" even
    // for window-snapped recordings. The unit test in
    // recording-service.test.ts pins the recording-side write; THIS
    // spec pins the Library reads them back and the AppTag renders
    // them. Drift on either side fails here.
    const app = await launchPwrSnap();
    try {
      const captureId = `vid-app-meta-${Date.now().toString(36)}`;
      const captureDir = path.join(app.homeRoot, "Documents", "PwrSnap");
      await mkdir(captureDir, { recursive: true });
      const mp4Path = path.join(captureDir, `${captureId}.mp4`);
      await writeFile(mp4Path, Buffer.from("x"));

      await app.electronApp.evaluate(
        (_electron, payload: { id: string; path: string }) => {
          const bridge = (
            globalThis as unknown as {
              __PWRSNAP_TEST__: {
                seedCapture: (input: Record<string, unknown>) => unknown;
                seedVideoMetadata: (input: Record<string, unknown>) => void;
              };
            }
          ).__PWRSNAP_TEST__;
          bridge.seedCapture({
            id: payload.id,
            kind: "video",
            captured_at: new Date().toISOString(),
            // Window-snapped recording — the values that the
            // recording-service writes when subject.kind === "window"
            // and subject.appName/appBundleId are populated.
            source_app_bundle_id: "com.microsoft.edgemac",
            source_app_name: "Microsoft Edge",
            src_path: payload.path,
            width_px: 1440,
            height_px: 938,
            device_pixel_ratio: 1,
            byte_size: 1,
            sha256: payload.id
          });
          bridge.seedVideoMetadata({
            captureId: payload.id,
            durationSec: 5.5,
            containerFormat: "mp4",
            hasSystemAudio: false,
            hasMicrophoneAudio: false,
            subject: {
              kind: "window",
              windowId: 12345,
              rect: { x: 28, y: 29, w: 1440, h: 938 },
              displayId: 1,
              appName: "Microsoft Edge",
              appBundleId: "com.microsoft.edgemac"
            }
          });
        },
        { id: captureId, path: mp4Path }
      );

      const window = app.window;
      // Wait for our seeded capture to appear in the grid.
      const cell = window.locator(`.psl__cell[data-cell-id="${captureId}"]`);
      await expect(cell).toBeVisible({ timeout: 10_000 });
      await cell.click();

      // Stage's app tag renders source_app_name verbatim. The class
      // is shared with the image path so a renderer-side regression
      // (e.g. someone narrowing the type to require non-null) would
      // surface here for both kinds.
      const appTag = window.locator(".psl__stage-meta .ps-app-tag__name").first();
      await expect(appTag).toBeVisible({ timeout: 5000 });
      await expect(appTag).toHaveText("Microsoft Edge");
    } finally {
      await app.close();
    }
  });

  test("Library Stage falls back to 'Unknown app' when source_app_name is null (region capture)", async () => {
    // Counterpart to the window-subject test above. Region/display
    // recordings legitimately have no single source app, so the
    // recording-service writes null and the Stage shows the fallback.
    // Pinning this prevents a well-meaning future PR from injecting
    // a "default app" or stripping the fallback.
    const app = await launchPwrSnap();
    try {
      const captureId = `vid-no-app-${Date.now().toString(36)}`;
      const captureDir = path.join(app.homeRoot, "Documents", "PwrSnap");
      await mkdir(captureDir, { recursive: true });
      const mp4Path = path.join(captureDir, `${captureId}.mp4`);
      await writeFile(mp4Path, Buffer.from("x"));

      await app.electronApp.evaluate(
        (_electron, payload: { id: string; path: string }) => {
          const bridge = (
            globalThis as unknown as {
              __PWRSNAP_TEST__: {
                seedCapture: (input: Record<string, unknown>) => unknown;
                seedVideoMetadata: (input: Record<string, unknown>) => void;
              };
            }
          ).__PWRSNAP_TEST__;
          bridge.seedCapture({
            id: payload.id,
            kind: "video",
            captured_at: new Date().toISOString(),
            source_app_bundle_id: null,
            source_app_name: null,
            src_path: payload.path,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 1,
            sha256: payload.id
          });
          bridge.seedVideoMetadata({
            captureId: payload.id,
            durationSec: 3,
            containerFormat: "mp4",
            hasSystemAudio: false,
            hasMicrophoneAudio: false,
            subject: {
              kind: "region",
              rect: { x: 0, y: 0, w: 800, h: 600 },
              displayId: 1
            }
          });
        },
        { id: captureId, path: mp4Path }
      );

      const window = app.window;
      const cell = window.locator(`.psl__cell[data-cell-id="${captureId}"]`);
      await expect(cell).toBeVisible({ timeout: 10_000 });
      await cell.click();

      const appTag = window.locator(".psl__stage-meta .ps-app-tag__name").first();
      await expect(appTag).toBeVisible({ timeout: 5000 });
      await expect(appTag).toHaveText("Unknown app");
    } finally {
      await app.close();
    }
  });

  test("very short clip surfaces the short-clip warning banner", async () => {
    const app = await launchPwrSnap();
    try {
      // Seed a clip < 1.5s so the warning banner renders.
      const captureId = `vid-short-${Date.now().toString(36)}`;
      const captureDir = path.join(app.homeRoot, "Documents", "PwrSnap");
      await mkdir(captureDir, { recursive: true });
      const mp4Path = path.join(captureDir, `${captureId}.mp4`);
      await writeFile(mp4Path, Buffer.from("x"));
      await app.electronApp.evaluate(
        (_electron, payload: { id: string; path: string }) => {
          const bridge = (
            globalThis as unknown as {
              __PWRSNAP_TEST__: {
                seedCapture: (input: Record<string, unknown>) => unknown;
                seedVideoMetadata: (input: Record<string, unknown>) => void;
                setFloatOverState: (event: unknown) => void;
              };
            }
          ).__PWRSNAP_TEST__;
          bridge.seedCapture({
            id: payload.id,
            kind: "video",
            captured_at: new Date().toISOString(),
            source_app_bundle_id: null,
            source_app_name: null,
            src_path: payload.path,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 1,
            sha256: payload.id
          });
          bridge.seedVideoMetadata({
            captureId: payload.id,
            durationSec: 0.3,
            containerFormat: "mp4",
            hasSystemAudio: false,
            hasMicrophoneAudio: false,
            subject: {
              kind: "region",
              rect: { x: 0, y: 0, w: 800, h: 600 },
              displayId: 1
            }
          });
          bridge.setFloatOverState({ kind: "show-loaded", captureId: payload.id });
        },
        { id: captureId, path: mp4Path }
      );

      await expect
        .poll(async () => (await findFloatOverPage(app)) !== null, { timeout: 5000 })
        .toBe(true);
      const floatOver = await findFloatOverPage(app);
      if (floatOver === null) throw new Error("float-over window never appeared");

      // Warning banner renders with Discard CTA.
      const banner = floatOver.locator('[data-fo-warning="short-clip"]');
      await expect(banner).toBeVisible({ timeout: 5000 });
      await expect(banner).toContainText("Very short");
      await expect(banner.locator("button", { hasText: "Discard" })).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
