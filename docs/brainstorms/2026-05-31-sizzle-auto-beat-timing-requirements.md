---
date: 2026-05-31
topic: sizzle-auto-beat-timing
---

# Sizzle Auto Beat Timing + Reorder

## Summary

Sequence beats should default to **auto timing** — no hand-entered start or
length. A beat is either *anchored* to the narration (a "keyframe": an explicit
second offset or a spoken-phrase anchor) or *auto*, in which case its position
is derived by evenly dividing the time between the anchors that bound it. Because
auto beats carry no timing of their own, beats become freely **reorderable**
(drag-and-drop, not just up/down arrows). This makes building an app-demo
sequence feel like arranging cards, not authoring a timeline.

This document pins the semantics so the schema + planner + UI change can be
implemented without guessing. It follows
[the sequence-scenes requirements](2026-05-30-sizzle-sequence-scenes-requirements.md)
and resolves its deferred design question *"Should the sequence editor be a
compact beat list, a mini timeline, or narration text with inline visual
anchors?"* in favor of **a compact, mostly-auto beat list**.

---

## Problem Frame

Today every beat must carry an explicit anchor: `offset` (a hard start in
seconds) or `phrase` (a narration anchor). New beats are created as `offset`
beats with a guessed integer start. Consequences:

- The author has to think in seconds for visuals that don't need precise
  timing — most app-demo frames just want to "fit in between the moments that
  matter."
- Reordering is incoherent. The ↑/↓ arrows (`moveSequenceBeat`) swap array
  positions but leave each beat's hard start untouched, so a beat can end up
  with a start *later* than the beat after it. The planner then clamps it to a
  near-zero window and emits a diagnostic.
- There is no cheap way to say "show these three screenshots evenly between the
  two narrated moments." You'd hand-compute thirds.

The fix is a first-class **auto** beat plus an **even-division** rule, which
together make ordering — not numeric timing — the primary authoring act.

---

## Actors

- **A1. Reel author** — arranges beats by dragging; only types timing for the
  few beats that must land on a spoken word.
- **A2. Sizzle composer agent** — writes narration, anchors the beats the script
  names, and leaves the rest `auto`.
- **A4. Renderer / planner** — turns the (mostly anchorless) beat list into
  concrete per-beat windows.

---

## Key Flows

- **F1. Even-divide auto beats between two keyframes.**
  - Trigger: author drops three screenshots between two phrase-anchored beats.
  - Outcome: the span between the two anchors is split evenly; the screenshots
    appear in equal slices with no manual timing.
  - Covered by: R1, R2, R3.

- **F2. Reorder by dragging.**
  - Trigger: author drags an auto beat to a new position.
  - Outcome: order changes; no timing fixup is needed because auto beats derive
    position from their neighbors.
  - Covered by: R5, R6.

- **F3. Anchor only what matters.**
  - Trigger: the narration says "open the Settings screen"; the author anchors
    that one beat to the phrase and leaves the surrounding beats auto.
  - Outcome: the anchored beat lands on the phrase; the autos flow around it.
  - Covered by: R3, R4.

---

## The even-division rule (canonical)

Terminology:

- **Anchored beat** ("keyframe") — `offset` or `phrase` timing; resolves to a
  concrete start time `t`.
- **Auto beat** — no timing; start derived.
- The **first beat is always an implicit anchor at 0** (there is no earlier
  visual to cover the narration before it), whether it is typed `auto` or
  anchored.
- The **sequence end** (timeline duration, or the next scene boundary) is the
  trailing implicit anchor.

Rule: take an anchored beat **A** at time `tA`, followed by **N** consecutive
auto beats, followed by the next anchor **B** at time `tB` (B may be the
sequence end). Divide `[tA, tB]` into **N + 1** equal slices of width
`s = (tB − tA) / (N + 1)`:

| Beat | Start | Shows for |
|---|---|---|
| A (anchor) | `tA` | slice 0 |
| auto₁ | `tA + 1·s` | slice 1 |
| auto₂ | `tA + 2·s` | slice 2 |
| … | … | … |
| autoₙ | `tA + N·s` | slice N |
| B (anchor) | `tB` | — |

Worked example (the founder's): keyframe₁ … [auto, auto, auto] … keyframe₂ →
divide the span into **4**; keyframe₁ shows 25%, then each auto 25%, then
keyframe₂ from `tB` onward.

Boundary behavior:

- **Trailing autos** (after the last real anchor): `tB` = sequence end.
- **All-auto sequence** (only the implicit first-beat anchor at 0): the whole
  `[0, duration]` divides evenly across the beats — matches today's
  phrase-unresolved fallback `(duration / n) · index`.
- **Adjacent anchors** (no autos between): A simply runs until B's start, as
  today.
- A non-final beat always ends at the next beat's start (existing "continuity"
  invariant — beats are start anchors, not independent clips).

---

## Requirements

**Timing model**

- R1. A beat must support a third timing kind, `auto`, that carries no start or
  length.
- R2. Auto beats between two anchors must be placed by the even-division rule
  above; the leading anchor occupies the first slice.
- R3. Anchored beats (`offset` / `phrase`) keep their current meaning and are the
  fixed points the autos divide between.
