# Video Export Presets — Plan

**Status:** Planning. Tracks [issue #136](https://github.com/pwrdrvr/PwrSnap/issues/136). Branch `feat/video-export-presets`.

This document covers the design decisions for adding per-format S/M/L
export presets to video captures so the library's right rail, the
tray popover, and the float-over toast offer click-copy + click-path
+ drag-out parity with what image captures have shipped since day
one. PR [#132](https://github.com/pwrdrvr/PwrSnap/pull/132) removed
the broken image-style preset cards on video captures and replaced
them with a minimal two-card (GIF + MP4) export row. That row is
correct but strictly less powerful than the image row. This plan
brings video to parity.

## What ships

For each video capture, the Library DetailRail renders six cards
arranged in two rows:

```
┌──────────────────┬──────────────────┬──────────────────┐
│      GIF LOW     │      GIF MED     │     GIF HIGH     │
│  480p · 15 fps   │  540p · 24 fps   │  720p · 30 fps   │
│      ⌘1          │       ⌘2         │       ⌘3         │
├──────────────────┼──────────────────┼──────────────────┤
│      ⋮ FILE      │      ⋮ FILE      │      ⋮ FILE      │
└──────────────────┴──────────────────┴──────────────────┘
┌──────────────────┬──────────────────┬──────────────────┐
│      MP4 LOW     │      MP4 MED     │     MP4 HIGH     │
│   720p · CRF 28  │  1080p · CRF 23  │  source · copy   │
│      ⌘4          │       ⌘5         │       ⌘6         │
├──────────────────┼──────────────────┼──────────────────┤
│      ⋮ FILE      │      ⋮ FILE      │      ⋮ FILE      │
└──────────────────┴──────────────────┴──────────────────┘
```

Each card supports the same three affordances the image L/M/H cards
do today:

1. **Click the card** → encode the preset (showing `Encoding…` on the
   card while ffmpeg runs) → write the resulting file as a file
   promise to the system clipboard so paste into Slack / Mail /
   Finder drops the real binary.
2. **Click the FILE chip** → encode (cache-hit if already done) →
   write the POSIX path of the encoded file to the clipboard as text.
   Same path the file promise points at; this is the keyboardless
   equivalent for pasting into a terminal / editor.
3. **Drag the FILE chip** → encode (cache-hit if already done) →
   `webContents.startDrag({ file, icon })` so the user can drop the
   encoded file into any drop target — Finder, Slack, Mail, a
   `<input type="file">`, etc.

Tray and float-over keep their current two-card minimal UI for this
PR (they're space-constrained surfaces and the visual design is a
separate decision); follow-up PR brings them to parity.

## Design decisions

### 1. Layout — six cards, always visible (decided)

Two rows × three cards per format, both visible at once. No format
toggle, no hover reveals.

Rationale:
- Matches the image-card mental model (one row of three cards). No
  new interaction model to learn.
- Most-discoverable; the user sees the full export surface at a
  glance. We're not hiding the GIF row behind a tab the user has to
  remember to flip to.
- The Library DetailRail has the vertical space for it (the right
  rail is full-height; the footer grows downward without affecting
  any other content).
- Tray + float-over follow up later with their own treatment — those
  surfaces ARE space-constrained and probably do want a tab toggle
  or a "more formats…" menu.

### 2. Preset values — format-appropriate, hardcoded (decided)

| Preset | GIF | MP4 |
|---|---|---|
| **LOW** | 480p · 15 fps · palette-optimized | 720p · CRF 28 · web-friendly |
| **MED** | 540p · 24 fps · ~geometric midpoint | 1080p · CRF 23 |
| **HIGH** | 720p · 30 fps · smoothest practical | source resolution · stream-copy |

Mirroring the image side, the preset constants live in a single
source-of-truth file in `apps/desktop/src/main/recording/` and
the renderer reads them through a `video:presetMetrics` IPC verb
to populate estimated dimensions + bytes (matching how
`capture:presetMetrics` works for images).

GIF rationale (sizes for a 12s 1855×946 source — adjust mentally
for your typical clip; everything scales linearly):

- **480p / 15 fps · ~4 MB** — chat-friendly. 15 fps reads as smooth
  motion for UI scroll / cursor / animation captures, which is the
  dominant PwrSnap use case. Slack, Twitter, iMessage accept this
  without complaint.
- **540p / 24 fps · ~9 MB** — geometric midpoint between LOW and
  HIGH (~2.2× LOW, ~2.0× from HIGH). 540p is the qHD/SD intermediate
  tier — a meaningful "between LOW and MAX" stop. Picked over the
  intuitive "720p × lower fps" because fps alone can't move the
  byte size enough within a fixed resolution; MED needs its own
  intermediate resolution to feel like a midpoint rather than a
  thumbprint-cheaper HIGH.
- **720p / 30 fps · ~19 MB** — smoothest practical. We deliberately
  do NOT scale GIF HIGH up to source resolution because GIF byte
  size scales with `pixels × fps × duration` and gets unusable fast
  above 720p — a 1080p 30 fps GIF for 10 seconds is routinely 80+
  MB, over Slack's 50 MB cap, past iMessage's compression sweet
  spot, and triggers most platforms' auto-convert-to-MP4 paths.
  MP4 keeps the resolution axis up to source because H.264 + CRF
  handles high-res screen content without exploding; GIF doesn't,
  so HIGH means "smoothest and largest practical", not "source".
  Users who actually want source-resolution video pick MP4 HIGH
  (stream-copy, no re-encode, no size hit).

MP4 rationale:
- 720p / CRF 28 = ~3 Mbps for typical screen content. Drops into
  Slack / iMessage / email under attachment limits for ~30s clips.
- 1080p / CRF 23 = visually-lossless for screen content. The
  reference quality point.
- source / stream-copy = no re-encode, just trim + remux. Today's
  HIGH behavior. Largest output, instant encode.

These values are deliberate first guesses; tune in code review or
in a follow-up if the field reports differently. The bus contract
doesn't bake them in — the contract carries `preset: "low" | "med"
| "high"` and the encoder owns the mapping.

### 3. Encoding latency UX — block the card, other cards stay clickable (decided)

```
       click LOW MP4
            ↓
   ┌───────────────────┐
   │      MP4 LOW      │
   │  Encoding…        │  ← card shows progress, disabled
   │       ⌘4          │
   └───────────────────┘
       …5–60s later…
            ↓
   ┌───────────────────┐
   │      MP4 LOW      │
   │  720p · CRF 28    │  ← clipboard written, card re-enabled
   │       ⌘4          │
   └───────────────────┘
```

Per-card state machine — same shape as `VideoExportState` today,
but one per `(format, preset)` combination. While LOW MP4 is
encoding, the user can still click MED MP4 (queues a parallel
encode) or any GIF card. Only the in-flight card is disabled.

If the user clicks an already-cached card, the transition is
instant — main short-circuits the encode and goes straight to the
clipboard write. Subsequent reads off the cache are sub-100ms.

We don't pre-encode in the background on selection. Burning CPU /
disk eagerly for combos the user never clicks is too aggressive.
The cache makes repeat clicks instant; first-click latency is the
honest price of the format.

### 4. Clipboard write — file promise (`public.file-url`) so paste lands the binary (decided)

Card click writes BOTH:
- `clipboard.writeBuffer("public.file-url", buf)` with a `file://`
  URL pointing at the rendered file
- `clipboard.writeText(path)` as a fallback for apps that only read
  text

This is what Finder's "Copy" does. Pasting in Slack uploads the
file. Pasting in Mail attaches it. Pasting in Finder drops a copy.
Pasting in a terminal / editor gets the path string.

The FILE chip click writes ONLY the text path — same shape as
image `clipboard:copy-path` today. Reuses the existing handler
pattern verbatim, just with a video-aware encoder.

The codebase has no precedent for writing `public.file-url`. We
become the first consumer. The pattern lands in clipboard-handlers
so future surfaces can copy ANY rendered file by URL — useful for
image clipboard:copy improvements down the line too.

### 5. IPC contract — extend `video:export` additively, no source discriminator (yet) (decided)

Today:
```ts
"video:export": {
  req: { captureId; format; range?; audio? }
  res: { path; byteSize; durationSec; fromCache }
};
```

After:
```ts
"video:export": {
  req: { captureId; format; preset; range?; audio? }  // + preset
  res: { path; byteSize; durationSec; fromCache; widthPx; heightPx }  // + dims
};

"video:presetMetrics": {
  req: { captureId };
  res: { metrics: VideoPresetMetric[] };  // 6 entries, format × preset
};

"video:prepareDrag": {
  req: { captureId; format; preset };
  res: { path; iconPath };
};

"clipboard:copyVideoFile": {
  req: { captureId; format; preset };
  res: { path };
};

"clipboard:copyVideoPath": {
  req: { captureId; format; preset };
  res: { path };
};
```

`preset` is REQUIRED (no default). The renderer must pick a
preset; the backend never guesses. This is the same shape as
`clipboard:copy({ captureId, preset })` for images.

`audio` stays per-request, defaulting to whatever the source
recorded (today's behavior). No per-preset audio toggle — one
audio policy per capture. The MP4 cards inherit the
`hasSystemAudio || hasMicrophoneAudio` shape from the existing
hook.

**Sizzle Reels stays separate.** `sizzle:render({ id })` keeps
its own pipeline (Ken Burns + TTS + concat-demux are different
enough from frame-range extraction that unifying the verbs
would be a forcing function for both pipelines to know about
each other's needs). The renderer-side preset UI is the right
abstraction layer for project export: when Sizzle gets per-
preset quality, it'll grow its own `sizzle:render` parameters
and the renderer will swap which IPC verb it dispatches behind
the same `<VideoExportCard>` JSX.

No `source: { kind: "capture" | "project", id }` discriminator
in this PR. We can add it later if the cost of separate verbs
becomes painful; today the verbs do different enough things
that having two is the right factoring.

### 6. Cache layout — preset added to the key (decided)

Today:
```
<cache-root>/video/<captureId>/r<start>-<end>.<audio-tag>.<ext>
```

After:
```
<cache-root>/video/<captureId>/r<start>-<end>.<preset>.<audio-tag>.<ext>
```

`<preset>` is `low` / `med` / `high`. The `video_export_cache`
schema grows a `preset` column (migration). Existing rows are
backfilled as `med` since the current GIF encoder is ~720p (closest
match) and the current MP4 encoder is source-resolution (which is
HIGH but the existing file lives at the legacy filename without a
preset token — easier to mark them MED and let the cache miss for
HIGH on next request). Or, alternative: drop existing cache rows on
upgrade — they're per-export and re-encodable. Decided: **drop on
upgrade** because mismatched preset metadata is worse than a
one-time re-encode the next time the user clicks.

Cache invalidation on `edits_version` change (matching image
behavior) lands in a follow-up — today's video pipeline has no
edits-on-source story.

### 7. Drag icon — poster frame of the video (decided)

The image drag uses a 128px-wide downscaled PNG of the capture as
the drag preview. For video, the most informative drag preview is
the recording's first frame — frame 0 of the source MP4, decoded
through ffmpeg once and cached.

This is its own one-time encode (frame extraction, ~50ms). Cache
under `<cache-root>/video/<captureId>/poster.png`. Generated
on-demand the first time any drag affordance fires.

Future: pull frame at the midpoint instead of frame 0 (often
black during the first 100ms of a screen recording). Or use the
existing `previewPath` if it's already a poster — needs a look
at the recording-pipeline.

## Implementation phases

Phases are sequential — each depends on the prior. Tasks tracked in
the session task list.

### Phase 0 — Plan + sign-off (this doc)

User signed off on the four load-bearing choices via
`AskUserQuestion` before phase 1.

### Phase 1 — Bus contract extension

`packages/shared/src/protocol.ts`:
- Add `preset: "low" | "med" | "high"` to `VideoExportRequest`.
- Add `widthPx, heightPx` to `VideoExportResult`.
- New verbs: `video:presetMetrics`, `video:prepareDrag`,
  `clipboard:copyVideoFile`, `clipboard:copyVideoPath`.
- New types: `VideoPreset`, `VideoExportPresetKey`,
  `VideoPresetMetric`.

Validators in `apps/desktop/src/main/handlers/settings-validators.ts`
(or wherever video validators live) — `preset ∈ {low, med, high}`.

### Phase 2 — Encoder + cache schema migration

`apps/desktop/src/main/recording/recording-exporter.ts`:
- Add `PRESET_SPECS` const mapping `(format, preset)` →
  `{ width, fps, crf, audioPolicy }`.
- Switch ffmpeg invocations to use the preset spec (replace the
  hardcoded `fps=15 scale=720:-2` for GIF; add `-vf scale=...,fps=...`
  + `-crf` for MP4).
- Preserve stream-copy for MP4 HIGH (no scale, no re-encode).
- Output filename gains the `<preset>` token.

`apps/desktop/src/main/persistence/video-repo.ts`:
- Migration adds `preset TEXT NOT NULL DEFAULT 'med'` to
  `video_export_cache`. On upgrade, truncate existing rows (decided
  in §6).
- Cache lookup / record signature gains `preset`.

`apps/desktop/src/main/handlers/recording-handlers.ts`:
- `video:export` validator accepts `preset`.
- `video:presetMetrics` handler returns six metrics (3 formats? no,
  2 formats × 3 presets = 6). Lazily renders the LOW MP4 + LOW GIF
  to populate exact dims/bytes; the rest stay estimated until
  clicked.

### Phase 3 — Drag + clipboard handlers

`apps/desktop/src/main/render/file-alias.ts`:
- Extend `prepareRenderedPngAlias` → generic
  `prepareRenderedFileAlias(cachePath, displayName)` that takes a
  human-friendly filename (e.g. `<title>__<preset>.mp4`). The
  existing PNG alias becomes a thin wrapper that passes `image.png`
  as displayName.

`apps/desktop/src/main/handlers/recording-handlers.ts` (or
sibling):
- `video:prepareDrag` mirrors `capture:prepareDrag`:
  1. Encode (cache-hit if already done).
  2. Render the poster icon (frame-0 PNG, cached).
  3. `prepareRenderedFileAlias(encodedPath, displayName)` →
     hardlinked file at a human-friendly name.
  4. Return `{ path, iconPath }`.
- `video:drag-start` IPC listener (in `apps/desktop/src/main/ipc.ts`)
  mirrors `capture:drag-start` — dispatches `video:prepareDrag`
  then calls `event.sender.startDrag({ file, icon })`.

`apps/desktop/src/main/handlers/clipboard-handlers.ts`:
- `clipboard:copyVideoFile(captureId, format, preset)`:
  1. Encode (cache-hit if already done).
  2. `clipboard.writeBuffer("public.file-url", Buffer.from("file://" + encodedPath))`.
  3. `clipboard.writeText(encodedPath)` (fallback).
- `clipboard:copyVideoPath(captureId, format, preset)`:
  1. Encode.
  2. `clipboard.writeText(encodedPath)` only.

### Phase 4 — Renderer infrastructure

`apps/desktop/src/renderer/src/features/shared/useVideoExport.ts`:
- Replace `useVideoExport(input)` returning a single `exportState`
  with `useVideoExportPresets(input)` returning a
  `Record<\`${format}-${preset}\`, VideoExportState>` map plus
  per-preset action callbacks: `triggerCopy(format, preset)`,
  `triggerCopyPath(format, preset)`, `triggerDrag(format, preset)`.
- Auto-reset on captureId change (same as today).
- The existing `triggerExport` becomes `triggerCopy` (clicking a
  card copies the file to the clipboard).

`apps/desktop/src/renderer/src/features/shared/VideoExportCard.tsx`:
- New component, modeled on `<CopyButton>`. Props: `format`,
  `preset`, `exportState`, `dim`, `bytes`, kbd shortcut,
  callbacks. Renders the card + FILE chip + click overlays
  identical to `<CopyButton>`'s visual.

`apps/desktop/src/renderer/src/features/shared/VideoExportPresetGrid.tsx`:
- 2-row × 3-card grid. Wraps six `<VideoExportCard>` instances with
  the right per-cell wiring. Renders nothing if the input isn't a
  video.

`useVideoPresetMetrics(captureId, videoMeta)`:
- Mirrors `usePresetRenderMetrics`. Calls `video:presetMetrics` on
  mount, subscribes to a per-capture broadcast on export completion
  so dims/bytes go from estimated → exact for each cell as the
  cache fills.

### Phase 5 — DetailRail wiring

`apps/desktop/src/renderer/src/features/library/DetailRail.tsx`:
- Replace the two-button `<VideoExportButtons>` row with
  `<VideoExportPresetGrid>` for video records.
- Keep the existing image L/M/H row for image records.
- The action-row File button on video: drop the
  `draggable={!isVideo}` gate from PR #132 — the
  `startCaptureDrag` call needs to route through the new
  `video:drag-start` IPC when the record is a video.
- Tooltip flips back to "Drag video file or click to reveal in
  Finder" (the promise becomes real).
- `⌘1-⌘6` keyboard shortcuts wire the six cards (`⌘1-⌘3` for GIF
  LMH, `⌘4-⌘6` for MP4 LMH).

### Phase 6 — E2E coverage

New spec `apps/desktop/e2e/video-export-presets.spec.ts`:
- Seed a video capture via the existing bridge.
- Click each of the six cards → assert encode → assert clipboard
  contains the right preset's file path.
- Click the FILE chip → assert clipboard text contains the right
  preset+format token.
- Drag the FILE chip → assert main fires `webContents.startDrag`
  (Playwright can't actually do drag-out, but we can spy on the
  IPC dispatch).
- Cache hit assertions — second click on a card is < 100ms (no
  Encoding state visible).
- Per-preset on-disk path assertions — each combination lives at
  a unique cache file.

Also extend the prior commit's spec
[library-right-rail.spec.ts] to assert the new 6-card structure
replaces the old 2-card row.

### Phase 7 — Polish + follow-ups

- Surface the exported file path somewhere — auto-reveal-in-Finder
  toast? Click-the-card-while-cached → reveal? Decide in code
  review.
- Tray + float-over surface updates (separate PR — different
  layouts).
- Cache invalidation on `edits_version` (today's video pipeline
  has no edits-on-source story; add when video editing lands).

## Out of scope

- Tray + float-over visual updates.
- Sizzle Reels per-preset quality knobs (project export). Touched
  by the renderer-side preset UI but the IPC contract for projects
  doesn't change in this PR.
- Audio toggle per-preset (one audio policy per capture, today's
  behavior).
- Sub-range selection inside the rail. Sub-range selection still
  lives in the editor / float-over scrubber; the rail honors the
  persisted `defaultRange`.

## Risks

- **Clipboard `public.file-url` write is unprecedented in the
  codebase.** If macOS / Slack / Mail behave unexpectedly, the
  fallback is text-path-only — same as image
  `clipboard:copy-path` today. Validate with manual smoke tests
  in the test plan.
- **Six concurrent encodes is plausible if the user clicks
  fast.** ffmpeg-installer ships separate binaries per arch; main
  spawns N processes. Worth profiling on slower machines; if it's
  a problem, queue the encodes (one at a time) and surface a
  "queued" state on un-started cards.
- **The cache schema migration drops existing video export rows.**
  Acceptable — they're re-encodable and the migration runs once
  per install. Documented in §6.
- **Encode latency for HIGH GIF can be 30s+ on long clips.** The
  per-card disabled state mitigates UX harm but discoverability of
  the wait is a concern. The "Encoding…" subtitle is the only
  cue. Consider a progress spinner inside the card for v2 if users
  complain.
