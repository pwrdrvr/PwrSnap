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
6. Optionally call `pwrsnap_sizzle_prepare_narration` with the current revision
   to generate/verify the whole take before rendering. It returns protected
   playable WAV audio, `asset.id`, `expectedText`, measured words, and the new
   revision. The managed asset survives cache cleanup. It does not change the
   speech recipe or pictures. To lock a take for offline use, update the voice
   source to `{kind: "asset", assetId: "<returned asset.id>"}`; keep the speech
   source when later binding changes should regenerate narration. This requires
   `sizzle.compose` and `sizzle.preview.read`, and may bill speech/transcription.
7. For a narration-led reel, call `pwrsnap_sizzle_align_narration` with the
   current revision and one phrase cue per scene after the first. It generates
   or reuses one complete take, measures words with Sizzle's sequence timing
   engine, and saves ordinary frame durations. This may bill speech and timing
   transcription. Narration stays whole and untrimmed. See the example below.
8. Inspect a frame or contact sheet with `pwrsnap_sizzle_inspect_frames` and
   an array of 1–12 absolute frame indices. This uses the movie renderer and
   does not synthesize audio. Inspect text fit and source framing here.
9. Call the existing `pwrsnap_sizzle_render_preview` or `_render_full`.
   Completed renders return protected MCP media plus scene-cache counts and
   narration fit/QA reports. Pass the typed resource link to the client's
   media handler. Full output is visible under the OS videos folder's
   `PwrSnap` directory and playable in the Library/Sizzle viewer.
10. `pwrsnap_sizzle_audio_qa` transcribes the final mixed track, compares it
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
transcripts. String bindings may reference other bindings, with cycles refused,
a maximum depth of 20 and 16,000 expanded characters. Each dependency resolves
once per text expansion, including shared empty values. `{{name|number}}` adds
English number separators; `{{name}}` uses the plain value.

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
features, workflow, safety, and result. Each role accepts a live clip instead
of a still: `overviewVideo`, `featuresVideo`, `workflowVideo`, `safetyVideo`, and
`resultVideo`. Videos take precedence when both are supplied. `handoffVideo`
or `handoffImage` adds a wipe; `resultSequence` supplies progress screenshots.
Images have no default zoom. Keep real recordings as video layers; a still
with camera motion does not replace a recording. The returned timeline can be
edited freely, including source starts and playback rate.

Prefer `narrationText` (one complete script) or `voiceoverAsset` (one complete
recording). This creates one voice track across all visual scenes; moving a
visual boundary does not split, trim, or fade that narration. An overlong take
is refused rather than cut off. Image zoom is off by default.

The older nine `voiceoverAssets` or nine `narration` strings remain available
for explicitly timed, independent takes. Omit all narration sources for a reel
without voiceover. Narration strings may reference bindings such as
`{{metricValue}}`. `voice`, `delivery`, and `pronunciation` control generated
speech. Applying the template only saves data: paid synthesis begins on explicit
alignment or rendering.
The optional music bed uses a fixed seed, 128 BPM, and explicit drop/final hits.

For narration-led capture workflows, Sizzle's existing **sequence scene** is
the primary model: one narration with visual beats anchored to measured
phrases. The layered timeline now uses that same word timing and phrase matcher
through `pwrsnap_sizzle_align_narration`:

```json
{
  "projectId": "sz_example",
  "expectedModifiedAt": "<revision returned by get/template>",
  "cues": [
    {"sceneId": "context", "phrase": "He also runs Shopify"},
    {"sceneId": "handoff", "phrase": "we've got it from here"},
    {"sceneId": "features", "phrase": "Power Disk", "occurrence": 1},
    {"sceneId": "benchmark", "phrase": "Over 33 million files"},
    {"sceneId": "workflow", "phrase": "Your AI agent"},
    {"sceneId": "safety", "phrase": "Home folders"},
    {"sceneId": "result", "phrase": "Watch it all go"},
    {"sceneId": "end", "phrase": "Power Disk", "occurrence": 2}
  ],
  "tailFrames": 30
}
```