- R4. `auto` must be the default timing for newly added beats (UI and agent),
  because most app-demo frames don't need precise timing.

**Reordering**

- R5. Beats must be reorderable by drag-and-drop, in addition to the existing
  ↑/↓ arrows.
- R6. Reordering must require no timing edits for auto beats. Anchored beats keep
  their anchors across a move (see Decision D2).

**Compatibility**

- R7. The schema change must be additive: existing `offset` / `phrase` beats
  render unchanged, with no migration.
- R8. The planner, validators, and the agent's beat-editing tool schema must all
  accept `auto`.

**UX**

- R9. An auto beat shows no start/length inputs — only its asset, video-fit,
  transition, reorder handle, and remove control.
- R10. Warn when even-division produces a very short slice (e.g. many autos in a
  tiny span), consistent with the existing risky-timing warnings.

---

## Decisions (proposed — confirm before/at implementation)

- **D1. Video auto-length = fill the slice via `videoFit`.** An auto video beat
  occupies its computed even-division slice; the existing `videoFit` policy
  (smart-fit / loop / speed / freeze / trim) adapts the clip to that slice.
  *Rejected alternative:* let a video's natural duration define its slice and
  push later autos out — this makes slices variable-width and breaks the simple
  "divide evenly" mental model. The founder's framing ("auto start / auto
  length") reads as equal slices with the clip adapting.

- **D2. Reordering keeps anchors.** Dragging an anchored beat keeps its
  `offset`/`phrase` anchor; the planner clamps/diagnoses an out-of-order anchor
  exactly as today. *Alternative considered:* auto-convert a dragged anchored
  beat to `auto`. Rejected as surprising (silent data loss of the anchor).

- **D3. First beat stays pinned to 0.** Whether the first beat is `auto` or
  anchored, its start is 0 — it is the leading slice of the first span.

- **D4. "Add next scene" is removed (done).** Merging the following standalone
  scene into a sequence by string-concatenating its script belongs to the AI
  chat ("add the next screen as a beat"), not a dedicated button. `+ Beat`
  (Library picker) and the top `+ Add scene` cover the rest.

---

## Acceptance Examples

- AE1. **R1, R2.** Given keyframe₁ at 2s and keyframe₂ at 10s with three auto
  beats between them, the autos render at 4s, 6s, 8s (slices of 2s) and
  keyframe₁ covers 2–4s.
- AE2. **R5, R6.** Given four auto beats, dragging the last to the front
  reorders them and the render still divides the span evenly — no timing edits.
- AE3. **R3.** Given an auto beat dragged between two phrase-anchored beats, it
  lands midway between the resolved phrase times.
- AE4. **R7.** Given a project saved before this change (all `offset`/`phrase`
  beats), it opens and renders identically with no migration step.
- AE5. **D1, R10.** Given a 1s span with five auto beats, each ~0.2s, the editor
  surfaces a "very short beat" warning but still renders.

---

## Proposed Implementation (for the follow-up plan)

- **Schema** ([packages/shared/src/protocol.ts](../../packages/shared/src/protocol.ts)):
  add `| { kind: "auto" }` to `SizzleBeatTiming`. Update
  `normalizeSizzleSequenceBeatContinuity` so the first-beat / non-final-end
  rules treat `auto` as a no-op (nothing to null).
- **Planner** ([apps/desktop/src/main/sizzle/sequence-planner.ts](../../apps/desktop/src/main/sizzle/sequence-planner.ts)):
  rewrite the `starts` computation in `resolveBeatWindows` to resolve anchors
  first, then fill auto runs by even division between the bounding anchors
  (implicit 0 at the head, duration at the tail). Ends remain "next beat's
  start". Add the short-slice diagnostic.
- **Validators** ([apps/desktop/src/main/handlers/sizzle-validators.ts](../../apps/desktop/src/main/handlers/sizzle-validators.ts))
  and the **agent beat tool schema**
  ([apps/desktop/src/main/ai/sizzle-tool-catalog.ts](../../apps/desktop/src/main/ai/sizzle-tool-catalog.ts)):
  accept `auto`; teach the system prompt to prefer it.
- **UI** ([SizzleApp.tsx](../../apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx)):
  default new beats to `auto`; add "Auto" to the timing `<select>`; hide
  start/length inputs for auto; add a drag handle + drop reorder calling the
  existing `moveSequenceBeat` machinery (generalized to an arbitrary
  from→to move).
- **Tests:** planner unit tests for each even-division case (AE1–AE3, boundary,
  all-auto); a renderer test that new beats default to auto and that drag
  reorder updates order; schema round-trip for `auto`.

---

## Scope Boundaries

- Not a free-form keyframe editor — only even division between anchors.
- No per-auto manual nudging in v1; if you need precision, anchor the beat.
- No change to the speech-timing source or phrase resolution.

---

## Outstanding Questions

- [D1] Confirm equal-slice video behavior vs clip-natural-length.
- [D2] Confirm anchored beats keep their anchor on drag (vs convert-to-auto).
- [R10] What slice length should trigger the "too short" warning (e.g. < 0.4s)?
- Should the agent ever emit `offset` (hard seconds), or only `phrase` + `auto`?
