# Sizzle Reels — real timeline editor: requirements + implementation plan

Status: **proposed**, not started. Date: 2026-08-17.
Supersedes the UI half of
[2026-05-30-001-feat-sizzle-sequence-scenes-plan.md](2026-05-30-001-feat-sizzle-sequence-scenes-plan.md)
and [2026-05-31-001-feat-sizzle-auto-beat-timing-reorder-plan.md](2026-05-31-001-feat-sizzle-auto-beat-timing-reorder-plan.md);
their data model stands unchanged and is the foundation this builds on.

---

## 1. The problem

The Sizzle editor is a vertical stack of form cards. You author a reel by
filling in fields — a `<select>` for timing kind, `type="number"` inputs for
start/end seconds, a searchable dropdown for phrase anchors — and **you cannot
see the reel you are making**. That is the whole complaint. Two adjacent
complaints are already fixed and shipped (one-scene-with-N-clips default, #387;
wasted left column collapsed into a crumb dropdown, #389). This one was never
addressed.

Concretely, today (`SizzleApp.tsx:2567–2808`) each clip is a table-ish row of:
grip · index · thumb · app name · timing `<select>` · number inputs *or* phrase
dropdown · fit `<select>` · transition `<select>` · ↑ · ↓ · ✕.

A proportional strip *does* already exist — `SequenceTimelinePreview`
(`SizzleApp.tsx:671–864`) draws clips at `left`/`width` percentages over a
wavesurfer waveform with a playhead. It is **read-only** (one click-to-seek
handler on the whole track), it sits *below* the form rows as an afterthought,
and it is per-scene. The raw material is there; it was never made the editor.

## 2. What it becomes

One horizontal time axis owning the editor's center column:

- **Clips lane** — every clip a segment whose width is its resolved on-screen
  duration. The shape of the reel is legible without reading a number.
- **Waveform lane** — the narration under the clips on the *same* axis.
- **Word ribbon lane** — the narration's words positioned at their spoken
  times. Clicking one pins the adjacent clip to that moment.
- **Drag to retime** — drag a clip to move it; drag a boundary to change a
  duration. Neighbors re-flow.
- **Clip inspector** — for the selected clip, in the right rail *alongside*
  chat.
- **Playhead scrubbing** driving the existing preview stage.

---

## 3. Inventory — verified against `origin/main` @ `30875aba`

Everything below was read, not assumed. Line numbers are from that commit.

### 3.1 Reuse as-is

| Thing | Where | Note |
|---|---|---|
| `SizzleBeatTiming` = `auto` \| `offset` \| `phrase` | `protocol.ts:1092` | `phrase` **is** the narration-anchor model. Click-a-word is a UI problem, not a schema one. |
| `distributeSequenceBeatStarts` | `protocol.ts:1167` | Pure. Pins index 0 to 0, evenly divides auto runs between anchors, monotonic clamp. Shared by planner + renderer so they cannot disagree. |
| `normalizeSizzleSequenceBeatContinuity` | `protocol.ts:1131` | Non-final beats run to the next anchor. |
| `planSequenceTimeline` / `planSequenceScene` | `sequence-planner.ts:66,157` | Duration authority. Emits `beat_too_short`, `phrase_unresolved`, `media_trim_clamped` diagnostics we already surface. **Moved (PR 3):** `planSequenceTimeline` now lives in `@pwrsnap/shared` (`sizzle-sequence-timeline.ts`) and the renderer's `timeline-model.ts` calls it for cached-timing scenes, so the editor draws the windows the export cuts. `planSequenceScene` (media half) stays in main. |
| `resolvePhraseTiming` | `speech-timing.ts:183` | Text→time resolution with contraction-aware fuzzy matching. **Moved (PR 3)** to `@pwrsnap/shared` (`sizzle-phrase-match.ts`, plus `countPhraseOccurrences` for §4.3); main re-exports. |
| **`video-range.ts`** | `features/shared/video-range.ts` | `pxToSec`, `secToPx`, `tickMarks`, `formatTimecode`, `formatSpan`, `clampTime`, `roundTime`, `MIN_RANGE_SEC`. Pure, unit-tested, zero React. **This is the timeline's math layer, already written.** |
| **`VideoTimeline.tsx`** | `features/shared/VideoTimeline.tsx` | Pointer-capture drag with `scrub`/`in`/`out` modes, `commit=false` while dragging + `true` on release, timecode tooltip, tick row, dimming scrim, playhead. **The exact drag mechanics we need, already shipped and tested** (`VideoTimeline.test.tsx`). |
| `SequenceWaveform` | `features/shared/SequenceWaveform.tsx` | wavesurfer, non-interactive by design, caller overlays its own playhead. Already used by both Sizzle and the Library video stage. |
| `SIZZLE_LIMITS` | `handlers/sizzle-validators.ts:54` | `sequenceBeatsMax: 80`, `scenesPerProjectMax: 200`. |
| Debounced patch + undo/redo | `SizzleApp.tsx:1064–1250` | 350 ms debounce, undo coalesced at the same window. |

The `VideoTimeline` overlap is the single biggest finding: the two surfaces want
the same component shape (controlled, caller owns time + range, drag reports
`commit`). The Sizzle timeline should be built as a sibling that shares
`video-range.ts` rather than a from-scratch strip.

### 3.2 Needs extension

**`SizzleSequencePreviewPlan` does not carry word timings.** `SizzleSpeechTiming.words`
(`protocol.ts:1220`) is a full `SizzleWordTiming[]` with per-word `startSec`/`endSec`,
and it exists in main — but the IPC surface only sends `transcriptPhrases`, which
`buildTranscriptPhraseSuggestions` (`speech-timing.ts:231`) builds as **sliding
5-word windows starting at every word index, capped at 300**. That is a picker
feed, not a word list. The word ribbon needs the words.

- Add `words: SizzleWordTiming[]` to `SizzleSequencePreviewPlan`.
- Add `words` to the `cached: true` arm of `sizzle:loadSequenceSceneAudio`.
  **Correction (2026-08-22):** `durationSec` was already on that arm when this
  work started — #422 (the `Render · 0:42` label) added it. PR 2 therefore
  adds `words` only. Both come off the `resolveCachedSpeechTiming` result
  already loaded in the handler, and **both are nullable together**: when that
  call returns `null` there is neither a duration nor words, which is exactly
  the `estimated` state in §4.1. Do not add an ffprobe fallback to fill in
  duration alone; it spawns a process per scene on reel open.
  **Shipped in PR 2** — `words: SizzleWordTiming[] | null` on the cached arm,
  `words: SizzleWordTiming[]` on the preview plan; the renderer's
  `useSequencePlan.wordsForScene(scene)` returns null until synthesis.
- Note the silent 300-window cap: a >300-word script currently has unanchorable
  words past 300 with no indication. Sending `words` sidesteps it for the ribbon;
  raise or document the cap for the legacy picker.

**`sizzle:previewSequenceScenePlan` synthesizes and requires an API key**
(`sizzle-handlers.ts:684`). `loadSequenceSceneAudio` is deliberately cache-only —
it "must NEVER synthesize, resolve speech timing, or hit any API". **Preserve
that.** The timeline paints from cache + estimate; exact timing arrives when the
user runs a preview. Auto-synthesizing every scene on open to fill the axis would
spend the operator's OpenAI credits without being asked, and is a non-starter.

### 3.3 Genuinely new

- ~~`estimateNarrationDurationSec(text)` in `@pwrsnap/shared`~~ — **landed
  before this plan was picked up** (#422, `packages/shared/src/sizzle-reel-duration.ts`).
  It is a word-count estimate at `SIZZLE_ESTIMATED_NARRATION_WPM = 160`
  (calibrated against an observed tts-1 reel, rounded down so the estimate
  leans long), with a 1 s floor per scene; not the characters-per-second
  constant this section originally proposed lifting from
  `approximateSpeechTiming`. The renderer's idle strip already uses it
  (`fallbackSequenceBeats` → `estimateSequenceTimelineDurationSec`), so the
  one-second-per-clip fallback described below is gone. **Reuse it; do not
  rewrite it.**
- The timeline view model + retime math (§5.2).
- `anchorTimingForWord(words, wordIndex)` — the click-a-word → `SizzleBeatTiming`
  rule, including phrase-extension for uniqueness (§4.3).
- Zoom / horizontal scroll (§4.5).
- The extracted component tree (§5.1).

### 3.4 Shared duration-summing helper — check before writing

**Resolved (2026-08-22): it landed first, as #422.** The helper is
`estimateSizzleReelDurationSec(scenes, contextFor)` in
`packages/shared/src/sizzle-reel-duration.ts`, returning
`{ totalSec, exact, sceneCount }` — `exact` is the resolved-vs-estimated signal
§4.1 needs, and the Render button already renders `Render · ~0:42` off it. The
timeline reuses it; nothing below is to be written. The original proposal,
kept for the record:

```ts
// packages/shared — used by the Render label, the timeline axis, and main's
// render path. One definition, three callers.
export function sizzleProjectDurationSec(
  project: SizzleProject,
  resolvedSceneDurationSec: ReadonlyMap<string, number>
): { totalSec: number; exact: boolean };
```

`exact: false` when any scene fell back to an estimate — so the Render label can
render `Render · ~0:42` rather than lying.

---

## 4. Requirements

### 4.1 Scope of the axis — one project, one axis

**Decision: a single continuous project time axis. Scenes are contiguous
regions on it.** Rejected: one independent axis per scene.

Why: it is what the render actually is (the composer concatenates scenes), the
common case is one scene so it degenerates to exactly the scene timeline the
operator asked for, and multi-scene reels get a coherent story for free instead
of a second layout. Per-scene axes at full panel width would draw a 4 s scene and
a 40 s scene the same width — a lie about the reel's shape, which is the exact
failure we are fixing.

Cost, stated plainly: the axis needs a duration for *every* scene, including ones
whose narration was never synthesized. That is what §3.3's estimator is for.
Scene regions render in one of **two** states, visually distinct:

| State | Source | Rendering |
|---|---|---|
| **resolved** | speech timing available — resolved this session, or from the speech-timing cache | solid fill, exact duration labels, word ribbon populated |
| **estimated** | no cached speech timing — duration from `estimateNarrationDurationSec` | hatched region fill, `~` prefix on every duration label, empty ribbon with the "Synthesize narration" affordance |

An estimated region must never look exact. Mixing the two silently is how a user
ends up trusting a number that was invented.

**Two states, not three — duration and words arrive together.** A "duration
known but word timings absent" middle state looks plausible and is not reachable
by the mechanism this plan proposes. Both come from the same cached
`SizzleSpeechTiming`: the free source for a cached duration is
`speechTiming.durationSec` off the `resolveCachedSpeechTiming` call already at
`sizzle-handlers.ts:796`, and that same object carries `words`. Null timing means
neither. Nor is the state reachable upstream — the preview path
(`sizzle-handlers.ts:701`) and the render path (`sizzle-handlers.ts:1040`) both
call `resolveSpeechTiming`, which writes the timing cache, so any sequence scene
with cached audio has cached timing. The only way to split them is probing
duration with ffprobe, which spawns a process per scene on reel open and is ruled
out by §8's 200-scene concern.

So `timeline-model.ts` carries a two-valued `exactness`, and PR 3 builds two
region treatments. Word availability is not a third state; it is a property of
the resolved state that happens to always be true. If a degenerate
audio-without-timing case ever does appear (`resolveSpeechTiming` skips its cache
write when the audio hash fails, `speech-timing.ts:97`), it degrades to
**estimated** — which is honest, since we would have no exact duration either.

### 4.2 Timing changes on re-synthesis

Grounded in the code, not assumed:

- **`phrase` anchors survive.** They store text + occurrence and are re-resolved
  against the *new* transcript at plan time (`sequence-planner.ts:304`). They
  follow the words. If the words left the script, `resolvePhraseTiming` returns
  `null`, the planner degrades that beat to `auto` and emits `phrase_unresolved`
  — already implemented, already surfaced as a warning chip.
- **`offset` anchors do not survive meaningfully.** They are absolute seconds.
  The planner clamps them into `[0, duration − 0.1]` and monotonically
  (`sequence-planner.ts:302`, `protocol.ts:1187`) but nothing rescales them. A
  narration that got 30 % shorter leaves offsets bunched against the end.
- **`auto` beats re-flow correctly by construction** — they hold no time.

**Requirements:**
1. Every drag and every word-click produces a **`phrase`** timing when a
   transcript exists. `offset` is the fallback only when there is none.
2. Never silently rescale `offset` values. When the resolved narration duration
   changes and offset-anchored clips exist, offer an explicit **"Re-fit
   anchors"** action that scales them by `newDuration / oldDuration`.
3. Limitation to accept and state in the UI: re-fit needs the *previous*
   duration, which is only known in-session. After a restart the offer is gone;
   the clips are still there, clamped. Persisting an "authored against" duration
   on the scene is schema creep for a case that phrase-first anchoring makes
   rare — not worth it.

### 4.3 Clicking a word

The interaction: click a word in the ribbon → the **selected** clip anchors
there. If no clip is selected, the click anchors the clip that currently covers
that moment.

Writing `{ kind: "phrase", phrase: "<that one word>" }` is wrong for common
words — "the" resolves to occurrence 1 forever. `occurrenceForTranscriptPhrase`
(`SizzleApp.tsx:302`) already handles disambiguation for the picker; the ribbon
needs the same guarantee with a better default:

> `anchorTimingForWord(words, i)` — start with `words[i]`, extend rightward until
> the phrase is unique in the transcript **or** reaches 5 words; set `occurrence`
> from the count of prior matches. Pure, unit-tested against a transcript with
> deliberate repeats.

Anchored words render underlined in accent with the clip's index badge —
matching the existing brief.

**Do not fake this before synthesis.** There is no transcript until TTS +
whisper have run, and the transcript legitimately differs from the written script
(the current editor already warns about this at `SizzleApp.tsx:2810`). Deriving
word positions from the *written* script would produce anchors that resolve to
different times than they display. The pre-synthesis state gets an honest empty
ribbon and a "Synthesize narration" affordance, not fabricated words.

### 4.4 Drag semantics — "pin only what you touch"

`distributeSequenceBeatStarts` divides auto runs between anchors. So:

- **Dragging a clip** pins *that clip* (phrase-anchored to the nearest word, or
  offset) and leaves its neighbors `auto`. The neighbors re-flow around the new
  anchor. This is the whole point of the auto model and it must survive.
- **Anchoring to a word does not quantize the drop position.** The phrase arm
  carries `offsetSec`, which `resolvePhraseTiming` adds to the matched word's
  start (`speech-timing.ts:212`). So a drag stores the nearest word *plus the
  residual*: `offsetSec = droppedSec − word.startSec`. Writing `offsetSec: 0`
  and snapping to the word boundary would make it impossible to place a clip
  between two words — visible as the clip jumping backwards on release at 4×
  zoom — for no gain, since the field already exists and the planner already
  applies it.
- **Dragging a boundary** between clips A and B pins **B** (the boundary *is*
  B's start). A's end follows automatically — non-final beats run to the next
  anchor by definition (`normalizeSizzleSequenceBeatContinuity`).
- **The final clip's end** is the only end a user can set directly; that is
  already true (`endSec` enabled only on the final beat, `SizzleApp.tsx:2687`).
- Clip 0 cannot be dragged off 0. Its stored timing is *parked*, not destroyed
  (`protocol.ts:1126`), so dragging it away and back is lossless.
- Minimum clip width enforced at `MIN_RANGE_SEC` (0.1 s), matching
  `resolveBeatWindows`'s existing 0.1 s clamp.

Rejected: a drag mode that rewrites every clip to `offset`. It reads as
"simpler" and it silently destroys re-flow on the next narration edit.

**Drag must not pollute undo history.** Undo records on scene edits coalesced at
350 ms (`SizzleApp.tsx:1086`); a drag emitting a patch per pointermove would fill
the stack with intermediate frames. Follow `VideoTimeline`'s contract exactly:
local state during the drag, one committed patch on release.

### 4.5 Density and zoom

At `sequenceBeatsMax = 80` and fit-to-width in a ~900 px center column, a clip is
~11 px. That is not draggable.

- Default **fit-to-width**; a zoom control in px/sec with presets
  (Fit · 1× = 40 px/s · 2× · 4×), `⌘+` / `⌘−`, horizontal scroll beyond fit.
- The playhead stays in view while scrubbing at zoom.
- Progressive disclosure by rendered clip width: **≥ 96 px** thumbnail + label +
  fit chip; **≥ 24 px** thumbnail only; **< 24 px** a bare accent tick. Never
  render a label that cannot be read.
- `tickMarks()` already coarsens its ladder by px/sec and needs no change.

**Do not mount a `<video>` per clip.** The current beat row does
(`SizzleApp.tsx:2613`, `preload="metadata"`); at 80 clips that is 80 media
elements. The lane uses `cacheUrl(...)` poster images; live video belongs only in
the preview stage. This is a real regression risk carried by the timeline PR, not
a separate cleanup.

### 4.6 Right rail

The operator's constraint: the clip inspector goes **beside/below the chat, not
replacing it**. The existing brief proposes `Compose | Clip` tabs — that
*replaces* it, and costs the user their chat transcript every time they inspect a
clip. Recommend instead: inspector as a **bottom drawer** in the right rail, chat
above it, both visible; drawer collapses when nothing is selected.

Flagged honestly: below roughly 480 px of rail width, chat + inspector both
become unusable, and one has to yield. At that width the inspector takes over and
chat collapses to its header — a documented degradation, not a surprise.

### 4.7 Preview fidelity — the other half of "you can't see the reel"

Added 2026-08-17 after the operator reported transitions playing as cuts.
Confirmed: they were watching the in-app ▶. The diagnosis is **not** that
transitions were never built, and **not** that their durations are too short to
see — though one of those is half-true.

**The render implements transitions correctly — verified empirically, not just
by reading.** `composer.ts:436` maps all eight types to real ffmpeg `xfade`
filters (`fade`, `fadeblack`, `fadewhite`, `slideleft`, `zoomin`), and
`composer.test.ts:445` locks the graph shape — but that test asserts the *args we
build*, not that ffmpeg renders a blend. So a two-image reel was rendered through
the exact graph `buildCompositionArgs` emits (1280×720@30, two 2.0 s image
scenes, `crossfade` 0.4 s):

- Output duration **3.600 s** = 2 + 2 − 0.4 overlap — the `chainEndSec` /
  `offset` arithmetic at `composer.ts:389` is right.
- Average frame colour across the transition window, red clip → blue clip:

  | t (s) | 1.40 | 1.65 | 1.75 | 1.85 | 1.95 | 2.10 |
  |---|---|---|---|---|---|---|
  | R | 254 | 211 | 147 | 84 | 20 | 0 |
  | B | 0 | 41 | 104 | 169 | 232 | 255 |

  A clean linear ramp confined to exactly the 1.6 → 2.0 s window.

**The export crossfade is real.** Nobody had ever confirmed it, because the
preview never shows one and the defaults never produce one (below).

**The preview implements none of them.** `SequenceTimelinePreview` resolves one
`activeBeat` by time and renders a single `<img>` or `<video>`
(`SizzleApp.tsx:769–783`). No second layer, no blend; the stage CSS has no
opacity animation. Every boundary is a hard cut in preview *by construction*,
whatever the user selected. Same story for Ken Burns — `zoompan` in the render,
a static `<img>` in preview.

The pattern across the feature is consistent: the model and render are ahead of
the UI, and the preview is behind both.

| | model | render | UI reach | preview |
|---|---|---|---|---|
| Transition types | 8 | all 8 | 7 per-clip, **2 per-scene** | **none** |
| Transition duration | per-boundary | honored | **unreachable** | n/a |
| Ken Burns (zoompan) | — | yes | n/a | **none** |
| Video fit (loop / ping-pong / speed) | 6 | all 6 | all 6 | **yes** |
| Audio under a video crossfade | — | **hard cut always** | n/a | n/a |

The video-fit row is the proof of concept: `sequencePreviewVideoState`
(`SizzleApp.tsx:625`) already makes the preview faithful to a render policy.
Transitions and Ken Burns simply never got the same treatment.

**Three defects, distinct from the gaps:**

1. **`push-left` and `slide-left` both emit `slideleft`** (`composer.ts:444–446`)
   — two menu entries, byte-identical output. `coverleft` is the likely correct
   target for a push, **but verify it exists in the bundled LGPL ffmpeg build
   before changing it** (`PwrSnapFFmpeg -h filter=xfade`); the xfade `cover*` /
   `reveal*` family was added later than the `slide*` family.
2. **The scene transition chip is a binary cut↔crossfade toggle**
   (`SizzleApp.tsx:2478`) — six of eight types are unreachable at scene level.
3. **Transition duration is model-only.** `transitionFromType`
   (`SizzleApp.tsx:481`) hardcodes `0.18` for every non-crossfade type. 0.18 s is
   5.4 frames at 30 fps; for `slide-left` and `zoom-cut` that reads as very
   nearly a cut *in the export too*. This is the half-true part of the operator's
   "they're all ~10 ms" hunch — right direction, wrong magnitude, and it only
   affects the six types that are not `crossfade` (0.4 s) or `cut`.

**Why a user would never see a transition even in a correct export.** Three
defaults compound:

- `newSizzleSequenceBeat` (`protocol.ts:1422`) sets every new clip to
  `transition: "cut"`. A reel built from the cart is all cuts unless the user
  opens each clip's dropdown.
- The scene transition chip only renders `if (idx > 0)` (`SizzleApp.tsx:2464`),
  so a **single-scene reel — today's default shape — has no scene-level
  transition control at all**.
- The preview can't show one regardless.

So the honest summary is: the transitions are built and they work; the product
never puts one in front of you. That is a defaults-and-affordances problem, not a
rendering one, and it should be fixed as such — consider defaulting new clips to
a short `crossfade` rather than `cut`, which is a one-line change with a large
perceived-quality effect. Flagging rather than deciding: cut *is* the right
default for fast app-demo montages, which is what `newSizzleSequenceBeat`'s
comment says it was chosen for.

**Requirements:**

- The preview stage renders transitions and Ken Burns with enough fidelity to
  judge a timing decision. It does **not** need to match ffmpeg pixel-for-pixel —
  a CSS opacity/transform blend across the transition window is sufficient and is
  what makes the timeline's transition pips mean something.
- Per-clip transition **type and duration** are both editable (inspector, §4.6).
- Scene-level transitions reach all eight types, not two.
- Audio crossfade under a video crossfade stays **explicitly deferred** — it is a
  composer change (`acrossfade`), not a UI one, and it is already documented as
  future work at `composer.ts:178`. Listing it here so it stops being invisible.

### 4.8 Non-goals

Not in this plan: changing the render pipeline, the composer, TTS providers, the
transition set, or `SizzleScene`/`SizzleSequenceBeat` shape. The data model is
adequate; this is a UI project plus two additive IPC fields.

---

## 5. Implementation

### 5.1 The structural blocker

`SizzleApp.tsx` is **3,226 lines** holding the entire editor. `SizzleApp` is 758
lines (866–1624); `Editor` is **1,308 lines** (1784–3092). `features/sizzle/`
contains exactly one extracted component besides it: `SizzleChatPanel.tsx`. A
timeline cannot reasonably be built inside that file, so extraction is PR 1 and
not negotiable.

Target tree under `features/sizzle/`:

```
SizzleApp.tsx            shell: rail, routing, picker, modals  (~250 lines)
useSizzleProject.ts      debounced patch, undo/redo, live sync
useSequencePlan.ts       preview-plan / audio / transcript caching + the
                         bounded-concurrency waveform loader now inline in Editor
ProjectRail.tsx          ProjectRow + context menu
CapturePicker.tsx        unchanged, moved
ReelSettings.tsx         the settings chip
PreviewStage.tsx         player + transport
timeline/
  SizzleTimeline.tsx     composition root, zoom + scroll owner
  TimelineRuler.tsx      tickMarks()
  ClipLane.tsx           segments, selection, drag
  WaveformLane.tsx       wraps SequenceWaveform
  WordRibbon.tsx         positioned words, click-to-anchor
  SceneRegions.tsx       scene boundaries + transition pills
  Playhead.tsx
ClipInspector.tsx        right-rail drawer
```

**As built (PR 1, 2026-08-22):** the extraction landed with this tree —
`SizzleApp.tsx` (shell, 325 lines), `useSizzleProject.ts` (project list,
active reel, captures, render status, debounced patch + undo/redo + live
sync), `useSequencePlan.ts` (preview playback, cached plan / transcript /
audio, narration durations, the bounded-concurrency waveform loader),
`Editor.tsx` (head, settings, scene list, footer), `SceneCard.tsx`
(`SequenceSceneCard` + `SimpleSceneCard` + `SceneTransitionChip` — the
pre-timeline form rows, retired in PR 6), `PreviewStage.tsx`
(`SequenceTimelinePreview`), `ProjectRail.tsx` (rail + row + context
menu), `CapturePicker.tsx`, `ReelSettings.tsx`, `RenderStatusBar.tsx`,
`ChatResizer.tsx`, `TranscriptPhrasePicker.tsx`, and three pure modules:
`sizzle-helpers.ts` (formatting, transition shapes), `sequence-plan.ts`
(cache keys, idle beat placement, video playback state) and
`scene-ops.ts` (every scene-list edit as `SizzleScene[] → SizzleScene[]`,
unit-tested). `timeline/` and `ClipInspector.tsx` arrive with PRs 3–6.

### 5.2 Pure logic — outside React, unit-tested

Nothing below touches the DOM. This is the part that must not live in a
component.

| Module | Contents |
|---|---|
| `packages/shared` (main + renderer) | `estimateNarrationDurationSec(text)`; `sizzleProjectDurationSec(...)` (§3.4) |
| `features/shared/video-range.ts` | **existing**, extended only if zoom needs it — `secToPx(sec, duration, widthPx)` already generalizes with `widthPx` = content width at zoom |
| `timeline/timeline-model.ts` | `buildTimelineModel({ project, resolvedByScene, estimator })` → scene regions + clips with `{ startSec, endSec, exactness }` + word positions. The single place the two exactness states are decided. |
| `timeline/retime.ts` | `applyClipDrag(beats, index, targetStartSec, transcript)` and `applyBoundaryDrag(...)` → new `SizzleSequenceBeat[]`. Encodes §4.4 including "pin only what you touch". |
| `timeline/anchor.ts` | `anchorTimingForWord(words, wordIndex)` (§4.3) |
| `timeline/density.ts` | width → detail level (§4.5) |

### 5.3 PR slices

Each is independently shippable and green.

**PR 0 — `fix(desktop): distinct push-left transition + reachable transition set`**
Independent of everything below; ships immediately. `push-left` → `coverleft`
(verified present in ffmpeg 8.1.1 via `-h filter=xfade`; re-check against the
repo-built binary, not a homebrew one). Scene chip gains the full eight types
instead of a cut↔crossfade toggle. Extend `composer.test.ts`'s xfade block to
assert `push-left` and `slide-left` emit *different* filters — the current tests
would not have caught this.

**PR 1 — `refactor(desktop): extract the Sizzle editor into components`**
No behavior change. Characterization tests first, then extraction per §5.1.
`SizzleApp.test.tsx` (1,579 lines / 41 tests) mostly keeps passing because it
drives the rendered DOM; its `sequence authoring`, `auto beat timing UI` and
`beat reorder` blocks are pinned to the form rows and will be rewritten in PR 6.
Sizing risk: this is the largest PR and the least visible. Do it anyway.

**PR 2 — `feat(desktop): send narration word timings to the renderer`**
Additive: `words` on `SizzleSequencePreviewPlan`; `words` + `durationSec` on the
cached arm of `sizzle:loadSequenceSceneAudio`. Add
`estimateNarrationDurationSec` + `sizzleProjectDurationSec` to shared (check
§3.4 first — the Render-label task may own them by then). No UI change beyond
the existing phrase picker gaining word granularity. Pure + handler tests.

**PR 3 — `feat(desktop): sizzle timeline canvas (read-only)`**
Ruler, clip lane sized by resolved duration, waveform lane, scene regions,
playhead scrubbing driving the existing preview, zoom + fit + density, the two
exactness states. Poster images replace per-clip `<video>`. The old form rows
survive underneath in a collapsed "Advanced" disclosure so nothing becomes
unreachable mid-migration. **This is the PR where the operator's complaint
dies** — the reel becomes visible.

*As built (2026-08-22):* `features/sizzle/timeline/` — `timeline-model.ts`
(`buildTimelineModel`: regions on one axis via the shared `layoutSizzleScenes`,
clips via this session's plan → the shared `planSequenceTimeline` over cached
words → the idle fallback; `exactness` decided here and nowhere else),
`density.ts` (zoom presets, ⌘+/⌘− ladder, clip detail by rendered px),
`SizzleTimeline.tsx` (root: measure, zoom, scroll, pointer-capture scrub,
playhead-in-view), `TimelineRuler.tsx`, `SceneRegions.tsx`, `ClipLane.tsx`,
`WaveformLane.tsx`, `Playhead.tsx`, `timeline.css`. Video clips carry a neutral
poster placeholder — there is no image poster route for video captures and the
plan forbids a `<video>` per clip; a `video:poster` (or `video:frames` with
`frameCount: 1`) IPC is the follow-up. The word ribbon is PR 4.

**PR 4 — `feat(desktop): anchor clips by clicking narration words`**
Word ribbon, click-to-anchor via `anchorTimingForWord`, anchor pins and removal,
the honest pre-synthesis empty state.

**PR 5 — `feat(desktop): drag to move and retime sizzle clips`**
Clip move + boundary retime on `retime.ts`, `VideoTimeline`'s pointer-capture and
`commit` contract, drag-local state so undo stays clean.

**PR 6 — `feat(desktop): sizzle clip inspector`**
Right-rail drawer beside chat. Per-clip transition **type and duration** both
editable here — closing §4.7 defect 3. Retire the form rows and the "Advanced"
disclosure. Rewrite the three form-pinned test blocks against the timeline.

**PR 7 — `feat(desktop): preview renders transitions and Ken Burns`**
Closes the §4.7 fidelity gap. Two-layer preview stage with a CSS
opacity/transform blend across the transition window, and a zoompan-equivalent
transform for image clips. Depends on PR 1's extraction but **not** on the
timeline, so it can run in parallel with PRs 3–6. Fidelity target is "good enough
to judge a timing decision", explicitly not pixel-parity with ffmpeg.

**PR 8 — `feat(desktop): multi-scene timeline operations`**
Split / merge / reorder scenes from the timeline, scene transition pills on
boundaries, the "Re-fit anchors" action (§4.2).

**Deferred, tracked not scheduled:** audio `acrossfade` under a video crossfade
(§4.7); the new-clip `cut` vs `crossfade` default (§4.7) — a product call, not an
engineering one.

### 5.4 Test strategy

- Pure modules (§5.2): unit tests, including a transcript with deliberate word
  repeats for `anchorTimingForWord`, and an 80-clip fixture for `density.ts` and
  `buildTimelineModel`.
- Components: RTL against the timeline DOM, mirroring `VideoTimeline.test.tsx`'s
  approach (it already drives pointer drags in jsdom successfully).
- No Sizzle E2E specs exist today and this plan does not add the first one —
  the editor needs an OpenAI key for anything past the cached path, which makes
  it a poor CI citizen. Cached-path coverage stays at the unit level.

---

## 6. Open risks

1. **PR 1 is a large no-op diff.** Mitigated by characterization-tests-first, but
   it is still the riskiest merge in the sequence.
2. **The estimator will be wrong sometimes.** A characters-per-second estimate for a
   dense technical script can be off by 20 %. The hatched-region treatment is
   load-bearing — if estimated regions ever look exact, the feature actively
   misleads. Do not let this get value-engineered out of the mockups.
3. **The 300-window cap** (`speech-timing.ts:239`) silently truncates anchorable
   words for long scripts. Sending `words` fixes the ribbon; the legacy picker
   keeps the cap until someone removes it.
4. **Right-rail width** (§4.6) — chat + inspector genuinely do not both fit on a
   small display.
5. **CONFIRMED LIVE BUG, found while verifying §4.7 — image-backed reels cannot
   render in packaged builds.** The bundled `PwrSnapFFmpeg` has **no PNG
   decoder**, and `resolveImagePath` (`sizzle-handlers.ts:214`) feeds ffmpeg
   PNGs from the render cache. Root cause is in the separate private build repo
   `pwrdrvr/pwrsnap-ffmpeg-builds`, not this one: `--disable-autodetect` turns
   off zlib, and ffmpeg selects PNG through it
   (`png_decoder_select="inflate_wrapper"` → `inflate_wrapper_deps="zlib"` →
   `--disable-zlib […autodetect]`). Confirmed by re-running configure both ways
   — `!CONFIG_PNG_DECODER=yes` with today's flags, `CONFIG_PNG_DECODER=yes` with
   `--enable-zlib`, GPL/nonfree off in both.

   Fix and a `REQUIRED_DECODERS` guard (encoders and devices were verified;
   decoders never were) are in
   [pwrsnap-ffmpeg-builds#1](https://github.com/pwrdrvr/pwrsnap-ffmpeg-builds/pull/1).
   **This repo needs no change**, but it does need a rebuilt binary before the
   fix reaches users.

   Note for whoever picks this up: **dev runs mask it entirely** —
   `resolveFfmpegPath` falls through to whatever `ffmpeg` is on `PATH`, usually
   a full homebrew build with PNG. So "it renders on my machine" proves nothing
   here; test against the packaged app. Scope is limited to Sizzle image scenes;
   most `format: "png"` call sites in main go through sharp/Chromium rather than
   ffmpeg, and video capture/trim/export decode h264+aac and are unaffected.

---

## 7. Mockups

Claude Design has two kinds of container and they are **not** interchangeable:

- A **design system** is shared reference — tokens, primitives, the starting
  point for every product that uses it. `PwrDrvr Design System`
  (`019debaf-c070-7afe-98db-4c9bbe10e72b`).
- A **project** holds one product's own design work. `PwrSnap`
  (`019deed3-8009-7107-bd1e-68bcd3fd192f`, `type: PROJECT_TYPE_PROJECT`).

**Sizzle mockups and their brief belong in the PwrSnap project.** A brief for one
feature of one product is not design-system material. Note `DesignSync`'s
`list_projects` returns design systems ONLY, so the PwrSnap project is invisible
to it — you must address it by id. That gap is why a PwrSnap brief drifted into
the design system in the first place.

The brief now lives at `briefs/sizzle-timeline-brief.md` in the **PwrSnap**
project. A stale copy remains in the design system and should be removed.

Palette: the PwrSnap project carries its own `ds/colors_and_type.css` — that is
the file the mockups actually resolve against, not the design system's copy.
Read 2026-08-17 and identical to the repo's `design/ds/colors_and_type.css` on
every token (`--accent: #ff8a1f`, `--bg-app: #000000`, light-theme
`--accent: #c45200`, radii, type scale, `ds-*` classes). No sync needed. If
mockups come back off-palette, diff **that** file, not the design system's.

The existing `PwrSnap Sizzle Reels.html` in the project is stale — it predates
the one-scene-with-N-clips default (#387) and the crumb-dropdown layout (#389),
so it depicts a UI that no longer exists. **Replace it; do not add a second
sizzle page.**

The brief has already been updated with these deltas (2026-08-17):

- Its `Compose | Clip` **tabs** contradict §4.6; change to chat + inspector
  drawer, both visible.
- Add the **two exactness states** (§4.1) — resolved / estimated. The current
  brief assumes resolved timing throughout.
- Add the **zoom control and density ladder** (§4.5), plus a variant at 80 clips.
- Add the **pre-synthesis** state — empty ribbon, "Synthesize narration"
  affordance, hatched estimated regions.
- Reframe scene lanes as **regions on one continuous project axis** (§4.1)
  rather than independently-scaled per-scene lanes.

Variants to request:
- **A** — fresh reel, 5 clips, no narration: estimated/hatched, empty ribbon.
- **B** — narration synthesized, 2 words anchored, playhead mid-scene, one clip
  selected with the inspector open beside chat.
- **C** — 80 clips at Fit and at 2× zoom, showing the density ladder.
- **D** — two scenes with a boundary + transition pill; scene 2 estimated while
  scene 1 is resolved.

> **Operator action required:** generating these happens in the claude.ai/design
> app, not through the `DesignSync` tool. Open the **PwrSnap** project, generate
> A–D from `briefs/sizzle-timeline-brief.md`, and replace
> `PwrSnap Sizzle Reels.html` rather than adding a new page.

---

## 8. Verified vs. assumed

**Verified by reading `origin/main` @ `30875aba`:** every file, symbol, and line
number cited above; the absence of the `Render · 0:42` duration label and of any
open PR carrying it; the absence of Sizzle E2E specs; the 3,226 / 1,308 line
counts; that `loadSequenceSceneAudio` omits `durationSec`; that
`buildTranscriptPhraseSuggestions` defaults to 5-word windows capped at 300; that
the renderer's idle duration fallback is one second per clip; that the beat row
mounts a `<video>` per clip; that both the preview and render paths call
`resolveSpeechTiming` and therefore always populate the timing cache alongside
the audio cache (§4.1).

**Verified by running ffmpeg (2026-08-17):** that `xfade` and every transition
name the composer emits exist in ffmpeg 8.1.1, including `coverleft`; that the
composer's exact filter graph renders a real 0.4 s crossfade with correct
duration arithmetic (§4.7); that the bundled binary has no PNG decoder, that
`--disable-autodetect` is the cause via zlib, and that `--enable-zlib` fixes it
(§6.5, proven at configure level in both directions).

**Spot-checked, not exhaustively verified:** the design project's palette against
the repo's — see §7 for exactly what was compared.

**Explicitly NOT verified:** a full `make` of the corrected ffmpeg binary (§6.5)
— configure output is decisive for codec selection, but only CI produces the
shipped artifact. `apps/desktop/scripts/build-ffmpeg.mjs` in *this* repo is not
what builds the shipped binary; `pwrdrvr/pwrsnap-ffmpeg-builds` is. Worth
checking whether the in-repo script is dead code.

**Assumed, and worth checking during the build:**
- That the characters-per-second constant lifted from `approximateSpeechTiming`'s
  `trimmed.length / 14` is a good enough estimator for real narration. It is an estimate
  of an estimate; measure against a few real reels in PR 2.
- That 40 px/s is a sensible 1× zoom. Picked by analogy to other NLEs, not
  measured against this design system's clip thumbnails.
- That RTL can drive the timeline's pointer drags in jsdom. Strongly suggested by
  `VideoTimeline.test.tsx` doing exactly that, but not proven for this component.
- Payload size of `words` at the top of the range. ~150 words for a 30–60 s reel
  is trivial; a 200-scene project fetching plans for every scene would not be —
  which is why §3.2 keeps the axis on cached + estimated durations.
