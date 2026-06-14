# DPI-Aware Export Presets — Plan

**Status:** Phase 1 implemented on branch `feat/dpi-aware-export-presets`.
Experimental, default OFF — mergeable to `main` without changing behavior
for normal users. Phase 2 (fixedWidths / byte-collapse / `auto` heuristic)
and Phase 3 (video) are not started. Owner: huntharo.

This document covers a rethink of how the image (and later video)
**Low / Med / High** export presets map to output resolution, driven
by two long-standing pain points on Retina / double-DPI captures:

1. **"Med is the same as Low/High."** The current image presets clamp
   to a fixed max width (`min(src,800)` / `min(src,1440)` / full). Any
   capture ≤ 800px wide collapses all three to the source; captures in
   the 800–1440 band collapse Med onto High. The user routinely picks
   Med on captures where it is byte-identical to the others.

2. **"A smaller Med produces a *bigger* file."** On a Retina capture a
   bit wider than 1440px, Med makes a tiny non-integer downscale
   (e.g. 1700 → 1440, a 15% width cut). For a screenshot PNG that is
   the worst case: the resample turns every hard edge into a 3–4 step
   antialiased gradient, destroying the long identical-pixel runs that
   PNG/DEFLATE compresses well, while shedding almost no pixels. Net
   bytes can *increase* even though the image is smaller.

The fix is to stop expressing the presets as absolute pixel widths and
express them as a **scale of the capture's own resolution**, anchored
to its DPI — which is exactly the Retina / not-Retina distinction the
post-capture popover already gestures at.

## Two findings that shape the design

**Real per-preset bytes already exist.** `capture:presetMetrics`
([capture-handlers.ts:601](../../apps/desktop/src/main/handlers/capture-handlers.ts))
renders all three tiers (`COPY_PRESETS.map(renderPresetFile)`) and
returns true measured `byteSize`, content-addressed and cached. The
Library detail rail and float-over consume it via
`usePresetRenderMetrics`
([usePresetRenderMetrics.ts](../../apps/desktop/src/renderer/src/features/shared/usePresetRenderMetrics.ts)),
flagged `exact: true`. The number that *can't* show the bloat is the
transient **estimate placeholder** `presetMetrics()` in
[CopyButton.tsx](../../apps/desktop/src/renderer/src/features/shared/CopyButton.tsx),
which computes `bytes = srcBytes · scale²` — structurally incapable of
showing a downscale getting larger. So "show real bytes per preset" is
mostly already built; the work is the *mapping*, plus stopping the
estimate from lying.

**The render cache is keyed by resolved pixel width + format, not the
preset label.** `computeTreeRenderHash` hashes
`{pipelineVersion, canvas, width, format, layerTree}`
([compose-tree.ts](../../apps/desktop/src/main/render/compose-tree.ts));
the coordinator's single-flight key is `v2:${captureId}:${width}:${format}`.
**This makes the "don't trust the stale cached render after toggling"
requirement free** — change the preset→width mapping and the resolved
width changes, which changes the cache key, which forces a fresh,
correct render. The only stale surface is the renderer's in-memory
metrics state, which just needs to refetch when the flag flips.

## Design decisions

### 1. One ladder generator in `@pwrsnap/shared` (decided)

The 800/1440/full mapping currently lives in two places that must
agree: `targetWidthForImagePreset` (main,
[image-presets.ts](../../apps/desktop/src/main/render/image-presets.ts),
used by the render path *and* the clipboard copy handlers) and the
hardcoded `low?800:med?1440:srcW` in the renderer estimate
([CopyButton.tsx](../../apps/desktop/src/renderer/src/features/shared/CopyButton.tsx)).

Collapse both into a single pure function in shared so the size the
user sees always matches the bytes that get copied, in every mode:

```ts
// @pwrsnap/shared
export type ExportRung = {
  preset: "low" | "med" | "high";
  widthPx: number;          // resolved against source + DPR, clamped ≤ source
  onScreenMultiple: number; // widthPx / logicalWidth → 2, 1, 0.5 …
  retina: boolean;          // dpr ≥ 2 && onScreenMultiple ≥ 2
};

export function resolveExportLadder(
  cap: { widthPx: number; heightPx: number; devicePixelRatio: number },
  strategy: ExportStrategy
): ExportRung[];
```

Main resolves widths from this (reading `DesktopSettingsService`, so
the renderer never sends a width); the renderer calls the same
function for labels, the Retina tag, and the estimate.

