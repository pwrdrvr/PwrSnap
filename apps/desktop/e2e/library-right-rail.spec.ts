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

test("library-right-rail: video capture footer renders the 6-card preset grid", async () => {
  // The video-branch footer is two `.psl__copy-row` containers — one
  // GIF row, one MP4 row — with three preset cards each. Each card
  // carries a FILE chip (click = copy path, drag = native drag-out).
  // Earlier in #136 this slot was a 2-card minimal UI (just GIF +
  // MP4 buttons); the 6-card grid is the full-power replacement.
  const app = await launchPwrSnap();
  try {
    const captureId = await seedVideoCapture(app);
    const win = app.window;

    await app.dispatch("library:openInLibrary", { captureId });
    await win
      .locator('[data-testid="psl-right-tab-info"]')
      .waitFor({ state: "visible", timeout: 15_000 });

    // Two per-format rows present, each with three buttons (cards)
    // and three FILE chips (.fo__copy-file).
    const gifRow = win.locator('[data-testid="psl-copy-row-video-gif"]');
    const mp4Row = win.locator('[data-testid="psl-copy-row-video-mp4"]');
    await expect(gifRow).toBeVisible();
    await expect(mp4Row).toBeVisible();
    await expect(gifRow.locator(".fo__copy-btn")).toHaveCount(3);
    await expect(mp4Row.locator(".fo__copy-btn")).toHaveCount(3);
    await expect(gifRow.locator(".fo__copy-file")).toHaveCount(3);
    await expect(mp4Row.locator(".fo__copy-file")).toHaveCount(3);

    // Preset labels appear inside each row — 3 × Low / Med / High
    // per row × 2 rows = 6 cards. Scope the assertion to the row
    // containers so unrelated DOM (tag suggestions, AppIcons) can't
    // satisfy a global match.
    for (const row of [gifRow, mp4Row]) {
      await expect(row.getByText("Low", { exact: true })).toHaveCount(1);
      await expect(row.getByText("Med", { exact: true })).toHaveCount(1);
      await expect(row.getByText("High", { exact: true })).toHaveCount(1);
    }

    // Keyboard shortcut hints — ⌘1-⌘3 on the GIF row, ⌘4-⌘6 on
    // the MP4 row. Each maps to the corresponding card in left-to-
    // right order. Anchors the layout: a regression that swaps row
    // order (MP4 on top instead of GIF) would fail here.
    await expect(gifRow.getByText("⌘1", { exact: true })).toBeVisible();
    await expect(gifRow.getByText("⌘2", { exact: true })).toBeVisible();
    await expect(gifRow.getByText("⌘3", { exact: true })).toBeVisible();
    await expect(mp4Row.getByText("⌘4", { exact: true })).toBeVisible();
    await expect(mp4Row.getByText("⌘5", { exact: true })).toBeVisible();
    await expect(mp4Row.getByText("⌘6", { exact: true })).toBeVisible();

    // Eyebrow flipped from "Copy to clipboard" to "Export" for video.
    const footer = win.locator('[data-testid="psl-right-footer"]');
    await expect(footer.getByText("Export", { exact: true })).toBeVisible();
    await expect(
      footer.getByText("Copy to clipboard", { exact: true })
    ).toHaveCount(0);

    // Per-format subheaders distinguish the two otherwise-identical
    // rows. Each row group wraps an eyebrow + the .psl__copy-row.
    // Without these, the user sees two rows of "LOW MED HIGH" with
    // no way to tell which is GIF and which is MP4.
    const gifGroup = win.locator(
      '[data-testid="psl-copy-row-video-gif-group"]'
    );
    const mp4Group = win.locator(
      '[data-testid="psl-copy-row-video-mp4-group"]'
    );
    await expect(gifGroup.getByText("GIF", { exact: true })).toBeVisible();
    await expect(mp4Group.getByText("MP4", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("library-right-rail: video preset metrics populate exact dims on cache hit", async () => {
  // Verifies the lazy estimated-→-exact flow. `video:presetMetrics`
  // is dispatched on rail mount; cache-miss entries come back with
  // estimated bytes (rendered with a `~` prefix). After the user
  // clicks a card, the encode lands a cache row; the next mount
  // returns exact metrics for that combination. This test calls the
  // verb directly via the E2E bridge to assert the IPC envelope
  // shape without paying for an actual ffmpeg encode in CI.
  const app = await launchPwrSnap();
  try {
    const captureId = await seedVideoCapture(app);
    const result = await app.dispatch("video:presetMetrics", { captureId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Six entries — 2 formats × 3 presets.
    expect(result.value.metrics).toHaveLength(6);

    const byKey = new Map<string, (typeof result.value.metrics)[number]>();
    for (const m of result.value.metrics) {
      byKey.set(`${m.format}-${m.preset}`, m);
    }
    expect([...byKey.keys()].sort()).toEqual([
      "gif-high",
      "gif-low",
      "gif-med",
      "mp4-high",
      "mp4-low",
      "mp4-med"
    ]);

    // Source is seeded at 1440×960 by `seedVideoCapture` below.
    // MP4 LOW = 720px wide, MP4 HIGH = source (1440). GIF LOW =
    // 480, GIF MED + HIGH both cap at 720 (GIF byte sizes get
    // unusable above 720p — HIGH means "smoother fps", not "more
    // pixels"). Sanity-check that the per-preset width math
    // (computeOutputDimensions + GIF_PRESETS / MP4_PRESETS) lines
    // up with the canonical encoder spec.
    expect(byKey.get("mp4-low")!.widthPx).toBe(720);
    expect(byKey.get("mp4-high")!.widthPx).toBe(1440);
    expect(byKey.get("gif-low")!.widthPx).toBe(480);
    expect(byKey.get("gif-med")!.widthPx).toBe(720);
    expect(byKey.get("gif-high")!.widthPx).toBe(720);

    // Cold cache — every entry should report fromCache=false.
    for (const m of result.value.metrics) {
      expect(m.fromCache).toBe(false);
      expect(m.byteSize).toBeGreaterThan(0);
    }
  } finally {
    await app.close();
  }
});

// Note on coverage: the click-copy / click-path / drag-out paths
// aren't asserted end-to-end here because `seedVideoCapture` writes
// a placeholder .mp4 (literal "fake mp4 placeholder bytes") that
// ffmpeg can't decode. End-to-end coverage of those paths requires
// a real video fixture (e.g. generating a 1-second test clip via
// ffmpeg in a beforeAll) and is tracked as a follow-up in #136's
// "real-video fixture" TODO. The structural assertions above plus
// the validator + bus-envelope tests cover the contract; the
// renderer hook tests cover the click → dispatch transition.

test("library-right-rail: video:export rejects unknown preset values", async () => {
  // Validator coverage — main rejects malformed preset strings
  // before reaching the encoder. Mirrors the existing format /
  // range / audio validators that the prior `video:export`
  // signature already had.
  const app = await launchPwrSnap();
  try {
    const captureId = await seedVideoCapture(app);
    const result = await app.dispatch("video:export", {
      captureId,
      format: "mp4",
      // @ts-expect-error — testing the runtime validator
      preset: "ultra",
      range: { start: 0, end: 1 }
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_preset");
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
