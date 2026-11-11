---
name: pwrsnap-sizzle-reels
description: Build and revise short launch or demo videos through PwrSnap MCP using app footage, continuous narration, music and an editable timeline. Use for authoring reels, not recording an external app or administering PwrSnap releases.
---

# PwrSnap Sizzle Reels

Use PwrSnap's deterministic timeline tools to author the reel as editable data.
The connected desktop's tool schemas are authoritative. This skill describes
product operations; it does not grant access to media or permission to publish.

## Discover and choose the workflow

Skill-aware MCP hosts discover this skill with `skills/list` or `skills/get`
and verify its complete manifest when loading it. Generic resource reads and
`pwrsnap_sizzle_skill` return ordinary guidance; they do not activate a skill
or grant additional permissions.

Read [the timeline reference](references/timeline.md) for concrete tool inputs,
a minimal timeline, launch-template fields, phrase cues and audio policies.
Through MCP, read `skill://pwrsnap-sizzle-reels/references/timeline.md`
or call `pwrsnap_sizzle_skill({path: "references/timeline.md"})`.

Start with `pwrsnap_sizzle_create`, then use `pwrsnap_sizzle_get` for assets,
timeline and `modifiedAt`. Use `pwrsnap_sizzle_apply_launch_template` for an
editable nine-scene starting point, or `pwrsnap_sizzle_update` for a custom
integer-frame timeline. Neither requires a composition chat. Always use the
current revision as `expectedModifiedAt`; on a conflict, read and reconcile
the saved project before another update.

## Choose real footage and keep its meaning

Find authorized library media with `pwrsnap_library_search`. Inspect recordings
with `pwrsnap_video_inspect` before trimming; `pwrsnap_video_edit` changes the
library recording's edits. Import its current edited state with
`pwrsnap_sizzle_import_capture` to retain a reproducible snapshot. Import
explicitly selected local image/video/audio files with `pwrsnap_sizzle_import`;
that separate media-import permission is required even for Full Access sessions
approved before it existed. A permission refusal requires an operator grant,
not an alternate filesystem path.

Place recordings as video layers with source ranges, playback rate and
contain/cover framing. Use measured clip times, not nominal VFR stream-copy
cut durations. Actual app motion conveys scans, selection, agent actions and
results; camera movement over stills cannot demonstrate those interactions.
If footage is missing, identify that capture task rather than inventing it.
Verify captions and claimed results against what the take actually shows.

## Keep narration continuous across pictures

For a narration-led reel, prefer one complete `narrationText` or
`voiceoverAsset`. Visual transitions then move independently of the audio.
Per-scene takes are available when deliberately requested; do not split one
continuous narration into scene-sized slots. Preserve the user's pacing,
voice and pronunciation choices. Literal pronunciation substitutions control
spoken brand names; `takeId` requests a fresh generated take.

`pwrsnap_sizzle_prepare_narration` prepares/auditions one take and returns a
managed audio asset, expected text, words and a new revision. To lock it for
offline rendering, set the voice source to that asset. Keeping a speech source
lets later bound copy regenerate narration. Preparation can bill speech and
transcription; frame inspection does not. Failed wording QA is a correction
point, not permission for an unattended paid retry loop.

Use `pwrsnap_sizzle_align_narration` with phrase-start/end cues for each scene
after the first. Inspect returned word spellings and occurrences if a cue
fails. The tool saves measured visual boundaries without slicing the voice.
Re-align after spoken copy changes. Voice overruns are refused; revise the
script, requested delivery speed or total duration rather than clip endings.

## Mix and revise

Audio tracks are independent of scenes. Add supplied music/sound assets or a
sample-free `synth` music source, with explicit timing, gain and fades. Video
layers are silent unless audio is placed as its own track. Use `mix` for music
ducking and loudness; the default target is -14 LUFS. Use music licensed for the user's
intended distribution and preserve its provenance. Synth music uses no samples.

Bind changing metrics/captions/generated speech once, then revise them with
`pwrsnap_sizzle_set_bindings`. A supplied recording does not change its spoken
number when a binding changes. Re-rendering reuses unaffected scenes/audio;
the cache replaces affected scenes, not arbitrary frame ranges within them.

## Inspect and deliver

Use `pwrsnap_sizzle_inspect_frames` for up to 12 frames/contact-sheet samples.
Check text fit, aspect ratio, transition boundaries and meaningful app states.
Render a preview to judge motion, delivery, music and narration endings. Listen
to the mixed result; frame inspection and the legacy muted-scene player do not
verify the timeline's audio. The timeline viewer plays its rendered MP4.

Use `pwrsnap_sizzle_render_full` for delivery. Return its protected typed MCP
media link to a supported media handler; do not invent resource URIs or expose
private cache paths. Full output is also saved under the OS videos folder's
`PwrSnap` directory with timeline/report sidecars. Use the returned output
location when available. `pwrsnap_sizzle_audio_qa` checks the final mix's
transcript and loudness and may bill transcription; it cannot judge delivery
or visual truth. State any checks that could not be completed.

Stop on an unavailable desktop, denied session or missing permission and
report the actual blocker. Reconnect/rediscover manually after an app upgrade;
loaded guidance and tool schemas do not refresh themselves. Rendering a reel
does not authorize posting it or messaging anyone.
