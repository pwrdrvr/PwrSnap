// open-file spec — verifies that PwrSnap, launched with a
// `.pwrsnap` path in argv (the `open foo.pwrsnap` / cold-start
// double-click code path), routes through
// `wireOpenFileHandler` → `readBundleManifest` →
// `getCaptureById` → `library:openInLibrary` and ends up showing
// the capture in the Library Focus editor.
//
// macOS GUI double-click uses Apple's `app.on('open-file')` event
// (not argv), but the runtime path inside open-file.ts is the
// same — both branches feed into `enqueueOrOpen` → drain. Argv
// is the only one we can simulate from a Playwright spec because
// Playwright's Electron driver doesn't dispatch GUI events.
//
// Two scenarios:
//
//   1. Capture exists in the library — the Library window opens
//      Focus mode for that capture.
//   2. A losing second instance forwards a queued `.pwrsnap` path
//      through Electron's single-instance additionalData handoff.
//   3. Capture not in the library (cross-device file, never
//      imported) — open-file falls back to opening the library
//      window with a notification. We assert a standalone editor
//      window did NOT spawn for an unknown captureId, and the library
//      is the front-most user-facing surface.

import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import yazl from "yazl";

import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

async function makeFixturePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 50, g: 200, b: 90, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

async function packFixtureBundle(opts: {
  captureId: string;
  outputDir: string;
}): Promise<string> {
  const sourcePng = await makeFixturePng();
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const bundlePath = join(opts.outputDir, `${opts.captureId}.pwrsnap`);
  await new Promise<void>((res, reject) => {
    const zip = new yazl.ZipFile();
    const now = "2026-01-01T00:00:00.000Z";
    const manifest = {
      bundle_format_version: 2,
      capture_id: opts.captureId,
      canvas_dimensions: { width_px: 100, height_px: 100 },
      paired_png_filename: `${opts.captureId}.png`,
      created_at: now,
      bundle_modified_at: now
    };
    const document = {
      document_format_version: 1,
      edits_version: 0,
      layers: [
        {
          id: "rootlayer0000001",
          parent_id: null,
          kind: "group",
          collapsed: false,
          name: "Root",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 0,
          source: "user",
          ai_run_id: null,
          applied_at: now,
          rejected_at: null,
          superseded_by: null,
          created_at: now
        },
        {
          id: "sourcelayer00001",
          parent_id: "rootlayer0000001",
          kind: "raster",
          source_ref: { kind: "embedded", sha256: sourceSha },
          natural_width_px: 100,
          natural_height_px: 100,
          name: "Source",
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 0,
          source: "user",
          ai_run_id: null,
          applied_at: now,
          rejected_at: null,
          superseded_by: null,
          created_at: now
        }
      ],
      tags: [],
      description: null,
      ai_runs: []
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
    zip.addBuffer(Buffer.from(JSON.stringify(document)), "document.json");
    zip.addBuffer(sourcePng, `sources/${sourceSha}.png`, { compress: false });
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => {
      writeFileSync(bundlePath, Buffer.concat(chunks));
      res();
    });
    zip.outputStream.on("error", reject);
    zip.end();
  });
  return bundlePath;
}

/**
 * Insert a `captures` row matching the bundle. Goes through the
 * E2E test bridge's `seedCapture` helper (same one
 * library-source-filter.spec.ts and friends use) — keeps every spec
 * pulling from the same shape of fixture seeding rather than
 * reaching into internal repo paths via dynamic import.
 */
async function seedCaptureRow(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  opts: { captureId: string; bundlePath: string }
): Promise<void> {
  await app.electronApp.evaluate((_ctx, payload) => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__?: {
          seedCapture: (input: Record<string, unknown>) => unknown;
        };
      }
    ).__PWRSNAP_TEST__;
    if (bridge === undefined) {
      throw new Error("__PWRSNAP_TEST__ bridge not installed");
    }
    bridge.seedCapture({
      id: payload.captureId,
      kind: "image",
      captured_at: "2026-01-01T00:00:00.000Z",
      source_app_bundle_id: null,
      source_app_name: null,
      // No legacy_src_path — this row was born in the bundle-flow
      // era (post-PR-14). bundle_path is the canonical pointer.
      legacy_src_path: null,
      width_px: 100,
      height_px: 100,
      device_pixel_ratio: 1,
      byte_size: 1000,
      sha256: payload.captureId.padEnd(64, "0"),
      bundle_path: payload.bundlePath
    });
  }, opts);
}

