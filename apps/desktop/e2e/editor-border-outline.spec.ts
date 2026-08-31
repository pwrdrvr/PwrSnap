// E2E: the Border (contrast outline) control end-to-end — the one
// layer that can prove the AUTO sampler actually reads pixels in a
// real Chromium renderer.
//
// Why E2E and not unit: the sampler draws the capture's raster into a
// canvas via a crossorigin="anonymous" Image and calls getImageData —
// which only works because the pwrsnap-capture:// protocol now serves
// `access-control-allow-origin: *` (see protocol-file-response.ts). A
// tainted canvas throws in real Chromium but jsdom has no canvas at
// all, so unit tests can't cover the CORS + decode + sample chain.
// The failure mode this spec guards: sampling silently degrades to
// null and Border: Auto always falls back to the legacy white halo.
//
// Fixture note: the default seeded PNG is a TRANSPARENT 1×1 —
// transparent pixels don't get a vote (unknowable export backdrop),
// so these specs seed solid-color rasters via `pngHex`.

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";
import { openEditor, seedImageCapture, selectTool } from "./fixtures/editor";

test.setTimeout(90_000);

// Solid 8×8 PNGs (sharp-generated). White exercises the "light
// background → black border" arm; near-black exercises the "dark
// background → white border" arm.
const WHITE_8X8_PNG_HEX =
  "89504e470d0a1a0a0000000d4948445200000008000000080806000000c40fbe8b0000000970485973000003e8000003e801b57b526b0000000f49444154189563f84f00308c0c050084b5ff01982a63230000000049454e44ae426082";
const DARK_8X8_PNG_HEX =
  "89504e470d0a1a0a0000000d4948445200000008000000080806000000c40fbe8b0000000970485973000003e8000003e801b57b526b0000001249444154189563101010f98f0f338c0c05003c314cc14cfe4b390000000049454e44ae426082";

async function drawArrow(
  win: Awaited<ReturnType<typeof openEditor>>,
  fromFrac: { x: number; y: number },
  toFrac: { x: number; y: number }
): Promise<void> {
  const canvas = win.locator(".editor-canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  const cbox = await canvas.boundingBox();
  expect(cbox).not.toBeNull();
  if (cbox === null) return;
  const sx = cbox.x + cbox.width * fromFrac.x;
  const sy = cbox.y + cbox.height * fromFrac.y;
  const ex = cbox.x + cbox.width * toFrac.x;
  const ey = cbox.y + cbox.height * toFrac.y;
  await win.mouse.move(sx, sy);
  await win.mouse.down();
  await win.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 5 });
  await win.mouse.move(ex, ey, { steps: 5 });
  await win.mouse.up();
}

/** Wait for the editor's raster to have actually decoded — the Border
 *  sampler warms from the same URL, so a decoded display image means
 *  the sampler's copy is (about to be) ready too. */
async function waitForEditorImage(
  win: Awaited<ReturnType<typeof openEditor>>
): Promise<void> {
  await win
    .locator('[data-testid="editor-image"]')
    .waitFor({ state: "attached", timeout: 15_000 });
  await win.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(
      '[data-testid="editor-image"]'
    );
    return img !== null && img.complete && img.naturalWidth > 0;
  });
}

/** Collect the stroke colors of every <line> in each persisted arrow
 *  glyph SVG, per glyph. */
async function persistedArrowStrokes(
  win: Awaited<ReturnType<typeof openEditor>>
): Promise<string[][]> {
  return win.evaluate(() => {
    const svgs = Array.from(
      document.querySelectorAll('[data-testid="persisted-glyph-svg"]')
    );
    return svgs
      .map((svg) =>
        Array.from(svg.querySelectorAll("line")).map(
          (line) => line.getAttribute("stroke") ?? ""
        )
      )
      .filter((strokes) => strokes.length > 0);
  });
}

