---
title: Video Transport + Trim Timeline (Phase A)
type: feat
status: active
date: 2026-08-15
origin: docs/brainstorms/2026-08-15-library-video-sizzle-design-critique.md
---

# Video Transport + Trim Timeline — Phase A

## Problem

The Library video viewer is a bare `<video controls>` (Stage.tsx): Chromium's
control bar (⋮ menu with download/PiP), no keyboard model, no scrubber feel,
and — the real gap — **no trim**, even though the backend already supports it
end-to-end: `VideoCaptureMetadata.defaultRange`, `video:setDefaultRange`, and
`VideoExportRequest.range` → ffmpeg `-ss/-t` in `recording-exporter.ts`. The
export cache is already keyed on range. Zero renderer callers of
`video:setDefaultRange`; the FloatOver comment claiming a sub-range editor is
stale.

## Approach

Ship the missing half of the surface as wiring, not new pipeline:

1. **Custom transport** (`features/library/VideoTransport.tsx`) replaces native
   controls: play/pause, mono tabular timecode `0:03.4 / 0:16.0`, loop-in-range,
   mute, fullscreen. Keyboard (viewer focused, no input focused): `space`,
   `J/K/L`, `←/→` frame step (1/30 s — metadata carries no fps), `⇧←/⇧→` 1 s,
   `I/O` set in/out, `Home/End`. A pure `video-transport-keys.ts` maps a
   `KeyboardEvent` shape → transport intent so it is unit-testable.
2. **Timeline strip** (`features/library/VideoTimeline.tsx`): filmstrip lane
   (contact strip from a new `video:frames` IPC), waveform lane
   (`SequenceWaveform` lifted to `features/shared/SequenceWaveform.tsx`, fed by
   a new `video:audio` IPC; empty lane when the capture has no audio track),
   playhead with drag-scrub, in/out handles bound to `defaultRange` (persist on
   release via `video:setDefaultRange`, debounced), dimming scrim outside range,
   `TRIM 0:03.4 – 0:11.2 · 7.8 s` eyebrow + `Full clip` reset chip, second ticks.
   Trim math (clamp, snap, px↔sec) lives in `features/shared/video-range.ts`
   (pure, tested).
3. **Export honors range**: `video:setDefaultRange` now broadcasts
   `events:captures:changed` so the Library revalidates the record; DetailRail's
   video export eyebrow reads `EXPORT · 0:03–0:11 (8 s)` when the persisted
   range is a strict subrange, metrics refetch on range change (size estimates
   re-derive server-side from range duration — `video:presetMetrics` already
   does this), and export / copy / drag calls pass `range` **explicitly** (the
   same `defaultRange` the eyebrow displays) — no reliance on the implicit
   fallback from the renderer side. Backend fallback stays for other callers.
4. **FloatOver mini-trim**: 40 px filmstrip + in/out handles above the export
   buttons, reusing `VideoTimeline` in `compact` mode; stale comment fixed.

## IPC contract (additive)

```
"video:frames": {
  req: { captureId: string; count?: number; frameWidth?: number };
  res: { url: string; frameCount: number; frameWidth: number; frameHeight: number };
}
"video:audio": {
  req: { captureId: string };
  res: { hasAudio: false } | { hasAudio: true; url: string; mimeType: "audio/mp4" };
}
```

- `video:frames` runs ffmpeg once per `(captureId, count, frameWidth)`:
  `-i src -vf fps=count/duration,scale=W:-2,tile=Nx1 -frames:v 1 -q:v 4
  <cache>/video/<id>/frames-n<N>-w<W>.jpg`. Filesystem cache next to the
  existing `poster.png` / export artifacts (`getCacheRoot()/video/<id>/`) —
  no schema migration; in-flight de-dup mirrors `video-poster.ts`.
- `video:audio` reuses `sizzle/audio-extract.ts::extractVideoAudio` for the
  full clip and copies/links the m4a into the same per-capture cache dir.
- Both return a `pwrsnap-cache://v/<captureId>/<asset>` URL served by a new
  arm of the existing `pwrsnap-cache` protocol handler (`parseVideoAssetUrl`
  whitelists `frames-n<N>-w<W>.jpg` and `audio.m4a`; resolver only serves
  files that already exist under the capture's cache dir). Sandboxed
  renderers display them as `<img>` / `fetch()`→Blob without any Node access.
- `video:setDefaultRange` unchanged in shape; now broadcasts
  `events:captures:changed` `[captureId]` after the write.
- `video:presetMetrics` gains an optional `range` so byte estimates
  re-derive from the displayed range immediately (falls back to the
  persisted `defaultRange`); the `video:drag-start` IPC payload gains an
  optional `range` too. Both are additive.

## Range identity (cache-key hygiene)

Persisted ranges are adopted verbatim by the renderer (`isValidRange` →
no rounding); only drag-produced values are rounded to ms. `Full clip`
resets to the exact `durationSec` the recorder seeded. This keeps the
export-cache key `(capture, start, end, format, preset, audio)` identical
across the stage, the DetailRail and the float-over, so no surface
triggers a duplicate encode of the same clip.

## Files

- shared: `packages/shared/src/protocol.ts` (two verbs), `features/shared/video-range.ts` (+test)
- main: `recording/video-frames.ts` (+ffmpeg-args test), `handlers/recording-handlers.ts`
  (`video:frames`, `video:audio`, broadcast), `protocols-parse.ts` (+test), `protocols.ts`,
  `index.ts` resolver arm
- renderer: `library/Stage.tsx`, `library/VideoTransport.tsx`, `library/VideoTimeline.tsx`,
  `library/video-transport-keys.ts` (+test), `library/DetailRail.tsx`,
  `shared/SequenceWaveform.tsx` (moved), `shared/useVideoExportPresets.ts` /
  `useVideoPresetMetrics.ts` (explicit range), `float-over/FloatOver.tsx`, styles
- docs: this plan; float-over comment

## Test plan

- Unit: key → intent mapping (modifiers, focus guard, frame step fallback);
  range clamp/snap/label formatting; export request mapping carries `range`;
  ffmpeg args for `video:frames`; `video:setDefaultRange` round-trip via
  video-repo (normalize + persist + read back); `parseVideoAssetUrl`.
- `pnpm --filter @pwrsnap/desktop typecheck`, `pnpm lint:colors`, vitest for
  touched dirs.
- Manual acceptance (operator): open a 16 s recording → `I` at 3 s, `O` at 11 s
  → MP4 MED export is 8 s; relaunch → in/out restored; FloatOver shows the
  same range.

## Non-goals (Phase B — separate plan)

Speed ramps, crop, split/join, cursor highlight, per-export range overrides
independent of the persisted default, fps probing / frame-accurate seeking,
GridCopyPalette video panel (PR #385, not on `main` yet).