Each cue supports `edge: "start" | "end"`, a 1-based `occurrence`, and
`offsetSec`. The first picture starts at zero. The final picture extends through
the measured narration plus `tailFrames` (default 15, maximum 300). Layer windows
and timed reveals scale to their new scenes; music hits move with their picture
positions. Audio is one uninterrupted take at its generated/recorded speed.
The response includes measured word timings and the saved project revision.
Missing phrases, approximate timing, and reversed cue order fail explicitly;
use the measured transcript spelling (for example `33` rather than `thirty
three`) when correcting a phrase. Re-run alignment after changing spoken
bindings. Preview, frame inspection, and final export all read the saved result.

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
Voice sources are limited to ten minutes; music and sound sources retain their
complete duration for `strict`/`speed` fitting, including sources longer than
ten minutes.

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
Variable-rate recordings retain the frame held across a source trim boundary.
Frame inspection prepares only the distinct requested source frames of active
video layers; freeze and loop holds reuse those frames within the request.

Scene caching currently re-renders an affected scene as a unit. It does not
patch arbitrary individual frames inside that scene. Cuts between scenes and
layer transitions inside fixed slots preserve the audio axis. No arbitrary
HTML/JS, external media URLs, restricted composition frameworks, or runtime
Python dependency are involved.

## MCP coverage of the launch workflow

The public tools cover the operations used by the local reel-building script.
Timeline JSON is the composition input; no executable timeline/render script
needs to be supplied by an agent.

| Operation | Public MCP surface |
| --- | --- |
| Start an empty project, inspect assets/revision | `sizzle_create`, `sizzle_get` |
| Import PNG/MOV/MP4/WAV files | `sizzle_import` (explicit local-media permission) |
| Find, inspect, trim dead time from a library recording | `library_search`, `video_inspect`, `video_edit`, `sizzle_import_capture` |
| Place live clips, choose source ranges/speed, preserve aspect | `sizzle_update` → video layers |
| Captions, counters, typing, terminal text, camera/wipes | `sizzle_update` → visual layers; optional `sizzle_apply_launch_template` |
| One narration, voice/delivery/pronunciation, requested speed and fresh takes | Speech source fields through `sizzle_update` / launch template |
| Prepare/audition a take; retain a reusable audio asset and all word timings | `sizzle_prepare_narration` |
| Phrase start/end, occurrence and offset → saved picture boundaries | `sizzle_align_narration` |
| Supplied or sample-free music, hit timing, ducking, loudness | Audio sources and `mix` through `sizzle_update` |
| Revise bound metrics/captions/VO and reuse unaffected scenes | `sizzle_set_bindings`, re-align spoken changes, then render; responses report cache counts |
| Review frames/contact sheets; audition/render previews | `sizzle_inspect_frames`, `sizzle_render_preview`; protected media links |
| Full movie, user-visible output, final mixed-audio transcript/loudness | `sizzle_render_full`, `sizzle_audio_qa` |

Tool names above omit the common `pwrsnap_` prefix. Recording an external app
and transferring its footage remain capture/VM tasks. The original local
script's cache-file copy for narration is replaced by `sizzle_prepare_narration`.

The desktop protocol test is `e2e/sizzle-mcp.spec.ts`: a real MCP SDK client
launches the stdio relay, connects to the already running built app through a
private IPC endpoint, approves the actual native consent window, and calls
these tools. Protected media is read through MCP resources, without a TCP
listener or OAuth exchange. The test intercepts inference in
the isolated test process, rather than copying provider credentials to the VM.
The media pipeline, persistence, permissions, and protected delivery are real.
Set `PWRSNAP_E2E_REQUIRE_SIZZLE_MCP=1` with a vetted macOS FFmpeg path to require
that audit rather than allowing the standard no-encoder development skip.
