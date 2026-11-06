# Authoring Sizzle reels through MCP

Sizzle's version 1 timeline is editable data. It supports fixed scene slots,
layered images/video, animation, captions, counters, typing, terminal reveals,
voiceover, and music. The earlier narrated-capture editor continues to work for
projects without a `timeline`.

## Workflow

1. `pwrsnap_sizzle_create({name: "Launch"})` creates an empty project without
   starting another model or composition chat.
2. Import explicitly selected files with `pwrsnap_sizzle_import({projectId,
   path})`. Paths must be absolute local PNG/JPEG/WebP, MP4/MOV/M4V, or
   WAV/MP3/M4A/AAC/FLAC files. Imports return managed asset IDs. They require
   both `sizzle.compose` and the separate `sizzle.assets.import` permission.
3. Alternatively, use library search, inspect/edit a recording as needed, then
   `pwrsnap_sizzle_import_capture({projectId, captureId})`. This snapshots the
   current edited image or video. It requires `capture.composite.read` and
   `sizzle.compose`, respects the role's age window, and does not grant
   original-media access. Recording exports keep the selected audio tracks.
4. Read `pwrsnap_sizzle_get({projectId})`. It returns the complete editable
   timeline, asset metadata, and `modifiedAt` revision, without private paths.
5. Apply `pwrsnap_sizzle_apply_launch_template`, or send a complete timeline
   through `pwrsnap_sizzle_update`. Both require `expectedModifiedAt` from the
   read. A concurrent change produces a refusal; read again before retrying.
6. Inspect a frame or contact sheet with `pwrsnap_sizzle_inspect_frames` and
   an array of 1–12 absolute frame indices. This uses the movie renderer and
   does not synthesize audio. Inspect text fit and source framing here.
7. Call the existing `pwrsnap_sizzle_render_preview` or `_render_full`.
   Completed renders return protected MCP media plus scene-cache counts and
   narration fit/QA reports. Pass the typed resource link to the client's
   media handler. Full output is visible under the OS videos folder's
   `PwrSnap` directory and playable in the Library/Sizzle viewer.
8. `pwrsnap_sizzle_audio_qa` transcribes the final mixed track, compares it
   with the render's saved script when available, and measures loudness/peak.
   This explicitly requested step may spend a transcription request; identical
   audio reuses its transcript cache. It does not regenerate VO or pictures.

`pwrsnap_sizzle_send` remains available for composition chat. Idle
`pwrsnap_sizzle_status` now includes the completed assistant summary. For a
versioned project, the composition assistant uses `timeline_set` and
`bindings_set`, scoped to that chat's project.

## Timeline data

This minimal example needs no assets or paid calls:

```json
{
  "version": 1,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "bindings": {
    "fileCount": 33524125,
    "caption": "{{fileCount|number}} files on screen"
  },
  "scenes": [{
    "id": "benchmark",
    "durationFrames": 90,
    "layers": [
      {
        "id": "count",
        "kind": "counter",
        "x": 60, "y": 250, "width": 1800, "height": 220,
        "fontSize": 170, "align": "center",
        "from": 0, "to": {"binding": "fileCount"}, "countFrames": 28
      },
      {
        "id": "caption", "kind": "text", "text": "{{caption}}",
        "x": 60, "y": 500, "width": 1800, "height": 100,
        "fontSize": 48, "align": "center"
      }
    ]
  }],
  "audio": []
}
```

Scene durations concatenate without subtracting transition overlaps. All
frame windows are half-open: `startFrame` is included, `endFrame` excluded.
Layer times are local to the scene; audio times are absolute within the reel.
Supported frame rates are 24, 25, 30, and 60. Canvas dimensions must be even,
between 320 × 180 and 3840 × 2160. Timelines are bounded to 36,000 frames,
100 scenes, 100 layers per scene, 100 audio tracks, and 200 bindings.

Every layer has an ID and a box (`x`, `y`, `width`, `height`), optional window,
fade-in/out frame counts, and optional `motion`. Motion interpolates `from`
and `to` poses (`x`, `y`, `scale`, `rotation`, `opacity`) over its local frame
window with `linear`, `ease-out`, or `ease-in-out` easing. IDs are unique in
their scene. Text is escaped and cannot introduce SVG or execute code.

