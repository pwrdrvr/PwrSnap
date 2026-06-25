// Shared editor E2E helpers — seed an image capture, open it in the
// editor, and select a tool. These three steps were copy-pasted into
// nearly every `editor-*.spec.ts`; the `openEditor` / `selectTool`
// copies were byte-identical and `seedCapture` differed only in dims +
// names. Centralizing keeps the test-bridge shape (the
// `__PWRSNAP_TEST__.seedCapture` payload) in one place so a bridge
// change doesn't have to be chased across a dozen specs.
//
// Migration status: new specs should import from here. Existing specs
// still carry their own copies; migrate them opportunistically (they're
// functionally equivalent to these).

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { LaunchedApp } from "./electron-app";

/** 1×1 transparent PNG — enough for captures whose pixels the spec
 *  doesn't assert on (it only needs a real file on disk + a DB row). */
const ONE_BY_ONE_PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082";

export interface SeedImageCaptureOptions {
  /** Prefix for the generated capture id (e.g. "text-outline"). Helps
   *  identify which spec seeded a row when debugging a shared DB. */
  idPrefix?: string;
  /** `source_app_name` written on the row. Defaults to "E2E Spec". */
  sourceAppName?: string;
  /** Canvas pixel dims. Default 800×600. */
  widthPx?: number;
  heightPx?: number;
}

/** Seed an image capture via the test bridge and return its id. */
export async function seedImageCapture(
  app: LaunchedApp,
  opts: SeedImageCaptureOptions = {}
): Promise<string> {
  const {
    idPrefix = "e2e",
    sourceAppName = "E2E Spec",
    widthPx = 800,
    heightPx = 600
  } = opts;
  const dir = await mkdtemp(path.join(os.tmpdir(), `pwrsnap-${idPrefix}-spec-`));
  const pngPath = path.join(dir, "fixture.png");
  const pngBytes = Buffer.from(ONE_BY_ONE_PNG_HEX, "hex");
  await writeFile(pngPath, pngBytes);

  const captureId = `${idPrefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await app.electronApp.evaluate(
    (
      _electron,
      payload: {
        id: string;
        pngPath: string;
        sourceAppName: string;
        widthPx: number;
        heightPx: number;
      }
    ) => {
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
        source_app_name: payload.sourceAppName,
        legacy_src_path: payload.pngPath,
        width_px: payload.widthPx,
        height_px: payload.heightPx,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id
      });
    },
    { id: captureId, pngPath, sourceAppName, widthPx, heightPx }
  );
  return captureId;
}

/** Open a capture in the editor (Library Focus surface) and wait for the
 *  toolbar to render. Returns the editor page. */
export async function openEditor(app: LaunchedApp, captureId: string): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok, "editor:open should succeed").toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('.psl__edit-toolbar button[data-tool="arrow"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

/** Click a toolbar tool and wait for it to become active. */
export async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`.psl__edit-toolbar button[data-tool="${tool}"]`).click();
  await expect(
    win.locator(`.psl__edit-toolbar button[data-tool="${tool}"].is-active`)
  ).toHaveCount(1);
}
