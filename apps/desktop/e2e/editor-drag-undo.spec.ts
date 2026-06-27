// Regression E2E for the live-drag override masking undo.
//
// Repro: move a layer with the mouse, then ⌘Z. The bug — v2
// `updateGeometry` PRESERVES the layer id, so the old "clear the live
// override once its row id disappears" cleanup never fired; the stale
// override kept painting the dragged position, so the glyph stayed put
// after undo (while the selection outline / hit-test reverted). This
// asserts the rendered glyph returns to its original position on undo.
//
// The unit-level guard for the cleanup logic itself lives in
// draft-geometry.test.ts (pruneLandedDraftGeometry); this is the
// end-to-end "the glyph actually moves back" check.

import { expect, test, type Locator } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import {
  accel,
  drawAnnotation,
  drawOnCanvas,
  expectLayerCount,
  openEditorFocus,
  seedImageCapture,
  selectTool
} from "./fixtures/editor-helpers";

test.setTimeout(120_000);

test("editor-drag-undo: moving a layer then ⌘Z returns the glyph to its original position", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openFocus(app, captureId);

    // A filled highlight gives a big, reliable click/drag target and
    // renders as a single <rect> we can measure.
    await selectTool(win, "highlight");
    await drawOnCanvas(win);
    await expectLayerCount(app, captureId, 1);

    const glyph = win.locator('[data-testid="persisted-glyph-svg"] rect').first();
    await glyph.waitFor({ state: "attached", timeout: 5_000 });
    const boxA = await stableBox(glyph);

    // Select, then body-drag the highlight to a new spot.
    const canvas = win.locator(".editor-canvas");
    const cbox = await canvas.boundingBox();
    expect(cbox).not.toBeNull();
    if (cbox === null) return;
    const cx = cbox.x + cbox.width * 0.4;
    const cy = cbox.y + cbox.height * 0.4;
    await win.mouse.click(cx, cy); // select (handles appear)
    await win.mouse.move(cx, cy);
    await win.mouse.down();
    await win.mouse.move(cx + cbox.width * 0.12, cy + cbox.height * 0.1, { steps: 6 });
    await win.mouse.move(cx + cbox.width * 0.22, cy + cbox.height * 0.16, { steps: 6 });
    await win.mouse.up();

    const boxB = await stableBox(glyph);
    // The move actually happened (glyph shifted right by a real margin).
    expect(boxB.x - boxA.x).toBeGreaterThan(8);

    // Undo. The glyph must snap back to ~its original position — not stay
    // at the moved position because a stale override masked the revert.
    await win.keyboard.press(`${accel()}+Z`);
    const boxUndo = await stableBox(glyph);
    expect(Math.abs(boxUndo.x - boxA.x)).toBeLessThan(6);
    expect(boxB.x - boxUndo.x).toBeGreaterThan(8);
  } finally {
    await app.close();
  }
});

test("editor-drag-undo: releasing a body-drag OUTSIDE the canvas still commits and clips (no ghost override)", async () => {
  // Repro for the off-canvas drag bug: dragging a layer partially off
  // the viewport means releasing the cursor outside the canvas. The
  // clamped client→normalized helper returned null there, so the commit
  // was skipped AND the live override was left in place — the layer
  // never moved in DATA, but a ghost copy painted off-canvas, never
  // clipped, and masked undo. Asserts the move COMMITS (geometry
  // changes) and the glyph CLIPS (override cleared → overflow hidden).
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openFocus(app, captureId);

    // A highlight lands as an EFFECT layer (clip_rect in px), which is
    // exactly the case the px round-trip used to break — the override
    // never matched the persisted clip_rect and lingered (no clip,
    // masked undo).
    await selectTool(win, "highlight");
    await drawOnCanvas(win);
    await expectLayerCount(app, captureId, 1);
    const rectXBefore = await firstAnnotationX(app, captureId);
    expect(rectXBefore).not.toBeNull();

    // Select the layer and wait for the transform handles (confirms the
    // selection landed before we start the body-drag).
    await selectTool(win, "pointer");
    const canvas = win.locator(".editor-canvas");
    const cbox = await canvas.boundingBox();
    expect(cbox).not.toBeNull();
    if (cbox === null) return;
    await win.mouse.click(cbox.x + cbox.width * 0.4, cbox.y + cbox.height * 0.4);
    const body = win.locator('[data-testid="transform-handle-body"]');
    await body.waitFor({ state: "visible", timeout: 5_000 });
    const bbox = await body.boundingBox();
    expect(bbox).not.toBeNull();
    if (bbox === null) return;

    // Drag the body to the right and release PAST the right edge — the
    // cursor ends OUTSIDE the canvas.
    const sx = bbox.x + bbox.width / 2;
    const sy = bbox.y + bbox.height / 2;
    await win.mouse.move(sx, sy);
    await win.mouse.down();
    await win.mouse.move(sx + cbox.width * 0.25, sy, { steps: 6 });
    await win.mouse.move(cbox.x + cbox.width + 80, sy, { steps: 6 });
    await win.mouse.up();

    // The move committed — the layer's geometry actually changed (it was
    // dragged well to the right), not left as a ghost override with the
    // persisted data untouched.
    await expect
      .poll(async () => (await firstAnnotationX(app, captureId)) ?? -1e9)
      .toBeGreaterThan(rectXBefore! + 0.05);

    // And the glyph clips to the canvas — the override cleared, so the
    // resting committed glyph renders overflow:hidden.
    const glyph = win.locator('[data-testid="persisted-glyph-svg"]').first();
    await glyph.waitFor({ state: "attached", timeout: 5_000 });
    await expect(glyph).toHaveAttribute("overflow", "hidden");
  } finally {
    await app.close();
  }
});

