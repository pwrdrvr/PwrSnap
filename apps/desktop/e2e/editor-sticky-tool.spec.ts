// E2E coverage for the v2 editor Phase 1 sticky-tool semantics
// (task #11).
//
// Two behaviors under test:
//   1. Sticky default — placing an annotation does NOT auto-flip back
//      to pointer. The tool stays selected so the user can place
//      another shape without re-selecting from the toolbar.
//   2. ⌥-click single-shot — holding Alt while clicking a toolbar
//      button arms the next annotation as one-shot; after placement
//      the tool snaps back to pointer.
//
// State under test: `useEditorToolState.setActiveTool({ singleShot })`
// + `onAnnotationPlaced` single-shot reset branch. The unit tests for
// the hook cover the state machine; this spec proves the real toolbar
// → hook → canvas → hook pipeline.
//
// Both the standalone toolbar adapter (Editor.tsx) AND the Library
// `EditToolbar` honor ⌥-click → single-shot. The adapter chain is:
// inner EditorToolbar button onClick → outer onChange wrapper (line
// ~1016) → setTool(next, options) → useEditorToolState.setActiveTool.
// The wrapper now forwards `options` (was dropping it before the fix
// in this commit).

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

test.setTimeout(90_000);

test("editor-sticky-tool: placing an arrow keeps arrow selected", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const editorWindow = await openEditor(app, captureId);

    await selectTool(editorWindow, "arrow");

    // Find the canvas and drag from one point to another to place an
    // arrow. The canvas is the `.editor-canvas` element; the drag
    // emits `pointerdown` → `pointermove` → `pointerup` which the
    // editor's tool handler turns into an arrow overlay.
    const canvas = editorWindow.locator(".editor-canvas");
    await canvas.waitFor({ state: "visible" });
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return; // narrow

    await dragOnCanvas(
      editorWindow,
      { x: box.x + box.width * 0.2, y: box.y + box.height * 0.2 },
      { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 }
    );

    // Wait for the overlays:upsert round-trip to settle. The toolbar
    // reflects the overlay-count meta; we wait for it to bump as a
    // proxy for "the placement persisted".
    await expect(
      editorWindow.locator(".editor-toolbar-meta span").first()
    ).toContainText(/1 overlay/);

    // Sticky assertion: arrow is STILL the active tool.
    await expect(
      editorWindow.locator(
        '[data-testid="editor-tool-button-arrow"].is-active'
      )
    ).toHaveCount(1);
  } finally {
    await app.close();
  }
});

// ⌥-click single-shot: clicking with Alt arms one-shot mode on the
// hook (places one annotation, snaps back to Pointer). Library
// `EditToolbar.tsx` and the standalone toolbar adapter both forward
// the `options` arg now. The hook unit-level behavior is also covered
// by `useEditorToolState.test.ts` → "⌥-click single-shot returns to
// pointer".
test(
  "editor-sticky-tool: alt-click on toolbar button arms single-shot",
  async () => {
    const app = await launchPwrSnap();
    try {
      const captureId = await seedCapture(app);
      const editorWindow = await openEditor(app, captureId);

      // Alt-click arrow.
      await editorWindow
        .locator('[data-testid="editor-tool-button-arrow"]')
        .click({ modifiers: ["Alt"] });
      await expect(
        editorWindow.locator(
          '[data-testid="editor-tool-button-arrow"].is-active'
        )
      ).toHaveCount(1);

      const canvas = editorWindow.locator(".editor-canvas");
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) return;

      await dragOnCanvas(
        editorWindow,
        { x: box.x + box.width * 0.2, y: box.y + box.height * 0.2 },
        { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 }
      );

      // Single-shot returns to pointer.
      await expect(
        editorWindow.locator(
          '[data-testid="editor-tool-button-pointer"].is-active'
        )
      ).toHaveCount(1);
    } finally {
      await app.close();
    }
  }
);

// ---- Shared helpers --------------------------------------------------

async function seedCapture(app: LaunchedApp): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-sticky-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `sticky-${Date.now().toString(36)}-${Math.random()
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
        source_app_name: "Sticky Tool Spec",
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

async function openEditor(app: LaunchedApp, captureId: string): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok).toBe(true);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const candidate of app.electronApp.windows()) {
      const url = candidate.url();
      if (url.includes("stage=edit") && url.includes(captureId)) {
        await candidate.waitForLoadState("domcontentloaded").catch(() => undefined);
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

async function selectTool(win: Page, tool: string): Promise<void> {
  await win.locator(`[data-testid="editor-tool-button-${tool}"]`).click();
  await expect(
    win.locator(`[data-testid="editor-tool-button-${tool}"].is-active`)
  ).toHaveCount(1);
}

/**
 * Simulate a pointer drag on the canvas. The editor's pointer handlers
 * use the React synthetic pointer events; Playwright's `mouse.down/
 * move/up` route through the underlying CDP and Chromium synthesizes
 * matching pointer events. A small intermediate move step keeps the
 * drag from being treated as a click-with-zero-distance (which the
 * editor's MIN_DRAG_LENGTH filter would otherwise drop).
 */
async function dragOnCanvas(
  win: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  // Two-step move so the renderer's `pointermove` fires at least once.
  await win.mouse.move(
    from.x + (to.x - from.x) / 2,
    from.y + (to.y - from.y) / 2,
    { steps: 5 }
  );
  await win.mouse.move(to.x, to.y, { steps: 5 });
  await win.mouse.up();
}
