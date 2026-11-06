# Launch-reel feasibility: the PwrDisk worked example

This records a completed investigation and a real MCP rendering trial on
2026-11-05. It is evidence about the existing composer, not an implementation
plan. Source checkout: `f046b489`.

**Follow-up:** the operator chose to build the new composition contract inside
PwrSnap after this investigation. The initial recommendation below is retained
as the record of that assessment. The integrated implementation is described
in [the agent reel guide](../sizzle-agent-reels.md) and
[the architecture](../architecture.md#agent-authored-sizzle-timelines).

## Integrated implementation trial

The new nine-scene launch template rebuilt the supplied example as a
975-frame, 1920 × 1080, 30 fps movie. It uses managed copies of the exact source
images, layered text/counter/terminal/typing primitives, independent narration
slots, and a seeded sample-free music bed. The rebuild called the production
timeline/audio renderer from a local harness; the installed application's MCP
server still exposes the earlier build. New MCP contracts have automated service
and permission coverage, rather than a claimed live upgrade of that server.

A benchmark-binding revision rendered one scene and reused eight. Replacing
narration reused all nine visual scenes. Live speech and transcription checks
also found stale supplied takes: the original fifth WAV says 34 million, and
the seventh says 5 percent. Two replacement takes now say **over 33 million**
and **11 percent**, respectively. The first needed a measured 1.215× tempo fit
to its 2.733-second slot; later slots did not move. The mixed export's transcript
matches its saved script and measures **−14.41 LUFS / −1.02 dBTP**.

Live ASR spelled the correctly pronounced product “PowerDisc.” Regression
coverage now accepts that homophone spelling while refusing a different hinted
name or integer metric, independently of the overall word-error allowance.
Unchanged speech and transcript requests were demonstrably cached.

The managed macOS VM passed asset import, project readback/update, contact-sheet
rendering, and timeline UI review. Its movie test is explicitly skipped because
that development VM has no FFmpeg binary. Real nonheaded tests and the full
rebuild used the installed PwrSnap LGPL sidecar, including actual moving-video
fixtures, fitted audio, and the render utility process. No operator-desktop
BrowserWindow was opened. Live application footage was not present in the
supplied source; motion support was verified with a generated MOV fixture.

Story/copy choices and source recording remain agent work. Incremental visual
rendering is at scene granularity, and text uses explicit sizes and line breaks.
The new render contract is suitable for this worked example without reading or
depending on restricted composition frameworks.

## Initial recommendation (superseded by the operator's follow-up)

Use the existing HTML reel as the basis of a reusable launch-video template
and CLI. Keep PwrSnap for capture, library discovery, and preparing recordings.
Do not expand the current Sizzle scene model into a general launch-video
authoring system for this workload.

Sizzle successfully rendered nine precisely timed capture slots. It could not
author the elements that carry the launch reel's story: simultaneous screenshots
and terminal panels, animated headline text, a counter, typing, a logo card, or
the separately timed voice and music mix. File import and better MCP access
would help, but neither replaces that work.

This is an engineering scope judgment, not a claim that FFmpeg cannot draw
text or mix audio. Supporting this example inside Sizzle would require a new
layered visual model, independent audio tracks, render/preview parity for those
models, and an external deterministic editing interface. Those are replacements
for core composition assumptions, rather than a few additional scene tools.
The worked example already has the suitable rendering abstraction:
`window.seek(t)` deterministically constructs the entire frame at an absolute
time. Reusing it addresses the largest repeat cost directly.

## Reference inspected

The supplied `~/Movies/PwrDisk/reel-source/` contains:

- `render/reel.html`: absolute-time scene windows, eased transforms, camera
  focus, screenshot crossfades and wipes, overlapping panels, rolling numbers,
  terminal reveals, typed text/caret, badges, logo, and end card.
- `render/render.mjs`: headless browser screenshots at explicit frame times;
  an optional time range retains global frame numbers for replacement renders.
- Fifteen PNG assets and nine completed narration WAVs.
- `music.py`: seeded synthesis of a 128 BPM bed, with a drop at 7.7 seconds
  and a final hit at 29 seconds.
- `timeline.json` and `mix.sh`: nine absolute narration starts, music ducking,
  voice processing, and a final loudness target of −14 LUFS.
- Two narration text files. Their fifth line still says eighteen million;
  the HTML counter and finished video say 33,524,125. This illustrates the need
  to bind the caption, spoken number, and counter to the same value.

The reference MP4 was independently probed: 32.5 seconds, H.264, 1920 × 1080,
30 fps, with AAC audio. The copied source does not contain a generated
`music.wav` or the final mixed WAV; those must be regenerated or retained by
the reusable kit. The existing completed VO was available, so this
investigation did not need API credentials or another paid synthesis request.

## What Sizzle can replace today

The following distinguishes implementation support from the live trial.

| Worked-example operation | Current support and limitation | Evidence |
| --- | --- | --- |
| Find existing app screenshots | Available. Library search found relevant PwrDisk captures, but these were different screens and figures from the supplied PNGs. | Live `pwrsnap_library_search`. |
| Use exact PNG, MOV/MP4, or WAV files from disk | No import operation in the external MCP catalog or Sizzle chat catalog. Scenes and beats reference library capture IDs; audio has no external asset reference. The dev-only `capture:ingest` hook is not a production import API. | `mcp-tool-registry.ts`, `sizzle-tool-allowlist.ts`, `SizzleScene`/`SizzleProject` in `protocol.ts`, `capture-handlers.ts`. |
| Order shots and set fixed silent durations | Available, demonstrated with nine muted simple scenes totaling 32.5 seconds. | Live create/chat/render trial and persisted trial project. |
| Deterministic scene data | Already exists internally. `sizzle:update` accepts structured scenes; sequence beats support offset/phrase anchors and video fit policies. External MCP only exposes create/send/status/render, so an external agent must ask another model to make the edits and cannot read back the project through a dedicated tool. | `sizzle-validators.ts`, `sizzle-tool-allowlist.ts`, `local-agent-tool-service.ts`. |
| Ken Burns and transitions | Available, but image zoom is an automatic alternating central 1.0 ↔ 1.1 move. No per-shot focus, keyframes, crop animation, perspective, or arbitrary layered wipe. Several whole-frame transitions exist, including push/slide/dips. | `composer.ts` image branch and transition mapping. |
| Continuous narration over several shots | Available. Sequence scenes synthesize one narration track, resolve word/phrase timing, and lower beats into composer inputs. They require narration; muted fixed slots use simple scenes. | `sequence-planner.ts`, `speech-timing.ts`, `sizzle-handlers.ts`. |
| Narration generation and pronunciation | Basic TTS exists. Current types allow `tts-1`/`tts-1-hd` and six voices; they do not include the reference's model or `ash`. Synthesis sends `speed: 1.0` and no delivery instructions. Phonetic spelling can be put in a script, but there is no separate pronunciation map. Existing WAV takes cannot be selected. | `tts.ts` and TTS types in `protocol.ts`; code inspection, no paid call. |
| Fit a replacement VO into a 2.75-second slot | Missing. Narration duration plus a 0.35-second tail overrides an insufficient duration override, shifting subsequent scenes. There is no trim/speed/fit/reject policy for narration slots. | `sizzle-reel-duration.ts`, `sizzle-scene-duration.test.ts`, `prepareSceneInput` in `sizzle-handlers.ts`. |
| Transcription QA | Partial. Word transcription supplies timing and phrase anchors, with approximate timing fallback. It does not compare the recognized text with an expected transcript or verify the final mixed track. | `speech-timing.ts`. |
| Music, ducking, and loudness | Missing from the project schema and composer. Each visual input has one selected audio source; audio is trimmed/padded and concatenated. There is no independently timed music bed or master loudness pass. | `composer.ts` audio graph and `SizzleAudioSource` in `protocol.ts`. |
| Counter, typing/caret, terminal, cards, headline, end card | Missing as composable motion primitives. One full-frame media input per beat cannot express the reference's simultaneous positioned elements. Capture annotations can supply flattened static text, but cannot express these temporal layers. | `SceneInput`/`buildCompositionArgs` in `composer.ts`, `StageLayer.tsx`, live follow-up refusal. |
| Update one bound benchmark value | Missing. There is no binding table or dependency graph connecting narration, captions, and animation values. A script can be edited, but no counter/caption layer exists to update. | Project/scene schema. |
| Re-render only changed frames/scenes | Missing. TTS and speech timing have content-based caches, but the handler prepares the scene list and calls one whole-reel composition. There is no frame-range or scene-render cache contract. | `sizzle-handlers.ts` render handler, `composer.ts`, `tts.ts`. |
| Preview and QA frames | Low-resolution preview is available and was rendered. No Sizzle frame-at-time/contact-sheet MCP operation exists; this investigation used local FFmpeg to extract comparison frames. | Live preview; external MCP catalog. |
| Deliver somewhere visible | Already implemented and demonstrated. Full output lands in the OS videos directory under `PwrSnap`, is recorded on the project, and is returned as protected media. On this machine that was `~/Movies/PwrSnap/`. | Live full render; `sizzle-handlers.ts`. |
| Trim idle footage and place live clips | Supported for recordings already in the library. `video:inspect`/`video:edit` provide activity/still-span inspection and undoable kept-span edits; Sizzle honors cuts and has video fit policies. Arbitrary raw VM recordings are blocked at import. The PwrDisk video search returned zero matches, so no unrelated recording was edited to manufacture a trial. | Live video-filtered search; `recording-handlers.ts`, `sizzle-media-trim.ts`, `sizzle-video-fit.ts`. |

The main source references are the
[project/scene types](../../packages/shared/src/protocol.ts),
[external MCP catalog](../../apps/desktop/src/main/local-agents/mcp-tool-registry.ts),
[external tool service](../../apps/desktop/src/main/local-agents/local-agent-tool-service.ts),
[composition-chat catalog](../../apps/desktop/src/main/ai/sizzle-tool-allowlist.ts),
[render handler](../../apps/desktop/src/main/handlers/sizzle-handlers.ts),
[FFmpeg composer](../../apps/desktop/src/main/sizzle/composer.ts),
[TTS implementation](../../apps/desktop/src/main/sizzle/tts.ts),
[speech timing](../../apps/desktop/src/main/sizzle/speech-timing.ts), and
[preview layer](../../apps/desktop/src/renderer/src/features/sizzle/StageLayer.tsx).

## The actual MCP trial

1. Searched the live library for PwrDisk screenshots. The exact supplied
   files were not importable through the available tools.
2. Called `pwrsnap_sizzle_create` with five relevant capture IDs and a detailed
   brief describing the source folder, nine slots, desired animations, existing
   VO/music, and a muted approximation to avoid TTS charges.
3. Polled `pwrsnap_sizzle_status` until idle. The composer searched for
   additional relevant stills and authored nine muted scenes with cuts and
   these slot lengths: **3.4, 2.45, 2.25, 4.95, 2.75, 3.95, 5.25, 4, 3.5 s**.
4. Rendered using `pwrsnap_sizzle_render_preview`. It returned a 640 × 360,
   32.5-second protected video resource.
5. Sent a follow-up using `pwrsnap_sizzle_send`, explicitly requesting the
   counter, typing/caret, and exact local PNG/WAV assets. The internal composer
   reported that these were unsupported and left the scene list unchanged.
6. Rendered using `pwrsnap_sizzle_render_full`. Independent `ffprobe` decoding
   counted **975 frames at 1920 × 1080, 30 fps, 32.500000 s**, H.264 with AAC.
   The full file was present in `~/Movies/PwrSnap/` and the project retained it.
7. Extracted matching nine-frame contact sheets from the reference and preview
   and inspected both. The result preserved slot timing but omitted all launch
   graphics and used different source imagery. For example, the reference's
   seven removals/1.2 GiB became an old library capture showing six/35 GiB.
   This is a feasibility artifact, not a publishable replacement reel.

### Where the agent had to leave the tools

- **Assets:** exact PNGs and completed WAVs could not enter the project. The
  library substitution was necessary before the first render.
- **Readback:** external status returned only streaming/idle state, without
  the assistant's response or scene snapshot. Reading the newly created trial's
  project JSON and chat journal was necessary to verify edits and obtain its
  unsupported-feature response. No application files were modified directly.
- **Visual QA:** frame extraction, contact sheets, and media probing required
  local FFmpeg/ffprobe. These were read-only operations on the videos plus
  writes to ignored test artifacts in this worktree.
- **Production finishing:** exact layout/animation, supplied VO, music mixing,
  and a bound-number revision would all still require an external pipeline.
  They were deliberately not hand-built again to label the result a Sizzle
  success.

No capture database was changed outside the normal MCP tools. No operator
desktop windows, headed E2E, lab sessions, public posts, or public media uploads
were needed. No secrets were read. No dependencies or application code changed.

Local evidence is under the investigating worktree's ignored
`test-results/sizzle-feasibility/`: `trial.json`, `reference-contact.png`, and
`sizzle-contact.png`. These contain real user media and are not repository
fixtures or PR attachments. The live trial project is named
**PwrDisk launch — Sizzle feasibility trial**.

The focused unit-suite command was attempted with the repository's pinned
Node 24.22.0, but this checkout had no installed Vitest executable
(`Command "vitest" not found`). No unit-test pass is claimed. The rendering,
frame count, file delivery, project readback, and visual comparison above were
actually performed against the running application. A documentation-only
assessment did not require installing the workspace dependencies.

## Reusable kit that would reduce the next reel's cost

The smallest suitable artifact is a local, permissively licensed **template
plus CLI** around the supplied HTML, not a new general video framework.
This investigation recommends it; it does not claim to have implemented it.

The reusable unit should contain:

- **A validated manifest:** output dimensions/fps, integer frame ranges, named
  assets, absolute scene/VO slots, theme, and one binding table. A binding such
  as `fileCount: 33524125` supplies the formatted counter, caption, and spoken
  representation. Content revisions edit the manifest instead of JavaScript.
- **A small existing-pattern vocabulary:** screenshot frame, positioned image
  or video, camera keyframes, headline, counter, typing/caret, terminal reveal,
  chips, and logo/end card. Preserve the reference's deterministic `seek(t)`;
  no arbitrary generated per-reel animation code should be necessary for its
  existing scene shapes.
- **Local asset inputs:** PNG and raw MOV/MP4 paths plus explicit source trims
  and kept spans. For frame rendering, video must seek and finish decoding the
  requested source frame before capture. Already-imported PwrSnap recordings
  can first be inspected, cut, and exported with PwrSnap's tools.
- **An independent narration stage:** display text, spoken substitutions,
  delivery/voice options, saved takes, silence trimming, bounded speed fitting,
  and recognized-text QA. An overlong line must return a measured fit failure
  rather than move later scenes. Reuse the nine existing WAVs for the first
  conversion; credential access belongs in the process environment/secret
  adapter and never in the manifest, render hashes, or logs.
- **One audio finishing stage:** generated or supplied music, absolute VO
  placement, sidechain ducking, and final loudness measurement/normalization.
  Preserve the seeded music generator so a rerun does not change the score.
- **Incremental output and inspection:** hash each scene's resolved data,
  assets, fonts, renderer version, and dimensions; render only invalidated
  frames/segments. Include overlap/transition dependencies. Audio-only changes
  remix without re-rendering pictures. Commands for frame, contact sheet,
  preview, and full render all use the same timeline.
- **A visible receipt:** final movie under `~/Movies/<project>/` (the OS videos
  equivalent on Windows), with the manifest, transcript/fit report, and QA
  contact sheet next to it. Return these paths explicitly.

For the known benchmark change, one binding edit should invalidate the
benchmark scene and its affected narration take. The rest of the pictures and
VO stay cached; the audio is remixed and the full movie remuxed. This directly
replaces the manual 12.5–16.5-second frame patch plus caption/counter/VO edits.

Use browser rendering, existing permissive project code, and the vetted
PwrSnap FFmpeg encoding approach. The reference's `libx264` command must not be
copied into PwrSnap's shipped encoder path, which uses OS H.264 encoders and
native AAC. No Remotion, HyperFrames, or other restricted framework is needed.

If this kit proves useful across multiple launches, Sizzle can later host its
validated manifest and renderer behind the existing command bus and OAuth
capability checks. That would be an explicit new composition contract. Adding
isolated features to today's capture/narration scenes first would leave the
largest demonstrated authoring cost in the external HTML pipeline.