test("editor-drag-undo: MULTI-select body-drag released OUTSIDE the canvas commits every layer", async () => {
  // With 2+ layers selected there is no per-layer transform-handle-body,
  // so a body-drag goes through the editor's MULTI-DRAG path (the canvas
  // pointer handlers) rather than TransformHandles. That path read the
  // release point through the CLAMPED client→normalized helper, which
  // returns null off-canvas — so a multi-select drag released past the
  // edge skipped the commit and stranded a stale override. This exercises
  // exactly that path (the single-select OUTSIDE test above does not).
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);
    const win = await openFocus(app, captureId);

    // Two shapes (vectors → shape.rect.x is directly comparable).
    await selectTool(win, "shape");
    await drawAnnotation(win, 0.15, 0.3, 0.32, 0.5);
    await drawAnnotation(win, 0.4, 0.3, 0.57, 0.5);
    await expectLayerCount(app, captureId, 2);
    const xsBefore = await allVectorRectXs(app, captureId);
    expect(xsBefore.length).toBe(2);

    // Select BOTH (click one, ⌘/Ctrl-click the other).
    await selectTool(win, "pointer");
    const canvas = win.locator(".editor-canvas");
    const cbox = await canvas.boundingBox();
    expect(cbox).not.toBeNull();
    if (cbox === null) return;
    const p1 = { x: cbox.x + cbox.width * 0.235, y: cbox.y + cbox.height * 0.4 };
    const p2 = { x: cbox.x + cbox.width * 0.485, y: cbox.y + cbox.height * 0.4 };
    await win.mouse.click(p1.x, p1.y);
    await win.keyboard.down(accel());
    await win.mouse.click(p2.x, p2.y);
    await win.keyboard.up(accel());

    // Body-drag the group from inside the first shape, releasing PAST the
    // right edge — outside the canvas.
    await win.mouse.move(p1.x, p1.y);
    await win.mouse.down();
    await win.mouse.move(p1.x + cbox.width * 0.2, p1.y, { steps: 6 });
    await win.mouse.move(cbox.x + cbox.width + 80, p1.y, { steps: 6 });
    await win.mouse.up();

    // EVERY selected layer moved right (the off-canvas release committed
    // the whole group), not just left as ghost overrides.
    await expect
      .poll(async () => {
        const xs = await allVectorRectXs(app, captureId);
        if (xs.length < 2) return false;
        return xs.every((x, i) => x > xsBefore[i]! + 0.05);
      })
      .toBe(true);
  } finally {
    await app.close();
  }
});

/** All vector layers' rect.x, in layer order — for asserting a group
 *  drag moved every selected shape. */
async function allVectorRectXs(
  app: LaunchedApp,
  captureId: string
): Promise<number[]> {
  const result = await app.dispatch("layers:list", { captureId });
  if (!result.ok) return [];
  const xs: number[] = [];
  for (const layer of result.value as Array<{
    kind: string;
    shape?: { rect?: { x: number } };
  }>) {
    if (layer.kind === "vector" && layer.shape?.rect !== undefined) {
      xs.push(layer.shape.rect.x);
    }
  }
  return xs;
}

/** The x-position of the first drawn annotation — works whether it
 *  landed as a VECTOR (shape.rect, normalized) or an EFFECT (clip_rect,
 *  absolute px). Dragging it right increases x either way. Null until
 *  the layer lands. */
async function firstAnnotationX(
  app: LaunchedApp,
  captureId: string
): Promise<number | null> {
  const result = await app.dispatch("layers:list", { captureId });
  if (!result.ok) return null;
  for (const layer of result.value as Array<{
    kind: string;
    shape?: { rect?: { x: number } };
    clip_rect?: { x: number } | null;
  }>) {
    if (layer.kind === "vector" && layer.shape?.rect !== undefined) {
      return layer.shape.rect.x;
    }
    if (layer.kind === "effect" && layer.clip_rect != null) {
      return layer.clip_rect.x;
    }
  }
  return null;
}

/** Read an element's bounding box, polling until two consecutive reads
 *  agree — so we measure AFTER the dispatch → broadcast → refetch (and
 *  the override cleanup) have settled. */
async function stableBox(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  let prev = await locator.boundingBox();
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    await locator.page().waitForTimeout(50);
    // eslint-disable-next-line no-await-in-loop
    const next = await locator.boundingBox();
    if (prev !== null && next !== null && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5) {
      return next;
    }
    prev = next;
  }
  if (prev === null) throw new Error("glyph never measured");
  return prev;
}

// ---- Spec-local seed wrapper ----------------------------------------

/** Seed a v2 image tagged for the drag-undo spec. */
function seedCapture(app: LaunchedApp): Promise<string> {
  return seedImageCapture(app, {
    idPrefix: "dragundo",
    sourceName: "Drag Undo Spec"
  });
}

const openFocus = openEditorFocus;
