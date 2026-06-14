# Editor crop invisible — the cropped `<img>` overflowed an `overflow:visible` canvas

**Date:** 2026-06-13
**Symptom:** You crop a capture in the editor. Clicking **Apply Crop**
does nothing visible — the editor keeps showing the **full, uncropped**
image. But every *baked* surface is correctly cropped: the Library
grid thumbnail, the clipboard paste, the L/M/H file exports. Restarting
doesn't help — a fresh open of the cropped capture still shows the full
image in the editor while the chrome (dims readout, copy sizes) all say
the cropped size. So: bake correct everywhere, editor live view wrong.

## Root cause

The editor renders the **SOURCE raster directly** (not the baked
composite). To show a crop it sizes the `<img>` to
`(source / canvas) × 100%` so the kept region fills the canvas and the
rest **overflows** — e.g. a 2880×1920 source cropped to a 2880×466 band
makes the img `100% × 412%`. The overflow is the whole mechanism; it
only reads as a crop if it's **clipped to the canvas box**.

That clip used to come from `.editor-canvas { overflow: hidden }`.
**[#125](https://github.com/pwrdrvr/PwrSnap/pull/125)** (editor
selection model) flipped it to `overflow: visible` so `SelectionOutline`
+ `TransformHandles` + draft glyphs could extend past the canvas edge
when a shape is dragged off-screen. The commit's comment asserted *"The
IMAGE doesn't extend past on its own (sized to the canvas), so no
image-bleed concern"* and leaned on a new `border-radius: 6px` on the
`<img>` to "self-clip."

Both assumptions are false **for cropped captures**:

- The image *is* larger than the canvas — that's how crop view works.
- `border-radius` rounds the img's **own** (412%-tall) box; it does not
  constrain the img to the parent's bounds. With `.editor-canvas`
  `overflow:visible`, the full source bled out (clipped only at the
  much larger `.editor-canvas-wrap`), so the crop vanished from the
  editor while the compositor (`compose-tree.ts`, which clips the
  raster to `canvas_dimensions` independently of any CSS) kept every
  baked surface correct.

This is a clean editor-only regression: source-dims scan, crop
dispatch, canvas-dim shrink, and the bake were all working. The only
broken link was the CSS clip.

## The fix

Clip the **image** without re-clipping the **annotations**. They're
separate children of `.editor-canvas` with opposite needs:

- image (+ blur) → must clip to the canvas (so crops show)
- SVG / selection outline / transform handles → must NOT clip (#125)

So `.editor-canvas` stays `overflow: visible`, and the `<img>` gets its
own clip box sized to the canvas:

```css
.editor-image-clip {        /* wraps the <img> */
  position: absolute;
  inset: 0;                 /* = the canvas content box */
  overflow: hidden;         /* clips the overflowing source */
  border-radius: 6px;       /* rounds the CANVAS corners, not the img's */
}
```

`border-radius` was removed from `.editor-image` — for off-origin crops
the img's own corners sit mid-canvas, so rounding them would notch the
visible region. The wrapper rounds the canvas corners correctly for
every crop shape (edge-aligned and off-origin).

Files: `Editor.tsx` (`<img>` wrapped in `.editor-image-clip`),
`editor.css` (new rule + img border-radius removed).

## Why reasoning-from-the-screenshot kept missing it

The source-dims loop, the crop dispatch, the layer tree, and the bake
all check out — so the investigation circles them. The tell is the
**combination**: bake correct on *every* surface (thumbnail, paste,
export) but the editor's live `<img>` wrong. That isolates the fault to
the one thing only the editor does and the bake doesn't — render the raw
source through CSS. From there it's `.editor-canvas`'s `overflow`.

Fastest confirmation without building Electron: extract the bundle's
`sources/*.png`, drop it in a 2-div HTML repro (`.editor-canvas` at the
cropped size, `<img>` at `100% × 412%`), and toggle `overflow`
visible↔hidden. visible = full bleed (the bug); a wrapping
`overflow:hidden` box = the cropped band.

## Guardrails / when to revisit

- **Don't put `overflow:hidden` back on `.editor-canvas`.** That
  re-clips the off-canvas handles #125 deliberately freed.
- **Don't flatten `.editor-image-clip`.** It is load-bearing — it's the
  only thing clipping the source to the crop. If you move blur/SVG
  around, keep the image inside an `overflow:hidden` box sized to the
  canvas.
- `computeEditorImageStyle` intentionally produces an oversized img;
  that's correct, not a bug to "fix" by clamping to 100%.
