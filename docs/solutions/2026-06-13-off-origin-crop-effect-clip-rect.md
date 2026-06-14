# Off-origin crop drifted blurs/highlights — effect `clip_rect` wasn't translated

**Date:** 2026-06-13
**Symptom:** Draw a blur (or highlight) over a region, then apply an
**off-origin** crop (a crop whose kept rect doesn't start at the
top-left). After the crop the blur no longer covers what it covered
before — it's shifted. Wrong in the editor **and** the baked surfaces
(library thumbnail, export), so it's not a display-only bug.

## Root cause

The v2 crop op (`useCaptureModel.ts` `case "crop"`) is a viewport
translate. For an off-origin crop with normalized rect `{x, y, w, h}`,
the new canvas origin sits at `(x × oldW, y × oldH)` in the OLD canvas,
so everything positioned in canvas coordinates must shift by
`(-x × oldW, -y × oldH)`:

- **Vector layers** (arrow / text / rect / highlight-as-shape) — handled
  in **Step 0** via `inverseTransformOverlayByCrop`.
- **Raster layers** — handled in **Step 0.5** (translate `transform.tx/ty`).
- **Effect layers** (blur / highlight as `kind: "effect"`) — carry an
  **absolute-canvas-pixel `clip_rect`**… and were **skipped entirely**.

The dispatcher had a comment asserting the skip was safe because
"off-origin crops … collapse to (0,0) so this isn't reachable." That
assumption was **false** — off-origin crops are reachable (the Crop
tool's default rect is a centered 60%, which is off-origin). So the
effect's `clip_rect` kept its pre-crop absolute coordinates while the
canvas origin moved underneath it, and the effect drifted. Because
`clip_rect` is the single source of truth for both the editor's
`BlurOverlays` (it normalizes `clip_rect / canvasDims`) and the bake
(`compose-tree.ts` reads `clip_rect` directly), both surfaces were wrong
in the same way.

## The fix

Translate every effect layer's `clip_rect` by `(-offsetXPx, -offsetYPx)`
in **Step 0.5**, right alongside the raster transform (same delete +
upsert dance, same off-origin guard). No clamping — crop is a viewport
translate, so a `clip_rect` pushed out of the new canvas persists as
data and is clipped at paint, mirroring the overlay re-normalization in
Step 0.

```ts
const effectLayers = layersRef.current.filter(
  (l): l is BundleLayerNode & { kind: "effect" } => l.kind === "effect"
);
for (const effect of effectLayers) {
  if (effect.clip_rect === null) continue;
  const newClipRect = {
    x: effect.clip_rect.x - offsetXPx,
    y: effect.clip_rect.y - offsetYPx,
    w: effect.clip_rect.w,
    h: effect.clip_rect.h
  };
  await dispatch("layers:delete", { id: effect.id });
  await dispatch("layers:upsert", {
    captureId,
    layer: { ...effect, id: nanoid(16), clip_rect: newClipRect }
  });
}
```

## Guardrails

- Any **new layer kind** added to the tree must be considered in the
  crop op's translation. The three families (vector shape coords, raster
  transform, effect `clip_rect`) each need their own handling — there is
  no single generic pass.
- The regression is covered by an E2E
  (`editor-crop-clip.spec.ts` → "off-origin crop translates a blur's
  clip_rect…"): it inserts a blur at a known `clip_rect`, applies the
  centered-60% (off-origin) crop through the real Crop tool, and asserts
  the `clip_rect` shifted by `rect.{x,y} × oldCanvas`. It fails on the
  pre-fix dispatcher.
