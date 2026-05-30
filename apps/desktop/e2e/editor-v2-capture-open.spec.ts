// E2E coverage for the v2 editor read path. Proves that
// `useCaptureModel` opens a v2 capture through `layers:list`:
//
//   1. v2 captures (seeded with `bundle_format_version: 2`) open through
//      `layers:list`. The editor mounts the canvas + image + toolbar;
//      `.editor-root` carries `data-bundle-format-version="2"`.
//   2. ⌘Z on a freshly-opened v2 capture is safe: the undo button is
//      disabled (nothing to undo) and the shortcut doesn't crash the
//      renderer or wedge the editor in an error state.
//
// The former "v1 capture opens through `overlays:list`" scenario was
// dropped when the v1 read/write path was retired — v2 is the only
// bundle format and the renderer no longer dispatches any `overlays:*`
// verb.
//
// Selectors used (all data-testid; additive only):
//   - editor-root            → `.editor-root` wrapper; carries
//                              `data-bundle-format-version="1"|"2"`.
//   - editor-image           → the `<img>` of the capture.
//   - editor-loading         → loading placeholder (transient).
//   - editor-error           → error banner; assert NOT visible.
//   - editor-undo            → toolbar undo button.
//   - editor-tool-button-*   → Phase 1 testid family, used to confirm
//                              the toolbar mounted.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

// First spec in this file cold-starts Electron; subsequent specs reuse
// the warm pnpm-store cache. 90s mirrors editor-tool-styles.spec.ts.
test.setTimeout(90_000);

test("editor-v2-capture-open: v2 capture opens with format=2, no v2-not-supported error", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app, { bundleFormatVersion: 2 });
    const editorWindow = await openEditor(app, captureId);

    // The editor mounted — image + toolbar visible.
    await expect(
      editorWindow.locator('[data-testid="editor-image"]')
    ).toBeVisible();
    await expect(
      editorWindow.locator('[data-testid="editor-tool-button-arrow"]')
    ).toBeVisible();

    // Format attribute on the root reads "2" (the v2 read path branch
    // through `layers:list`).
    await expect(
      editorWindow.locator('[data-testid="editor-root"]')
    ).toHaveAttribute("data-bundle-format-version", "2");

    // No error banner — the editor did NOT refuse the v2 capture. The
    // editor routes to `layers:list` and shows the canvas.
    await expect(
      editorWindow.locator('[data-testid="editor-error"]')
    ).toHaveCount(0);

    // Sanity check the IPC contract directly: layers:list must succeed
    // (returns [] — fresh capture).
    const layersResult = await app.dispatch("layers:list", { captureId });
    expect(layersResult.ok).toBe(true);
    if (layersResult.ok) expect(layersResult.value).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("editor-v2-capture-open: ⌘Z on a freshly-opened v2 capture is a no-op (button disabled, no crash)", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app, { bundleFormatVersion: 2 });
    const editorWindow = await openEditor(app, captureId);

    // Toolbar mounted; undo button is in the DOM and starts disabled
    // (fresh capture has no edit history). Note: the undo hook is
    // owned by EditorLoaded and only mounts for `chrome === "full"`
    // (standalone editor window) — Library Focus is chromeless, but
    // editor:open opens a standalone window so chrome === "full" here.
    const undoButton = editorWindow.locator('[data-testid="editor-undo"]');
    await expect(undoButton).toBeVisible();
    await expect(undoButton).toBeDisabled();

    // Fire ⌘Z anyway. The keyboard handler should be a safe no-op
    // (the undo hook's `canUndo` guard short-circuits when the stack
    // is empty). Crucially:
    //   - the renderer must NOT crash
    //   - the editor must NOT transition into the error state
    //   - the format attribute must still read "2" (no silent
    //     fallback to a v1 IPC family)
    await editorWindow.keyboard.press("Meta+Z");
    // Give the event loop a tick to surface any uncaught error.
    await editorWindow.waitForTimeout(150);

    await expect(
      editorWindow.locator('[data-testid="editor-error"]')
    ).toHaveCount(0);
    await expect(
      editorWindow.locator('[data-testid="editor-root"]')
    ).toHaveAttribute("data-bundle-format-version", "2");
    await expect(undoButton).toBeDisabled();
  } finally {
    await app.close();
  }
});

// ---- Shared helpers (mirror editor-tool-styles.spec.ts pattern) -----

type SeedOptions = {
  bundleFormatVersion: 2;
};

async function seedCapture(
  app: LaunchedApp,
  options: SeedOptions
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-v2-open-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  // Smallest-valid 1×1 transparent PNG. The renderer never decodes
  // the bytes for either format (the canvas <img> goes through the
  // pwrsnap-capture:// protocol handler), but the file has to exist
  // on disk for the protocol handler to stat it.
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `v2-open-${options.bundleFormatVersion}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  await app.electronApp.evaluate(
    (
      _electron,
      payload: { id: string; pngPath: string; bundleFormatVersion: number }
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
              bundle_format_version?: number;
            }) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.id,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.spec",
        source_app_name: "v2-Open Spec",
        legacy_src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id,
        bundle_format_version: payload.bundleFormatVersion
      });
    },
    {
      id: captureId,
      pngPath,
      bundleFormatVersion: options.bundleFormatVersion
    }
  );
  return captureId;
}

async function openEditor(app: LaunchedApp, captureId: string): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok, "editor:open should succeed").toBe(true);

  // Poll for the editor window — main may take a tick to construct it.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const candidate of app.electronApp.windows()) {
      const url = candidate.url();
      if (url.includes("stage=edit") && url.includes(captureId)) {
        await candidate
          .waitForLoadState("domcontentloaded")
          .catch(() => undefined);
        // Wait for the toolbar to mount (proof the renderer hydrated
        // past the `useCaptureModel` loading state into the loaded
        // branch). The toolbar only renders in the loaded branch —
        // loading/error branches show their own placeholder div.
        await candidate
          .locator('[data-testid="editor-tool-button-arrow"]')
          .waitFor({ state: "visible", timeout: 15_000 });
        return candidate;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("editor window never appeared");
}
