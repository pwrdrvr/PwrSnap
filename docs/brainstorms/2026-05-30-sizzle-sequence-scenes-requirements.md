---
date: 2026-05-30
topic: sizzle-sequence-scenes
---

# Sizzle Sequence Scenes

## Summary

PwrSnap Sizzle Reels should support narrated sequence scenes: one continuous narration block controlling a timed sequence of image and video beats. This lets app-demo reels move quickly through UI steps, short clips, and screenshots without forcing one text-to-speech block per asset or freezing tiny videos under long narration.

---

## Problem Frame

The current Sizzle model works acceptably for simple image slideshows because an image can stay on screen for exactly as long as the voiceover needs. It breaks down for app-demo reels, where the user often wants one smooth spoken explanation over many fast visual steps.

Short video clips expose the worst version of the problem. A one- or two-second video can have six seconds of narration attached, and the current fallback holds the final frame until the voiceover ends. That preserves duration but looks bad: the viewer sees motion, then a dead frame.

The existing scene shape also makes sequential demos awkward. A natural narration might say, "start from the Wizard or from Settings, enable Telegram, generate the code, send it from Telegram, approve the pairing, and you're set." The visuals should advance at the relevant words, sometimes faster than one second per asset. Splitting that into many independent TTS blocks would sound choppy and make timing harder instead of easier.

---

## Actors

- A1. Reel author: Builds short app-demo reels from captures and expects the output to look intentional without manual video-editing work.
- A2. Sizzle composer agent: Searches captures, writes narration, proposes visual timing, and edits the reel through approved tools.
- A3. Viewer: Watches the rendered reel and needs the visual sequence to track the narration without stalls, confusing jumps, or awkward audio seams.
- A4. Renderer: Turns the reel plan into a preview and final MP4 while preserving timing and media-fit decisions.

---

## Key Flows

- F1. Compose a narrated UI sequence
  - **Trigger:** The reel author asks the agent to make a reel from several captures that show a product workflow.
  - **Actors:** A1, A2
  - **Steps:** The agent finds relevant captures, groups related visual steps into one sequence scene, writes one narration block, assigns visual beats to images or videos, and proposes timing anchors.
  - **Outcome:** The reel has one smooth spoken segment with multiple visuals changing underneath it.
  - **Covered by:** R1, R2, R3, R19, R20, R22

- F2. Fit a short video beat to narration timing
  - **Trigger:** A visual beat uses a video clip whose source duration is shorter or longer than its intended on-screen duration.
  - **Actors:** A1, A2, A4
  - **Steps:** The beat declares how the clip should adapt, the renderer applies that policy, and the author can override bad automatic choices.
  - **Outcome:** Short clips loop, speed-adjust, or otherwise fit the slot instead of silently freezing on the final frame.
  - **Covered by:** R5, R6, R7, R8, R9

- F3. Time visuals against speech
  - **Trigger:** A sequence scene has narration and beats that should appear at specific words or phrases.
  - **Actors:** A1, A2, A4
  - **Steps:** Narration is synthesized or otherwise measured, speech timing is attached to the scene, phrase anchors are resolved into seconds, and beat start/end times are finalized.
  - **Outcome:** The visual sequence follows the spoken explanation closely enough that the viewer sees the referenced screen when the narrator names it.
  - **Covered by:** R3, R10, R11, R12

---

## Requirements

**Sequence scene model**

- R1. A Sizzle project must support a scene type that contains one narration block and an ordered list of visual beats.
- R2. Each visual beat must reference one image or video capture and define when it appears within the sequence scene.
- R3. Beat timing must support both explicit second offsets and narration-relative anchors such as a word or phrase in the narration.
- R4. Existing single-asset scenes must remain representable as a one-beat sequence, even if the UI continues to show them in a simpler form.

**Video duration handling**

- R5. A video beat must declare a fit policy for handling mismatch between source clip duration and intended beat duration.
- R6. The default video fit policy must avoid silent final-frame holds when a more natural option is available.
- R7. Supported fit policies should cover at least normal trim, freeze-end, loop, ping-pong, speed-to-fit, and smart-fit.
- R8. Smart-fit must be allowed to choose among safe adaptation strategies, but it must remain inspectable and overridable by the user or agent.
- R9. Duration adaptation must have sane limits so a clip is not made absurdly fast, slow, or repetitive without the author explicitly choosing that.

**Narration timing**

- R10. The reel must store or derive timing metadata for narration well enough to align visual beats to spoken phrases.
- R11. The agent must be able to propose beat timing in human terms first, then have the system resolve that into concrete times.
- R12. If speech timing is unavailable or low confidence, the system must fall back to editable approximate timing rather than blocking reel creation.

**Transitions**