### 2. Strategy model — internal enum, boolean UI (decided)

Internally the ladder is parameterized by a strategy so Phase 2 can add
candidates without a schema change. **The Phase 1 settings UI is a
single switch**, not a strategy picker:

- `experimental.dpiAwareExport: boolean` — default **false**.
  - **false →** `legacy` strategy: `min(src,800)` / `min(src,1440)` /
    full. Untouched. This is what normal users get; merging to `main`
    changes nothing for them.
  - **true →** `scalePhysical` strategy (below).
- `experimental.allowRetinaExport: boolean` — default **true**. Only
  meaningful when `dpiAwareExport` is on. Re-anchors the scale ladder
  (decision 3). No-op on 1× captures.

Both live in a new `experimental.*` section in
[protocol.ts](../../packages/shared/src/protocol.ts) `Settings` /
`SettingsPatch`, defaulted in `defaultSettings()` and back-filled in
`parseV1` (additive change — **no `schemaVersion` bump**), following the
`recording.*` pattern in
[desktop-settings-service.ts](../../apps/desktop/src/main/settings/desktop-settings-service.ts).

The richer strategy candidates (`fixedWidths`, `auto`) stay as internal
enum values, reachable in dev for A/B but not surfaced in the Phase 1
UI. Promote to a visible picker only if Phase 2 data says we need it.

### 3. `scalePhysical` ladder + the Retina re-anchor (decided)

```
anchor   = allowRetinaExport ? cap.widthPx : logicalWidth   // logicalWidth = widthPx / dpr
ladder   = [0.25, 0.5, 1.0].map(s => round(anchor * s))      // Low, Med, High
widthPx  = min(rung, cap.widthPx)                            // never upscale
```

On a 2× Retina capture:

| | Allow Retina **on** | Allow Retina **off** |
|---|---|---|
| High | 100% physical → **2× / Retina** | 50% physical → **1× / Standard** |
| Med | 50% physical → **1× / Standard** | 25% physical → **½×** |
| Low | 25% physical → **½×** | 12.5% physical → **¼×** |

So "Allow Retina export off" makes the old 50% the new High and offers
two smaller rungs below — exactly the requested behavior. On a 1×
capture physical == logical, so the toggle is inert and High == source.

Each rung is labeled with its on-screen multiple (`2×`, `1×`, `½×`) plus
a **Retina / Standard** tag derived from `onScreenMultiple`, shown next
to the existing dim + bytes in the copy card. The integer 2:1 / 4:1
downsamples this produces are exactly the clean cases that stay crisp
and compress well, avoiding the non-integer bloat trap.

### 4. Cache correctness on toggle (decided)

No manual cache invalidation needed (the key is width+format, per the
finding above). Two wiring requirements:

- Main resolves the ladder from `DesktopSettingsService` at request
  time in `renderPresetFile`, `capture:presetMetrics`, and the three
  clipboard handlers
  ([clipboard-handlers.ts](../../apps/desktop/src/main/handlers/clipboard-handlers.ts)),
  so a copy after a toggle produces the new width → new key → correct
  bytes.
- `usePresetRenderMetrics` adds the active flag(s) to its effect deps /
  fetch key so the rail refetches real metrics when the toggle flips,
  instead of showing the prior mode's cached numbers. The renderer
  reads the flags from `useSettingsContext()`, which already updates
  live on the `events:settings:changed` broadcast.

### 5. Stop the estimate from lying + fix the popover badge (decided)

- The `srcBytes · scale²` estimate is only ever a sub-second
  placeholder before real metrics resolve. Keep it as a placeholder but
  drive its width from `resolveExportLadder` so the *dimensions* are
  right immediately; show the bytes as clearly provisional (e.g. `~` /
  dimmed) until the exact value lands, so it never implies a confident
  wrong size.
- The popover's `"2× retina"` string is **hardcoded**
  ([FloatOver.tsx:590](../../apps/desktop/src/renderer/src/features/float-over/FloatOver.tsx))
  — change it to read `record.device_pixel_ratio`. Worth doing
  regardless of the experiment.

### 6. The heuristic — measure first, then formalize (deferred to Phase 2)

The point of shipping the instrument (switchable mapping + **real**
bytes) is to flip it on a Retina machine and *see* which ladder gives
three well-separated, sensible file sizes across real captures, then
codify what we observed rather than guessing now. Starting hypotheses
to tune against real numbers:

- **Pick the ladder by source size:** large captures → `scalePhysical`;
  small captures → `fixedWidths` clamped to `[~480, src]` so we never
  offer a useless ~150px rung.