| Kind | Content |
| --- | --- |
| `rect` | Fill, optional stroke and rounded corners. Use with text for chips/cards. |
| `text` | Plain text with explicit newline breaks, font size/weight, color and alignment. |
| `counter` | Numeric `from`/`to` or `{binding: "name"}`, `countFrames`, prefix/suffix. |
| `typing` | Text, `revealFrames`, optional blinking caret. |
| `terminal` | Colored text lines, line delay/reveal frames, background and padding. |
| `image` | Imported `assetId`, contain/cover fit, zoom endpoints, focus point, radius, wipe frames. |
| `video` | The same framing plus source start, playback rate, and freeze/loop end behavior. Video audio is an explicit independent audio track. |

Bindings resolve in text, counter endpoints, narration, and expected
transcripts. String bindings may reference other bindings, with cycle/depth
and expansion limits. `{{name|number}}` adds English number separators;
`{{name}}` uses the plain value.

To revise a benchmark, call `pwrsnap_sizzle_set_bindings` with just the changed
values and current revision. The next render reuses visual scenes whose
resolved data did not change. Unchanged narration and prepared music are cached
separately. Existing recordings remain recordings: changing a number cannot
rewrite a supplied VO file. Use bound generated narration for that behavior.

## Launch template

`pwrsnap_sizzle_apply_launch_template` exposes its full structured input schema.
It builds nine editable slots totaling **975 frames / 32.5 seconds at 30 fps**:
intro, context cards, handoff, features, benchmark counter, terminal/demo,
protection/typed confirmation, result sequence, and logo/end card.

Supply product name/tagline/URL, copy for those scenes, feature labels, a
numeric metric, terminal lines, and imported assets for the logo, overview,
features, workflow, safety, and result. Optional `handoffImage` adds a wipe;
`resultSequence` supplies progress screenshots; `workflowVideo` substitutes a
live clip for the workflow still. The returned timeline can be edited freely.

Choose either nine `voiceoverAssets` or nine `narration` strings, or omit both
for a reel without voiceover. Narration strings may reference bindings such as
`{{metricValue}}`. `voice`, `delivery`, and `pronunciation` control generated
speech. Applying the template only saves data: paid synthesis begins on render.
The optional music bed uses a fixed seed, 128 BPM, and explicit drop/final hits.

## Audio and QA

Each audio track declares `id`, `role` (`voice`, `music`, or `sound`),
`startFrame`, `durationFrames`, `source`, volume/fades, and a fit policy.

- `source.kind: "asset"` uses a managed audio/video asset and optional
  `trimStartSec`.
- `source.kind: "speech"` uses the configured OpenAI credential, model
  `gpt-4o-mini-tts`, selected voice, text, delivery instructions, literal
  pronunciation substitutions, and requested speed. The request controls are
  documented in the [official Speech API reference](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create).
  Change `takeId` to request a fresh take with otherwise identical settings.
- `source.kind: "synth"` generates sample-free music from `bpm`, `seed`,
  `dropFrame`, and optional `finalHitFrame`. Hit frames are local to the track.

`strict` fits by padding short sources and refuses an overrun. `speed` permits
bounded tempo adjustment up to `maxSpeed` (default 1.35). Voice tracks cannot
select `trim` or `loop`; those are explicit policies for music/sound. Optional
silence trimming removes the leading/trailing silence before fitting.

Generated narration is transcribed and compared with its spoken script.
Pronunciation-hint names are checked separately so a single wrong product name
cannot pass merely because the rest of a long sentence matched.
QA accepts the identical spoken forms “disk”/“disc” and joined brand spellings
from transcription. A refusal includes the expected and recognized text.
Integer metrics must match independently of the sentence's general word-error
allowance; English number words and digit forms are normalized for that check.
`expectedText` enables the same check for a supplied take. A mismatch fails
the render so an agent can correct the take; it does not quietly retry paid
generation. Successful reports include measured duration, slot duration,
playback rate, and recognized text. Transcription QA detects wording errors;
the operator still judges delivery and tone. Verification requires the
configured speech credential; provided audio without `expectedText` renders
without network access.

Music ducks under voice by default. The mix targets −14 LUFS and −1 dBTP with
FFmpeg loudness normalization; `mix` controls the target and ducking. Full
exports include adjacent `.timeline.json` and `.report.json` files. Frame
inspection, preview, and full movies share the same absolute-frame renderer.

Scene caching currently re-renders an affected scene as a unit. It does not
patch arbitrary individual frames inside that scene. Cuts between scenes and
layer transitions inside fixed slots preserve the audio axis. No arbitrary
HTML/JS, external media URLs, restricted composition frameworks, or runtime
Python dependency are involved.