- R13. Transitions must exist at both scene boundaries and beat boundaries.
- R14. Beat-level transitions should default to fast, low-friction choices suitable for rapid UI walkthroughs.
- R15. Sequence scenes must allow some beat boundaries to use no transition, because fast app demos often look better as direct visual cuts.
- R16. Transition definitions must include type and duration, rather than relying only on a global fixed-duration crossfade.
- R17. The initial expanded transition set should prioritize practical app-demo transitions: cut, crossfade, dip-to-black, dip-to-white, push or slide, and simple zoom-cut.
- R18. Audio continuity must be owned by the sequence scene narration, not by each visual beat, so beat transitions do not chop the spoken track.

**Agent behavior**

- R19. The Sizzle composer agent must be able to create and edit sequence scenes, not only one-capture scenes.
- R20. The agent must be able to set beat order, beat timing, beat transition, video fit policy, and narration text within one sequence scene.
- R21. Agent-created timing should be presented as an editable proposal, because automatic phrase matching and visual pacing will sometimes be wrong.
- R22. The agent should prefer sequence scenes when the user asks for a workflow, progression, setup flow, or "show this sequence" style reel.

**User experience**

- R23. The composer UI must make sequence scenes understandable without requiring the author to think like a video editor.
- R24. A sequence scene should show its narration and visual beats together, so the author can see which asset appears at which point in the narration.
- R25. The author must be able to preview a sequence scene before rendering the full reel.
- R26. Warnings should appear when a beat uses a risky fit policy, extreme speed change, very short visual duration, or unresolved narration anchor.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R18.** Given a sequence scene with one narration block and five visual beats, when the reel renders, the narration plays continuously while the visuals advance through all five beats.
- AE2. **Covers R3, R10, R11.** Given a beat anchored to the phrase "Settings screen," when speech timing is available, the beat starts near the spoken phrase rather than at a manually guessed scene boundary.
- AE3. **Covers R5, R6, R7.** Given a one-second video beat assigned to a four-second visual slot, when smart-fit is used, the output does not freeze the last frame for three seconds unless freeze-end was explicitly chosen or all better options are rejected by limits.
- AE4. **Covers R13, R14, R15, R16.** Given a rapid sequence of four screenshots under one sentence of narration, when beat transitions are set to cuts or short crossfades, the visuals advance quickly without creating separate audio seams.
- AE5. **Covers R21, R24, R26.** Given an agent-created sequence with approximate timing, when the author opens the scene, they can inspect the beat timing and see warnings for unresolved or suspicious anchors.

---

## Success Criteria

- A reel author can ask for a workflow reel from several captures and get one smooth narrated sequence instead of many disconnected scene scripts.
- Short video clips no longer default to visibly bad final-frame holds when they need to occupy a longer narration slot.
- The agent can describe visual timing in terms of narration and then convert that into renderable timing with user-editable results.
- Planning can proceed without inventing the product shape for sequence scenes, video fit policies, beat-level transitions, or narration timing.

---

## Scope Boundaries

- This is not a full nonlinear video editor. The goal is guided app-demo sequencing, not arbitrary multi-track editing.
- This does not require building every transition style before sequence scenes ship.
- This does not require perfect automatic timing on v1. Editable approximate timing is acceptable when precise speech timestamps are unavailable.
- This does not require mixing native clip audio with narration in v1. Sequence narration is the primary audio track unless a later design adds ducking or layered audio.
- This does not require replacing the existing single-scene composer UI immediately; single-asset scenes can remain as the simple case.

---

## Key Decisions

- Sequence scenes are the core improvement: They solve narration flow and visual progression at the same time.
- Beat-level transitions are needed: Scene-level transitions alone cannot describe fast visual changes within one narrated idea.
- Beat transitions should be modest by default: Cuts and short fades fit UI demos better than decorative motion.
- Video fit policy should be explicit: Silent final-frame hold should become a chosen behavior, not a hidden renderer fallback.
- Narration timing should be a first-class concept: The agent and renderer need timing information to align visuals to the words being spoken.

---

## Dependencies / Assumptions

- The Sizzle composer chat remains the main way to create and refine complex sequence timing.
- Final render and preview must agree closely enough that beat timing decisions can be trusted before export.
- Speech timing may come from the TTS provider, a later alignment pass, or an approximation; the requirements only assume a capability boundary, not one specific provider.
- Existing projects will need compatibility behavior so older scene records still render and can be upgraded or edited safely.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3, R10][Needs research] Which speech-timing source should v1 use: provider timestamps, forced alignment, heuristic timing, or a staged combination?
- [Affects R7, R9][Technical] What are the safe speed and loop limits for smart-fit before output looks worse than a freeze?
- [Affects R13-R17][Technical] Which transitions are practical in the current renderer, and which require the deferred preview/render architecture work?
- [Affects R23-R25][Design] Should the sequence editor be a compact beat list, a mini timeline, or narration text with inline visual anchors?
- [Affects R18][Technical] When native video audio is later mixed with narration, how should ducking and transitions interact with sequence scenes?