- **Collapse by *measured bytes*, not pixels:** if a smaller rung lands
  within ~12% bytes of a larger one, merge and relabel ("Med = High").
  Judged on the real file — the content-aware rule that finally kills
  "I pick Med but it's identical."

## Clipboard paste — DPI inference + verbatim PNG (shipped with Phase 1)

Pasting an image into the library is the other place a capture's
`device_pixel_ratio` originates, and it was wrong in two ways:

- **Re-encode inflation.** `capture:pasteFromClipboard` decoded the
  clipboard bitmap and re-encoded it to PNG (`nativeImage.toPNG()` /
  `sharp().png()`), so a 612 KB source PNG was stored as ~707 KB. High
  re-export then faithfully reused the inflated bytes — the inflation was
  at *ingest*, not export. Fixed by preferring the raw pasteboard image
  flavors and storing a **PNG flavor verbatim** (no re-encode), falling
  back to the decoded bitmap only when no raw flavor decodes. The
  `pHYs` density survives verbatim storage, which feeds the next point.
- **DPR hardcoded to 1.** Pasted images were always `device_pixel_ratio:
  1`, so a Retina paste never showed the Retina label or got the right
  ladder. Now the scale is inferred from the image's DPI density
  (`devicePixelRatioFromDensity`: 144 DPI → 2×, clamped to [1,3], default
  1× when absent). Heuristic — not every source tags density — so the 1×
  default is load-bearing.

Implementation: `apps/desktop/src/main/clipboard-image-buffer.ts`
(`ingestImageBufferToTempPng`, `devicePixelRatioFromDensity`) +
`apps/desktop/src/main/handlers/capture-handlers.ts`
(`writeClipboardImageToTempPng`). Not yet addressed: PwrSnap's own
`clipboard:copy` writes a bitmap (TIFF) with no PNG flavor + no density,
so a PwrSnap→PwrSnap *image-copy* round-trip still re-encodes and loses
DPR — a copy-as-file round-trip is already clean. A follow-up could write
`pHYs` density on export and/or co-write a PNG flavor on copy.

## Phasing

1. **Phase 1 (this plan):** shared `resolveExportLadder`;
   `experimental.dpiAwareExport` + `allowRetinaExport` (default
   off / on); single switch + Retina toggle on the General settings
   page; thread the strategy through the main resolver,
   `capture:presetMetrics`, and clipboard handlers; refetch metrics on
   toggle; Retina/Standard tag in the copy card; estimate + popover
   badge fixes. Ships `legacy` + `scalePhysical`.
2. **Phase 2:** add `fixedWidths`, the byte-distinctness collapse, and
   the `auto` heuristic, informed by real numbers gathered in Phase 1.
3. **Phase 3:** apply the same scale ladder to video *resolution*
   (fps / bitrate stay as tuned in the video-export-presets plan).

## Files in play (Phase 1)

| Area | File |
|---|---|
| Ladder generator (new) | `packages/shared/src/` (e.g. `export-ladder.ts`) |
| Settings schema + defaults | `packages/shared/src/protocol.ts`, `apps/desktop/src/main/settings/desktop-settings-service.ts` |
| Settings UI | `apps/desktop/src/renderer/src/features/settings/pages/GeneralPage.tsx` |
| Main width resolution | `apps/desktop/src/main/render/image-presets.ts`, `apps/desktop/src/main/handlers/clipboard-handlers.ts`, `apps/desktop/src/main/handlers/capture-handlers.ts` |
| Renderer estimate + labels | `apps/desktop/src/renderer/src/features/shared/CopyButton.tsx`, `usePresetRenderMetrics.ts`, `library/DetailRail.tsx` |
| Popover badge fix | `apps/desktop/src/renderer/src/features/float-over/FloatOver.tsx` |

## Open questions

- **Minimum rung floor.** Should `scalePhysical` enforce a floor (e.g.
  no rung below ~400–480px) so Low on a small capture stays useful, or
  let the byte-distinctness collapse (Phase 2) handle it? Leaning: add
  a simple floor in Phase 1, refine in Phase 2.
- **Where the toggle lives.** General settings page (alongside
  Developer mode) vs. a dedicated hidden Experimental section. Leaning:
  General, tagged "experimental", to match how prior experimental
  toggles were folded into General.
- **Video parity timing.** Phase 3 here, or fold into a video-presets
  follow-up. No blocker either way.
