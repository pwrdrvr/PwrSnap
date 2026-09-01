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

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type LaunchedApp, launchPwrSnap, test } from "./fixtures/electron-app";
import { seedImageCapture } from "./fixtures/editor";

test.setTimeout(120_000);

test("library-right-rail: renders Info/OCR/Chat vertical tabs with persistent footer", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "rightrail", sourceAppName: "Right Rail Spec" });
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

    // Switch to Chat. The Library rail now renders the live
    // LibraryChatPanel (testid "library-chat-panel"), not the editor's
    // ChatPanel. With no Codex configured in CI, the thread list comes
    // back empty (filesystem-only — no codex spawn), so the panel
    // settles into its greeting + composer state. Assert the panel and
    // its composer are both present.
    await win.locator('[data-testid="psl-right-tab-chat"]').click();
    await win
      .locator('[data-testid="library-chat-panel"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(
      win.locator('[data-testid="composer-root"]')
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
    const captureId = await seedImageCapture(app, { idPrefix: "rightrail", sourceAppName: "Right Rail Spec" });
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

    // Focus mode deliberately does not advertise primary+1..6: the shared
    // grid is presentational, and the Library's single numbered-shortcut
    // owner is active only in Grid mode. A visible hint here would promise a
    // chord that this surface does not own.
    await expect(gifRow.locator(".fo__copy-kbd")).toHaveCount(0);
    await expect(mp4Row.locator(".fo__copy-kbd")).toHaveCount(0);

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

test("library-right-rail: a trim refresh keeps an off-page video in Focus", async () => {
  // A normal grid edit can open a record from page 2. `useLibrary` then
  // reloads only page 1 for every captures-changed event. Persisting a trim
  // emits that event, so Focus must retain its opened record while page 2 is
  // temporarily absent from the paginated snapshot.
  // Wide enough (>1024px) to keep the toolbar in its `wide` tier, which
  // keeps the inspector EFFECTIVELY pinned. Below that the rail collapses
  // and the floating grid copy palette takes over as the copy surface —
  // and when its anchored tile is virtualized away (this test jumps to the
  // bottom of 100+ rows, leaving the selected newest capture off screen)
  // the palette parks bottom-center, directly over the last row. That is
  // the video tile this test hovers, so the palette intercepted the
  // pointer and the hover timed out on the Windows runner, whose default
  // window width fell under the threshold. The palette is not what this
  // test is about; give the rail room instead.
  const app = await launchPwrSnap({ windowSize: { width: 1280, height: 900 } });
  try {
    const captureId = await seedVideoCapture(app, {
      capturedAt: new Date(Date.now() - 60_000).toISOString()
    });
    const win = app.window;

    await app.electronApp.evaluate((_electron) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: { seedCaptures: (inputs: Record<string, unknown>[]) => void };
        }
      ).__PWRSNAP_TEST__;
      const now = Date.now();
      bridge.seedCaptures(
        Array.from({ length: 101 }, (_, index) => ({
          id: `trim-page-one-${index.toString().padStart(3, "0")}`,
          kind: "image",
          captured_at: new Date(now + index * 1_000).toISOString(),
          source_app_bundle_id: "com.test.spec",
          source_app_name: "Trim pagination spec",
          legacy_src_path: null,
          width_px: 1,
          height_px: 1,
          device_pixel_ratio: 1,
          byte_size: 1,
          sha256: `trim-page-one-${index}`
        }))
      );
    });
    await broadcastCapturesChanged(app);

    await win.locator('.psl[data-mode="grid"] .psl__cell[data-cell-id]').first().waitFor({
      state: "visible",
      timeout: 15_000
    });
    await win.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".psl__grid-wrap");
      if (grid === null) throw new Error("grid wrap missing");
      grid.scrollTop = grid.scrollHeight;
      grid.dispatchEvent(new Event("scroll"));
    });

    const videoCell = win.locator(`.psl__cell[data-cell-id="${captureId}"]`);
    await videoCell.waitFor({ state: "visible", timeout: 15_000 });
    // Edit is a hover-revealed tile affordance: at rest its reserved slot is
    // intentionally pointer-transparent so clicking the thumbnail selects
    // the capture instead. Reproduce the real interaction before targeting
    // the CTA directly.
    //
    // Retried as a unit because the grid is virtualized and this test jams
    // scrollTop to the bottom of 100+ rows: the row can still be settling
    // when we arrive, and a bare `hover()` waits for the element to be
    // "visible and stable" — two CONSECUTIVE animation frames with an
    // identical box. On the Windows runner that never caught a quiet pair
    // and timed out at 30s while macOS and Linux passed. Each attempt
    // re-reads the row's position instead of betting on one snapshot, and
    // the click keeps its full actionability checks, so what the test
    // proves is unchanged.
    await expect(async () => {
      await videoCell.hover({ timeout: 5_000 });
      await videoCell.locator(".psl__cell-edit").click({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await win.locator('.psl[data-mode="focus"]').waitFor({ state: "visible", timeout: 15_000 });

    // A second window can broadcast as soon as Focus renders, before a
    // passive effect gets a chance to mirror state into openedRecordsRef.
    const persisted = await app.dispatch("video:setDefaultRange", {
      captureId,
      range: { start: 0.25, end: 1.5 }
    });
    expect(persisted.ok).toBe(true);
    await expect(win.locator('.psl[data-mode="focus"]')).toBeVisible({ timeout: 5_000 });
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
    // MP4 LOW = 720, MP4 HIGH = source (1440). GIF LOW = 480,
    // GIF MED = 540 (intermediate qHD-tier; geometric midpoint
    // between LOW and HIGH for byte size), GIF HIGH = 720 (capped
    // — beyond 720p GIFs become unusable). Sanity-check that the
    // per-preset width math (computeOutputDimensions +
    // GIF_PRESETS / MP4_PRESETS) lines up with the canonical
    // encoder spec.
    expect(byKey.get("mp4-low")!.widthPx).toBe(720);
    expect(byKey.get("mp4-high")!.widthPx).toBe(1440);
    expect(byKey.get("gif-low")!.widthPx).toBe(480);
    expect(byKey.get("gif-med")!.widthPx).toBe(540);
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

async function broadcastCapturesChanged(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate((electronModule) => {
    const { BrowserWindow } = electronModule;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("events:captures:changed", { changedIds: [] });
    }
  });
}

async function seedVideoCapture(
  app: LaunchedApp,
  options: { capturedAt?: string } = {}
): Promise<string> {
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
    (_electron, payload: { id: string; mp4Path: string; capturedAt: string }) => {
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
        captured_at: payload.capturedAt,
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
    { id: captureId, mp4Path, capturedAt: options.capturedAt ?? new Date().toISOString() }
  );
  return captureId;
}
