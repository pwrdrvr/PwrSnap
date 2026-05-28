// E2E coverage for the Library DetailRail's vertical activity-bar
// refresh. Verifies that:
//
//   • The rail renders three vertical tabs: Info / OCR / Chat.
//   • Switching tabs swaps the panel body.
//   • The persistent footer (L/M/H copy + actions) is visible on
//     every tab.
//   • Pinning + unpinning via clicking the active tab works.
//
// Mirrors the editor-activity-bar spec for the Library surface. The
// Library rail uses its own per-window pin state (separate from the
// editor's settings-persisted state).
//
// NOTE: an earlier iteration of this spec skipped on non-macOS due to
// the rail icons never becoming visible after `library:openInLibrary`.
// That was a renderer Rules-of-Hooks bug (DetailRail had a useMemo
// below its `view.kind === "grid"` early return — every grid→focus
// transition tripped React's hook-count guard, aborted the parent
// commit, and left `.psl[data-mode]` stuck at "grid"). Fixed in the
// same PR; the spec is back to running on every platform.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

test.setTimeout(120_000);

test("library-right-rail: renders Info/OCR/Chat vertical tabs with persistent footer", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = app.window;

    // Open the capture in Library Focus.
    await app.dispatch("library:openInLibrary", { captureId });

    // Wait for the DetailRail to mount in Focus mode.
    await win
      .locator('[data-testid="psl-right-tab-info"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    // All three tabs are present.
    await expect(
      win.locator('[data-testid="psl-right-tab-info"]')
    ).toHaveCount(1);
    await expect(
      win.locator('[data-testid="psl-right-tab-ocr"]')
    ).toHaveCount(1);
    await expect(
      win.locator('[data-testid="psl-right-tab-chat"]')
    ).toHaveCount(1);

    // Persistent footer is always present.
    await expect(
      win.locator('[data-testid="psl-right-footer"]')
    ).toHaveCount(1);

    // Default tab is Info — the DetailTab inputs (Title / Description /
    // Filename) are visible.
    await expect(win.locator(".psl__field-input").first()).toBeVisible();

    // Switch to OCR.
    await win.locator('[data-testid="psl-right-tab-ocr"]').click();
    await win
      .locator(".psl__ocr-tab")
      .waitFor({ state: "visible", timeout: 5_000 });

    // Footer still visible.
    await expect(
      win.locator('[data-testid="psl-right-footer"]')
    ).toBeVisible();

    // Switch to Chat.
    await win.locator('[data-testid="psl-right-tab-chat"]').click();
    await win
      .locator('[data-testid="chat-panel"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(
      win.locator('[data-testid="chat-context"]')
    ).toBeVisible();

    // Footer is still visible — the rail's footer is independent of
    // the active tab.
    await expect(
      win.locator('[data-testid="psl-right-footer"]')
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("library-right-rail: clicking active tab unpins to hover-pop", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = app.window;

    await app.dispatch("library:openInLibrary", { captureId });
    await win
      .locator('[data-testid="psl-right-tab-info"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    // Pinned panel rendered (default state).
    await win
      .locator('[data-testid="psl-right-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Click active Info tab → unpin → hover-pop visible.
    await win.locator('[data-testid="psl-right-tab-info"]').click();
    await expect(
      win.locator('[data-testid="psl-right-panel-pinned"]')
    ).toHaveCount(0);
    await win
      .locator('[data-testid="psl-right-panel-hover"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Click another tab → re-pin and switch.
    await win.locator('[data-testid="psl-right-tab-ocr"]').click();
    await win
      .locator('[data-testid="psl-right-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(win.locator(".psl__ocr-tab")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("library-right-rail: video capture footer shows GIF + MP4 export buttons, not Low/Med/High", async () => {
  // Regression for the bug where DetailRail's COPY TO CLIPBOARD row
  // unconditionally rendered the image-resize presets (LOW / MED /
  // HIGH with computed PNG-scaled dimensions and KB sizes) for video
  // captures too. The fix branches on `record.kind === "video"` and
  // renders two GIF / MP4 export cards instead — same pattern the tray
  // and float-over already use.
  const app = await launchPwrSnap();
  try {
    const captureId = await seedVideoCapture(app);
    const win = app.window;

    await app.dispatch("library:openInLibrary", { captureId });
    await win
      .locator('[data-testid="psl-right-tab-info"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    // The video-branch copy row is wired with its own data-testid so a
    // selector regression here can't silently re-route to the image
    // branch (which would render with the same outer `.psl__copy-row`
    // class). Two cards exactly — GIF + MP4, no third "high" slot.
    const videoCopyRow = win.locator('[data-testid="psl-copy-row-video"]');
    await expect(videoCopyRow).toBeVisible();
    await expect(videoCopyRow.locator("button")).toHaveCount(2);
    await expect(videoCopyRow.getByText("GIF", { exact: true })).toBeVisible();
    await expect(videoCopyRow.getByText("MP4", { exact: true })).toBeVisible();

    // None of the image-preset labels should be present for a video.
    // The DOM has lots of incidental "Med" and "High" text fragments
    // (tag suggestions, AppIcons, etc.), so scope the negative
    // assertion to the footer the new code rendered into.
    const footer = win.locator('[data-testid="psl-right-footer"]');
    await expect(footer.getByText("Low", { exact: true })).toHaveCount(0);
    await expect(footer.getByText("Med", { exact: true })).toHaveCount(0);
    await expect(footer.getByText("High", { exact: true })).toHaveCount(0);

    // Eyebrow flips from "Copy to clipboard" to "Export" for video.
    await expect(footer.getByText("Export", { exact: true })).toBeVisible();
    await expect(
      footer.getByText("Copy to clipboard", { exact: true })
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// ---- Shared helpers --------------------------------------------------

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-rightrail-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `rightrail-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await app.electronApp.evaluate(
    (_electron, payload: { id: string; pngPath: string }) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: {
              id: string;
              kind: "image" | "video";
              captured_at: string;
              source_app_bundle_id: string | null;
              source_app_name: string | null;
              legacy_src_path: string | null;
              width_px: number;
              height_px: number;
              device_pixel_ratio: number;
              byte_size: number;
              sha256: string;
            }) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.id,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.spec",
        source_app_name: "Right Rail Spec",
        legacy_src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id
      });
    },
    { id: captureId, pngPath }
  );
  return captureId;
}

async function seedVideoCapture(app: LaunchedApp): Promise<string> {
  // Mirrors `recording-flow.spec.ts`'s helper: drop a placeholder .mp4
  // under <homeRoot>/Documents/PwrSnap, then seed a `kind: "video"`
  // capture row + its video_captures metadata row through the E2E
  // bridge. The placeholder bytes don't decode — but DetailRail only
  // reads metadata fields, never plays the video, so that's fine.
  const captureDir = path.join(app.homeRoot, "Documents", "PwrSnap");
  await mkdir(captureDir, { recursive: true });
  const captureId = `rightrail-video-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const mp4Path = path.join(captureDir, `${captureId}.mp4`);
  await writeFile(mp4Path, Buffer.from("fake mp4 placeholder bytes"));

  await app.electronApp.evaluate(
    (_electron, payload: { id: string; mp4Path: string }) => {
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
        source_app_bundle_id: "com.test.spec",
        source_app_name: "Right Rail Video Spec",
        src_path: payload.mp4Path,
        width_px: 1440,
        height_px: 960,
        device_pixel_ratio: 1,
        byte_size: 25,
        sha256: payload.id
      });
      bridge.seedVideoMetadata({
        captureId: payload.id,
        durationSec: 2.0,
        containerFormat: "mp4",
        hasSystemAudio: false,
        hasMicrophoneAudio: false,
        subject: {
          kind: "region",
          rect: { x: 0, y: 0, w: 1440, h: 960 },
          displayId: 1
        }
      });
    },
    { id: captureId, mp4Path }
  );
  return captureId;
}
