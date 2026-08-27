// open-file spec — verifies that PwrSnap, launched with a
// `.pwrsnap` path in argv (the `open foo.pwrsnap` / cold-start
// double-click code path), routes through
// `wireOpenFileHandler` → strict v2 validation/import →
// `library:openInLibrary` and ends up showing the capture in the
// Library Focus editor.
//
// macOS GUI double-click uses Apple's `app.on('open-file')` event, while
// Windows Explorer and Linux pass argv through the single-instance path. The
// Playwright bridge deliberately drives the shared argv/handoff pipeline on
// every platform; only a future test that dispatches a real NSAppleEvent should
// carry a macOS-only guard.
//
// Two scenarios:
//
//   1. Capture exists in the library — the Library window opens
//      Focus mode for that capture.
//   2. A losing second instance forwards a queued `.pwrsnap` path
//      through Electron's single-instance additionalData handoff.
//   3. Capture not in the library (cross-device file) — open-file
//      imports an app-owned copy and opens it in Focus mode.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import yazl from "yazl";

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";

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
}): Promise<{ bundlePath: string; sourceSha: string }> {
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
  return { bundlePath, sourceSha };
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
  opts: { captureId: string; bundlePath: string; sourceSha: string }
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
      sha256: payload.sourceSha,
      bundle_path: payload.bundlePath,
      bundle_format_version: 2,
      bundle_edits_version: 0
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
  test("argv-passed .pwrsnap opens Library Focus when the capture exists", async () => {
    const fixturesDir = await realpath(
      await mkdtemp(join(tmpdir(), "pwrsnap-openfile-fixtures-"))
    );
    const captureId = "openfile-known";
    const { bundlePath, sourceSha } = await packFixtureBundle({
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
      await seedCaptureRow(app, { captureId, bundlePath, sourceSha });

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
    const fixturesDir = await realpath(
      await mkdtemp(join(tmpdir(), "pwrsnap-openfile-fixtures-"))
    );
    const captureId = "openfile-handoff";
    const { bundlePath, sourceSha } = await packFixtureBundle({
      captureId,
      outputDir: fixturesDir
    });

    const app = await launchPwrSnap();
    try {
      await seedCaptureRow(app, { captureId, bundlePath, sourceSha });

      await triggerOpenFileHandoff(app, bundlePath);

      await expect(
        app.window.locator(`.psl__focus[data-capture-id="${captureId}"]`)
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("argv-passed foreign .pwrsnap imports and opens Library Focus", async () => {
    const fixturesDir = await realpath(
      await mkdtemp(join(tmpdir(), "pwrsnap-openfile-fixtures-"))
    );
    const captureId = "openfile-unknown";
    const { bundlePath } = await packFixtureBundle({
      captureId,
      outputDir: fixturesDir
    });
    const sourceBefore = await readFile(bundlePath);

    const app = await launchPwrSnap();
    try {
      // Deliberately do NOT seedCaptureRow: this is a cross-device
      // bundle with no local DB relationship.
      await triggerOpenFile(app, bundlePath);

      await expect(
        app.window.locator(`.psl__focus[data-capture-id="${captureId}"]`)
      ).toBeVisible();

      const importedPath = await app.electronApp.evaluate(async (_ctx, id) => {
        const bridge = (
          globalThis as unknown as {
            __PWRSNAP_TEST__?: {
              dispatch: (
                name: string,
                req: unknown
              ) => Promise<{
                ok: boolean;
                value?: { bundle_path: string | null } | null;
              }>;
            };
          }
        ).__PWRSNAP_TEST__;
        if (bridge === undefined) return null;
        const result = await bridge.dispatch("library:byId", { id });
        return result.ok ? (result.value?.bundle_path ?? null) : null;
      }, captureId);
      expect(importedPath).not.toBeNull();
      expect(importedPath).not.toBe(bundlePath);
      await expect(readFile(bundlePath)).resolves.toEqual(sourceBefore);
    } finally {
      await app.close();
    }
  });
});