test("editor-border-outline: Auto samples a WHITE background into a black border", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "border-auto-light",
      sourceAppName: "Border Outline Spec",
      pngHex: WHITE_8X8_PNG_HEX
    });
    const win = await openEditor(app, captureId);
    await waitForEditorImage(win);

    // Draw with the DEFAULT tool style — Border defaults to Auto, so
    // the white background must resolve to a black halo on the
    // persisted glyph. If the sampler chain (CORS header → decode →
    // getImageData → median luma) breaks anywhere, this renders the
    // white fallback and the assertion fails.
    await selectTool(win, "arrow");
    await drawArrow(win, { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.6 });

    await expect
      .poll(async () => persistedArrowStrokes(win), { timeout: 15_000 })
      .toEqual([["black", "#ff8a1f"]]);

    // Flip the tool default to an explicit White border and draw a
    // second arrow — the control must override the sampled pick.
    const caret = win.locator('[data-testid="tool-caret-arrow"]');
    await caret.waitFor({ state: "visible", timeout: 5_000 });
    await caret.click();
    const popover = win.locator('[data-testid="tool-style-popover"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    await popover.locator('[data-testid="outline-white"]').click();
    await expect(
      popover.locator('[data-testid="outline-white"][aria-checked="true"]')
    ).toHaveCount(1);
    await win.keyboard.press("Escape");

    await drawArrow(win, { x: 0.25, y: 0.75 }, { x: 0.75, y: 0.8 });
    await expect
      .poll(
        async () =>
          (await persistedArrowStrokes(win))
            .map((strokes) => strokes[0])
            .sort(),
        { timeout: 15_000 }
      )
      .toEqual(["black", "white"]);
  } finally {
    await app.close();
  }
});

// Deterministic replay of the race behind this spec's one-in-ten
// local flake (2026-08-29): the Library Focus toolbar is clickable
// before `settings:read` resolves, and in that window the tool-state
// hook's activeStyle degrades to the pointer placeholder — so a fast
// draw used to commit with the WHOLE style block dropped: no
// `outline` field (→ legacy white halo despite the white background)
// and an unresolved `color: "auto"` stem. The env knob holds the
// settings read open so the draw always lands inside the window; the
// commit-side `whenToolStylesSettled()` await is what makes this
// pass. The delay must stay comfortably ABOVE the time it takes this
// spec to reach the draw (~1s) and BELOW the hook's bounded settle
// wait (3s) — past the bound the commit deliberately degrades to the
// style-less overlay rather than wedging.
test("editor-border-outline: a draw racing settings load still gets the sampled border", async () => {
  const app = await launchPwrSnap({
    env: { PWRSNAP_E2E_SETTINGS_READ_DELAY_MS: "2000" }
  });
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "border-settings-race",
      sourceAppName: "Border Outline Spec",
      pngHex: WHITE_8X8_PNG_HEX
    });
    const win = await openEditor(app, captureId);
    await waitForEditorImage(win);
    await selectTool(win, "arrow");
    await drawArrow(win, { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.6 });

    // Pre-fix this received [["white", "var(--accent, #ff8a1f)"]].
    await expect
      .poll(async () => persistedArrowStrokes(win), { timeout: 15_000 })
      .toEqual([["black", "#ff8a1f"]]);
  } finally {
    await app.close();
  }
});

test("editor-border-outline: Auto keeps the white border on a DARK background", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "border-auto-dark",
      sourceAppName: "Border Outline Spec",
      pngHex: DARK_8X8_PNG_HEX
    });
    const win = await openEditor(app, captureId);
    await waitForEditorImage(win);

    await selectTool(win, "arrow");
    await drawArrow(win, { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.6 });

    await expect
      .poll(async () => persistedArrowStrokes(win), { timeout: 15_000 })
      .toEqual([["white", "#ff8a1f"]]);
  } finally {
    await app.close();
  }
});

test("editor-border-outline: Border Off draws no halo at all", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, {
      idPrefix: "border-off",
      sourceAppName: "Border Outline Spec",
      pngHex: WHITE_8X8_PNG_HEX
    });
    const win = await openEditor(app, captureId);
    await waitForEditorImage(win);

    await selectTool(win, "arrow");
    const caret = win.locator('[data-testid="tool-caret-arrow"]');
    await caret.waitFor({ state: "visible", timeout: 5_000 });
    await caret.click();
    const popover = win.locator('[data-testid="tool-style-popover"]');
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    await popover.locator('[data-testid="outline-none"]').click();
    await expect(
      popover.locator('[data-testid="outline-none"][aria-checked="true"]')
    ).toHaveCount(1);
    await win.keyboard.press("Escape");

    await drawArrow(win, { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.6 });
    // One line only: the colored stem. No halo under-stroke.
    await expect
      .poll(async () => persistedArrowStrokes(win), { timeout: 15_000 })
      .toEqual([["#ff8a1f"]]);
  } finally {
    await app.close();
  }
});