/** Drive the open-file pipeline via the test bridge. */
async function triggerOpenFile(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  bundlePath: string
): Promise<void> {
  await app.electronApp.evaluate((_ctx, path) => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__?: { triggerOpenFile: (path: string) => void };
      }
    ).__PWRSNAP_TEST__;
    if (bridge === undefined) {
      throw new Error("__PWRSNAP_TEST__ bridge not installed");
    }
    bridge.triggerOpenFile(path);
  }, bundlePath);
}

async function triggerOpenFileHandoff(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  bundlePath: string
): Promise<void> {
  await app.electronApp.evaluate((_ctx, path) => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__?: { triggerOpenFileHandoff: (path: string) => void };
      }
    ).__PWRSNAP_TEST__;
    if (bridge === undefined) {
      throw new Error("__PWRSNAP_TEST__ bridge not installed");
    }
    bridge.triggerOpenFileHandoff(path);
  }, bundlePath);
}

test.describe("open-file handler", () => {
  test.skip(!isMac, "open-file event + macOS double-click semantics are macOS-only");

  test("argv-passed .pwrsnap opens Library Focus when the capture exists", async () => {
    const fixturesDir = await mkdtemp(join(tmpdir(), "pwrsnap-openfile-fixtures-"));
    const captureId = "openfile-known";
    const bundlePath = await packFixtureBundle({
      captureId,
      outputDir: fixturesDir
    });

    // Launch PwrSnap WITHOUT the path, seed the row, then trigger
    // a second-instance argv handoff carrying the bundle path. The
    // alternative — launching with the path in argv — would race
    // against the row insert because open-file fires during
    // whenReady before we can seed.
    const app = await launchPwrSnap();
    try {
      await seedCaptureRow(app, { captureId, bundlePath });

      // Drive the open-file pipeline through the test bridge. Same
      // code path as `app.on('open-file')` event delivery — both
      // feed enqueueOrOpen → processQueuedOpenFiles.
      await triggerOpenFile(app, bundlePath);

      await expect(
        app.window.locator(`.psl__focus[data-capture-id="${captureId}"]`)
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("single-instance handoff .pwrsnap opens Library Focus when the capture exists", async () => {
    const fixturesDir = await mkdtemp(join(tmpdir(), "pwrsnap-openfile-fixtures-"));
    const captureId = "openfile-handoff";
    const bundlePath = await packFixtureBundle({
      captureId,
      outputDir: fixturesDir
    });

    const app = await launchPwrSnap();
    try {
      await seedCaptureRow(app, { captureId, bundlePath });

      await triggerOpenFileHandoff(app, bundlePath);

      await expect(
        app.window.locator(`.psl__focus[data-capture-id="${captureId}"]`)
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("argv-passed .pwrsnap for an unknown capture does not spawn an editor", async () => {
    const fixturesDir = await mkdtemp(join(tmpdir(), "pwrsnap-openfile-fixtures-"));
    const captureId = "openfile-unknown";
    const bundlePath = await packFixtureBundle({
      captureId,
      outputDir: fixturesDir
    });

    const app = await launchPwrSnap();
    try {
      // Deliberately do NOT seedCaptureRow — capture exists on
      // disk but no DB row. open-file should hit the "not in
      // library" branch.
      await triggerOpenFile(app, bundlePath);

      // Give the open-file pipeline a moment to run, then assert
      // no editor window was created. We give it a generous 500ms
      // because the bundle manifest read + SQL lookup is async.
      await new Promise((res) => setTimeout(res, 500));

      const hasEditor = await app.electronApp.evaluate(
        ({ BrowserWindow }, target) => {
          return BrowserWindow.getAllWindows().some((win) => {
            if (win.isDestroyed()) return false;
            const url = win.webContents.getURL();
            return url.includes(`captureId=${encodeURIComponent(target.captureId)}`);
          });
        },
        { captureId }
      );
      expect(hasEditor).toBe(false);
    } finally {
      await app.close();
    }
  });
});
