# A bake change without a `BAKE_PIPELINE_VERSION` bump is invisible to the cache

**Date:** 2026-08-28
**Symptom:** [#520](https://github.com/pwrdrvr/PwrSnap/pull/520)
recalibrated every annotation size onto one shared ladder and states, in
[its own solutions note](2026-08-28-annotation-scale-recalibration.md)
§"What this deliberately broke", that "existing captures re-bake at the
new sizes on next load."

They don't. A capture that had been baked before the upgrade keeps
showing its old annotation sizes indefinitely, while a capture baked for
the first time after the upgrade shows the new ones — so two captures
with identical overlays render at different weights, and no amount of
reopening fixes the stale one.

## Root cause

The render cache is content-addressed. `computeTreeRenderHash` in
[compose-tree.ts](../../apps/desktop/src/main/render/compose-tree.ts)
hashes the layer tree, canvas dims, output width, and format — plus
`BAKE_PIPELINE_VERSION`, which is the ONLY input that represents *the
code that turns those into pixels*.

#520 changed the code and nothing else:

- `BAKE_PIPELINE_VERSION` stayed `"8"`.
- `computeTreeRenderHash` was not touched at all (verified: the function
  is byte-identical across `8176b697..c181ad6b`).

So the same capture produced the same hash before and after, hit the
cache, and returned the pre-recalibration PNG. This is precisely the
failure the version input exists to prevent, spelled out in
[the orphans doc](2026-05-28-bake-render-cache-orphans.md):

> v=5 request → SAME hash inputs → SAME hash H → cache HIT → returns the
> v=4 bytes the user already complained about

Nothing here is subtle or conditional. It is the documented rule
("bump when a code change makes the bake produce different output bytes
for the same input layer tree + dims + format") applied to a change that
plainly qualifies — every arrow, shape, and text glyph moved.

## Why it was easy to miss

The tests cannot see it. Every bake test calls `shapeSvgForV2` /
`composeV2` directly, which always renders fresh — the cache sits
*above* that layer, in `renderViaCoordinator`. A recalibration PR can
therefore be completely green, and visually verified through the
harness, while still shipping stale bytes to anyone whose cache was warm.
Only an upgrade over an existing `render-cache/` shows it, and only for
captures that had been rendered before.

## The fix

Two places, because there are two caches and only one of them was ever
version-aware:

1. **`BAKE_PIPELINE_VERSION` "8" → "9"** — re-keys every entry so the
   next request re-bakes at the current ladder. Version-"8" files are
   orphaned and deliberately not swept, per the orphans doc.

2. **The local-agent export cache is now version-keyed too.**
   [export-coordinator.ts](../../apps/desktop/src/main/render/export-coordinator.ts)
   keeps a *second* cache — `render-cache/local-agent-exports/<id>/<exportId>.<ext>`
   — whose `exportId` hashed capture id, variant, format, dims, quality,
   background, source hash, and `edits_version`, but **not** the pipeline
   version. Bumping alone would not have fixed it: `edits_version` moves
   only when the user edits, so an untouched capture would serve
   pre-bump pixels from that path forever while clipboard and Library
   thumbnails (which go through `composeV2`) showed the new ones. It now
   folds `BAKE_PIPELINE_VERSION` into the key for `composite` exports.
   `original` exports bypass the compositor and stay keyed without it.

## The rule, restated

**Any PR that changes bake output must bump `BAKE_PIPELINE_VERSION` in
the same commit.** Not "consider bumping" — the version is not
documentation, it is the cache key. If you changed what a pixel looks
like for an unchanged capture, the old pixel is still reachable until you
bump.

And when you add a new cache that stores bake output, it needs the
version in its key too, for the same reason the render hash does. There
were two such caches and only one was covered; check for a third before
assuming a bump is sufficient.

## Also in this change — the halo formula, hoisted

`max(1.5, stroke × 0.25)` — the contrast-border width — was hand-written
in four production places: arrow bake, shape bake, `ArrowGlyph`, and
`shapeStrokeGeometry`. Two of them spelled it `max(stroke × 0.25, 1.5)`,
arguments flipped, which is how you can tell they were typed
independently rather than shared.

It is now `outlineHaloWidthPx` (per side) and `outlineHaloStrokeWidthPx`
(the full painted stroke) in
[overlay-schemas.ts](../../packages/shared/src/overlay-schemas.ts),
alongside `shapeAutoStrokeWidthPx`, pinned in `overlay-schemas.test.ts`.

This is the same lesson #520 applied to the stroke ladder, one line
further down the derivation: the halo is *derived* from the stroke, so
it inherits any error in it and needs the same single-source treatment.
The stroke got it; the halo hadn't. While there, `shapeSvg`'s filled-rim
branch stopped re-deriving the whole chain
(`readOverlayThickness → shapeAutoStrokeWidthPx → quarter`) to arrive at
the number `outlinePx` already held four lines above — a leftover from
when the stroked band was a genuinely different formula, and a seam
where the two could drift apart again.
