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

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import { openEditor, seedImageCapture, selectTool } from "./fixtures/editor";

test.setTimeout(90_000);

test("editor-sticky-tool: placing an arrow keeps arrow selected", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "sticky", sourceAppName: "Sticky Tool Spec" });
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

    // Wait for the layers:upsert round-trip to settle.
    await expectLayerCount(app, captureId, 1);

    // Sticky assertion: arrow is STILL the active tool.
    await expect(
      editorWindow.locator(
        '.psl__edit-toolbar button[data-tool="arrow"].is-active'
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
      const captureId = await seedImageCapture(app, { idPrefix: "sticky", sourceAppName: "Sticky Tool Spec" });
      const editorWindow = await openEditor(app, captureId);

      // Alt-click arrow.
      await editorWindow
        .locator('.psl__edit-toolbar button[data-tool="arrow"]')
        .click({ modifiers: ["Alt"] });
      await expect(
        editorWindow.locator(
          '.psl__edit-toolbar button[data-tool="arrow"].is-active'
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
          '.psl__edit-toolbar button[data-tool="pointer"].is-active'
        )
      ).toHaveCount(1);
    } finally {
      await app.close();
    }
  }
);

// ---- Shared helpers --------------------------------------------------

async function expectLayerCount(
  app: LaunchedApp,
  captureId: string,
  count: number
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await app.dispatch("layers:list", { captureId });
      if (!result.ok) return -1;
      return result.value.length;
    })
    .toBe(count);
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
