---
title: Sizzle Auto Beat Timing + Drag Reorder
type: feat
status: active
date: 2026-05-31
origin: docs/brainstorms/2026-05-31-sizzle-auto-beat-timing-requirements.md
---

# ✨ Sizzle Auto Beat Timing + Drag Reorder

## Overview

Give Sizzle sequence beats a third timing kind, **`auto`** (no hand-entered
start or length). Runs of auto beats between two *anchored* beats ("keyframes" —
`offset` seconds or `phrase` anchors) split the time between those anchors
**evenly**. Because auto beats carry no timing of their own, beats become freely
**reorderable** by drag-and-drop. Auto becomes the default for new beats (UI and
the AI composer), so arranging an app-demo sequence is card-shuffling, not
timeline authoring.

Origin: [docs/brainstorms/2026-05-31-sizzle-auto-beat-timing-requirements.md](../brainstorms/2026-05-31-sizzle-auto-beat-timing-requirements.md).
Predecessor (the feature this extends):
[2026-05-30 sizzle-sequence-scenes plan](2026-05-30-001-feat-sizzle-sequence-scenes-plan.md)
and its retro
[docs/solutions/2026-05-30-sizzle-sequence-scenes.md](../solutions/2026-05-30-sizzle-sequence-scenes.md).

## Problem Statement

Today every beat carries an explicit anchor — `offset` (hard seconds) or
`phrase` — and new beats are seeded as `offset` with a guessed integer start
(`SizzleApp.tsx` `beatFromScene`). Consequences (see origin: Problem Frame):

- Authors must think in seconds for visuals that only need to "fit between the
  moments that matter."
- Reordering is incoherent: the ↑/↓ arrows (`moveSequenceBeat`) swap array
  positions but leave each beat's hard start untouched, so a beat can end up
  starting *after* the beat that follows it. The planner then clamps to a
  near-zero window and emits a `beat_duration_clamped` diagnostic.
- There is no cheap way to say "show these three screenshots evenly between the
  two narrated moments."

The fix is a first-class `auto` beat + an **even-division** rule that makes
*ordering* — not numeric timing — the primary authoring act, plus drag-to-reorder.

## Proposed Solution

1. Add `{ kind: "auto" }` to `SizzleBeatTiming` (additive union; no migration).
2. Extract the even-division math into **one shared pure function** in
   `@pwrsnap/shared`, consumed by both the main-process planner
   (`resolveBeatWindows`) and the renderer's idle-preview fallback
   (`fallbackSequenceBeats`) so preview, the editor strip, and the final MP4 can
   never disagree.
3. Make the function **monotonic** — effective anchor times are clamped
   non-decreasing — so reordering can never produce a negative slice. This is the
   load-bearing fix the origin's reorder goal actually requires (see
   [Decisions D5/D6](#decisions)).
4. Move the "first beat starts at 0" rule from data-mutation into a **planner
   rule** so a phrase anchor dragged to the front is *parked*, not destroyed
   (resolves the D2↔D3 contradiction).
5. Default new beats (UI + agent) to `auto`; hide value inputs for auto beats but
   keep the timing-kind `<select>` so a beat can be promoted/demoted.
6. Drag-and-drop reorder mirroring `CartPanel.tsx`'s HTML5 DnD, persisting through
   the existing 350ms coalesced project-update path and invalidating in-flight
   preview.

---

## Technical Approach

### Architecture

**One shared even-division function.** New pure function in
[packages/shared/src/protocol.ts](../../packages/shared/src/protocol.ts) (where
`normalizeSizzleSequenceBeatContinuity` and `resolveSizzleAudioSource` already
live — the latter is shared *specifically* to avoid the "guaranteed-divergence
footgun" of duplicating logic across main+renderer):

```ts
// packages/shared/src/protocol.ts
// Each entry: a resolved anchor time in seconds, or null for an "auto" beat
// (and for an anchor that failed to resolve — it degrades to auto). Index 0 is
// always treated as the head anchor at 0 (the first beat covers narration from
// the start; see Decision D3-revised). Returns a concrete start per beat with
// MONOTONIC, non-negative slices.
export function distributeSequenceBeatStarts(
  anchors: ReadonlyArray<number | null>,
  durationSec: number
): number[] {
  const n = anchors.length;
  if (n === 0) return [];
  const dur = Math.max(0.1, durationSec);
  const starts = new Array<number>(n);
  starts[0] = 0;                       // D3-revised: head anchor pinned to 0
  let runAnchorIdx = 0;
  let runAnchorTime = 0;
  for (let i = 1; i < n; i++) {
    if (anchors[i] === null) continue; // auto (or unresolved) — fill later
    const t = clamp(anchors[i]!, runAnchorTime, dur); // D6: monotonic clamp
    fillEvenly(starts, runAnchorIdx, runAnchorTime, i, t);
    starts[i] = t;
    runAnchorIdx = i;
    runAnchorTime = t;
  }
  fillEvenly(starts, runAnchorIdx, runAnchorTime, n, dur); // trailing run → end
  return starts.map(roundSec);
}

// Beats (anchorIdx+1 .. boundIdx-1) are autos. Divide [tA, tB] into
// (autoCount + 1) equal slices; the leading anchor keeps slice 0.
function fillEvenly(starts, anchorIdx, tA, boundIdx, tB) {
  const autoCount = boundIdx - anchorIdx - 1;
  if (autoCount <= 0) return;
  const s = (tB - tA) / (autoCount + 1);
  for (let k = 1; k <= autoCount; k++) starts[anchorIdx + k] = tA + k * s;
}
```

This generalizes the existing all-auto fallback `(duration / n) * index`
([sequence-planner.ts:204](../../apps/desktop/src/main/sizzle/sequence-planner.ts))
and is the *only* place the N+1 division lives.

**Two callers, each resolving anchors their own way, then calling the shared fn:**

- **Main planner** — [sequence-planner.ts](../../apps/desktop/src/main/sizzle/sequence-planner.ts)
  `resolveBeatWindows` (~:182). Build `anchors[]`: `offset` → `clamp(startSec)`;
  `phrase` → `resolvePhraseTiming(...)` or `null` if unresolved (**Decision D7:
  an unresolved phrase degrades to auto** + keep the `phrase_unresolved`
  diagnostic); `auto` → `null`. Call `distributeSequenceBeatStarts`. The existing
  END pass (`endSec = nextStart ?? duration`, ~:215) and min-duration clamp
  (`beat_duration_clamped`, ~:217) are unchanged and now always see monotonic
  starts. Add the short-slice diagnostic (R10). **Parity is automatic**: both
  preview (`planSequenceTimeline`) and render (`planSequenceScene`) funnel through
  `resolveBeatWindows` (confirmed: `planSequenceScene:49` → `planSequenceTimeline`
  → `resolveBeatWindows:147`).
- **Renderer idle fallback** — [SizzleApp.tsx](../../apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx)
  `fallbackSequenceBeats` (~:134). No speech timing here, so build `anchors[]`:
  `offset` → seconds; `phrase`/`auto` → `null`. Call the **same**
  `distributeSequenceBeatStarts`. Replaces the divergent
  `(durationSec / beats.length) * index` math (~:140).

**First-beat rule moves out of the data layer.**
`normalizeSizzleSequenceBeatContinuity`
([protocol.ts:692](../../packages/shared/src/protocol.ts)) currently rewrites a
first-beat `phrase` → `offset:0` and forces `offset.startSec = 0` — destroying the
anchor. Change: **stop mutating the first beat's stored timing**; the planner
pins index 0's *effective* start to 0 (it already does, via `starts[0] = 0`).
Render output is identical for existing projects (first beat still renders at 0),
but the stored anchor survives a drag away from the front. Keep the non-final
`endSec`/`durationSec` nulling arms; `auto` falls through them untouched (no-op),
with an explicit comment.

### Implementation Phases

#### Phase 1 — Foundation: model stores + renders `auto` correctly

Files: `packages/shared/src/protocol.ts`, `apps/desktop/src/main/sizzle/sequence-planner.ts`, `apps/desktop/src/main/sizzle/sizzle-store.ts`, `apps/desktop/src/main/handlers/sizzle-validators.ts`.

- [ ] `protocol.ts`: add `| { kind: "auto" }` to `SizzleBeatTiming`; add
      `distributeSequenceBeatStarts` (+ `fillEvenly`); adjust
      `normalizeSizzleSequenceBeatContinuity` (stop first-beat mutation; `auto`
      no-op with comment).
- [ ] `sequence-planner.ts`: rewrite the `starts` build in `resolveBeatWindows`
      to (a) resolve anchors → `(number|null)[]`, (b) call
      `distributeSequenceBeatStarts`. Add `beat_too_short` diagnostic
      (slice `< SHORT_SLICE_SEC`). Add `SizzleSpeechTimingWarningCode`/diagnostic
      code as needed.
- [ ] `sizzle-store.ts`: **`sanitizeBeatTiming` gains an `auto` arm** (THE
      correctness fix — without it a saved `auto` round-trips to `offset:0`).
      Three-way switch, explicit default for unknown kinds. Optionally seed the
      synthetic fallback beat as `auto`.
- [ ] `sizzle-validators.ts`: `validateBeatTiming` gains an `auto` arm that
      **accepts `{kind:"auto"}` and rejects `auto` carrying any timing field**;
      update the reject message to `offset, phrase, or auto`.
- Success: `auto` beats persist (round-trip), validate at the bus, and render via
  even-division in both preview and final MP4 — no UI yet.
- Tests: planner even-division cases (AE1, AE3, AE6–AE9), monotonic-clamp (AE10),
  short-slice diagnostic (AE5); store round-trip (AE4-b); validator accept/reject.

#### Phase 2 — Editor UI: author `auto` beats

Files: `apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx`, `.../sizzle.css`.

- [ ] Timing `<select>` (~:1617): add `<option value="auto">Auto</option>` + an
      `auto` arm in `onChange` → `{ kind: "auto" }`. **Keep the `<select>` visible
      for auto beats** so a beat can be promoted/demoted (R9 clarified).
- [ ] The binary timing-input ternary (~:1634) becomes three-way: `auto` renders
      **no** start/length/phrase inputs (R9).
- [ ] Default new beats to `auto`: `onAddSequenceBeat` (~:721) and `beatFromScene`
      (~:1326) seed `{ kind: "auto" }` (R4).
- [ ] Idle short-slice cue: `fallbackSequenceBeats` now knows each slice; flag a
      beat block whose slice `< SHORT_SLICE_SEC` on the timeline strip (so AE5's
      "editor surfaces" holds without a preview round-trip).
- Success: a user can add auto beats, see them placed evenly live (idle strip),
  and promote one to a phrase/offset anchor.
- Tests: "new beat defaults to auto + value inputs absent"; "auto beat between two
  offset anchors shows no timing inputs and the strip places it midway."

#### Phase 3 — Drag-and-drop reorder

Files: `apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx`, `.../sizzle.css`.

- [ ] Generalize the mover: add `moveSequenceBeatTo(sceneId, from, to)` doing a
      `splice(from,1)`/`splice(to,0,moved)` (mirror `CartStore.reorder`), keeping
      the `normalizeSizzleSequenceBeatContinuity` wrap. Keep the ↑/↓ arrows (the
      keyboard-accessible path; native DnD is not keyboard-operable).
- [ ] DnD on the `.szl__sequence-beat` row mirroring
      [CartPanel.tsx:223-243](../../apps/desktop/src/renderer/src/features/cart/CartPanel.tsx):
      `draggable`, `onDragStart` (set `text/plain` = source index),
      `onDragOver` (`preventDefault`), `onDrop` (parse index → `moveSequenceBeatTo`).
      Add a drag-handle affordance.
- [ ] **Self-drop (`from === to`) is a no-op** — short-circuit before `onScenes`
      so it doesn't bump `modifiedAt` or invalidate preview.
- [ ] **Invalidate preview on reorder**: bump the scene's preview generation and,
      if that scene is actively playing, pause it (mirror the script-edit effect
      ~:1169-1196). The plan cache key (`sequencePreviewPlanKey`) already serializes
      beat order, so a stale in-flight plan is discarded.
- Success: drag a beat to any position; order persists; an in-flight preview for
  the old order is discarded; arrows still work.
- Tests: "drop reorders + dispatches `sizzle:update` with reordered beats";
  "self-drop is a no-op (no dispatch)"; "reorder discards a stale preview" (mirror
  the existing narration-edit stale-discard test).

#### Phase 4 — AI composer learns `auto`

Files: `apps/desktop/src/main/ai/sizzle-tool-allowlist.ts`, `apps/desktop/src/main/ai/sizzle-chat-system-prompt.ts`.

- [ ] `beatTimingInputSchema` (~:78): add `z.object({ kind: z.literal("auto") })`
      as a third union member (keep `offset` and `phrase` — **D8 revised: agent
      keeps all three**).
- [ ] `toSequenceBeat` (~:155): add an `auto` branch → `{ kind: "auto" }`.
- [ ] System prompt (~:44-50) + the `sequence_scene_append` /
      `sequence_beat_update` tool descriptions: teach **auto-first** — "default
      every beat to `auto`; only anchor (with a `phrase`) the beats the narration
      explicitly names."
- Success: the agent builds mostly-auto sequences and anchors only named moments;
  agent-authored and UI-authored beats serialize identically.
- Tests: agent tool schema accepts `auto`; `toSequenceBeat` maps it; an agent
  `sequence_scene_append` of all-auto beats round-trips through the store.

#### Phase 5 — Undo/redo for editor edits (in scope per 2026-05-31 decision)

Files: `apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx`.

Undo covers the active project's `scenes` mutations **broadly** (not reorder
alone), because every local edit already funnels through `onScenes` — a narrow
"undo for drag only" would feel inconsistent (why undo a drag but not a delete?).

- [ ] In-memory history per active project: on each user-driven `onScenes` commit,
      push the PREVIOUS `scenes` onto an undo stack and clear redo. **Coalesce**
      consecutive narration text edits to the same scene (replace the top entry
      within the existing 350ms window) so typing isn't one entry per keystroke.
- [ ] ⌘Z → undo (pop undo, push current to redo, apply via an `onScenes` variant
      that doesn't re-record); ⌘⇧Z / ⌘Y → redo. Guard when an `<input>`/`<textarea>`
      owns the shortcut or mid-IME composition.
- [ ] Reset history on project switch; bound the stack (~50 entries).
- [ ] External broadcasts (chat edits via `events:sizzle:projectsChanged`) do NOT
      enter the local undo stack (they arrive outside `onScenes`) — document this.
- Success: drag a beat → ⌘Z restores order, ⌘⇧Z re-applies; same for timing-kind,
  add/remove.
- Tests: "reorder then ⌘Z restores order"; "⌘Z/⌘⇧Z round-trip"; "rapid narration
  typing collapses to one undo step".

---

## Alternative Approaches Considered

- **Recompute even-division independently in the renderer** (no shared fn).
  Rejected — reintroduces the `resolveSizzleAudioSource` "guaranteed-divergence
  footgun"; the two existing start formulas *already* differ
  (`sequence-planner.ts:204` vs `SizzleApp.tsx:140`).
- **Keep mutating the first beat to `offset:0` in the normalizer.** Rejected —
  silently destroys a phrase anchor dragged to the front (the D2↔D3 contradiction
  SpecFlow flagged). Moving the 0-pin to the planner preserves the anchor.
- **Remove `offset` from the agent schema** (force auto/phrase only). Considered
  to enforce R4, but **not chosen** (2026-05-31) — the user kept `offset` available
  to the agent; R4 is steered via the prompt (auto-first) instead.
- **Sort beats by anchor time in the planner.** Rejected — fights the user's
  explicit array order; out-of-order anchors are surfaced (clamp + diagnostic),
  not silently re-sorted.
- **Variable-width slices (a video's natural length defines its slice).** Rejected
  per origin D1 — breaks the "divide evenly" mental model; auto video fills its
  slice via the existing `videoFit` instead.

---

## System-Wide Impact

### Interaction Graph
UI add/edit/reorder → `onScenes` → 350ms coalesced `sizzle:update`
(`sizzle-handlers.ts`) → `SizzleStore.update` → `sanitizeScenes` →
`sanitizeBeatTiming` + `normalizeSizzleSequenceBeatContinuity` → atomic
tmp+rename write → `events:sizzle:projectsChanged` broadcast → renderer re-render.
Preview ▶ → `sizzle:previewSequenceScenePlan` → `planSequenceTimeline` →
`resolveBeatWindows` → `distributeSequenceBeatStarts`. Render → `sizzle:render` →
`planSequenceScene` → same funnel. Agent edit → `sequence_beat_update` tool →
`toSequenceBeat` → same store path as the UI (parity).

### Error & Failure Propagation
- A genuinely unknown `timing.kind` on read must **degrade gracefully** in
  `sanitizeBeatTiming` (safe default, never throw — an old/forward build must not
  brick a project's load; see CLAUDE.md "self-heal, never wipe").
- `auto` payloads from HTTP/MCP that carry timing fields are rejected at the bus
  with `scene_beat_timing_invalid` (Phase 1 validator).
- Even-division never divides by zero (`autoCount + 1 ≥ 1`) and never returns a
  negative slice (monotonic clamp).

### State Lifecycle Risks
- **Round-trip downgrade** (the #1 risk): without the `sanitizeBeatTiming` `auto`
  arm, every saved auto beat silently becomes `offset:0` on next read. Guarded by
  the Phase 1 store round-trip test.
- **Reorder mid-debounce**: a drop landing during a text-edit debounce must merge
  via the coalesced-patch path, not clobber (existing 350ms mechanism;
  reorder routes through the same `onScenes`).
- **Stale preview after reorder**: handled by the generation bump (Phase 3).

### API Surface Parity
Four surfaces must accept `auto` or fail closed (R8): the `protocol.ts` type, the
planner resolver, the bus validator (`sizzle-validators.ts`), and the agent zod
schema (`sizzle-tool-allowlist.ts`). The store `sanitizeBeatTiming` is the fifth
(read path). A parity test feeds the same scene to `resolveBeatWindows` and
`fallbackSequenceBeats` via the shared fn and asserts identical starts.

### Integration Test Scenarios
1. UI creates all-auto sequence → render MP4 beat windows match the editor strip.
2. Agent `sequence_scene_append` (all-auto) → store round-trip → UI shows auto.
3. Drag reorder while preview playing → playback pauses, stale plan discarded,
   new order renders.
4. Old project (all `offset`/`phrase`) → opens + renders byte-identically (AE4).
5. Phrase anchor dragged out of narration order → monotonic clamp + diagnostic;
   no negative slice (AE10).

---

## Decisions

Carried forward from origin (see origin: "Decisions"):
- **D1** — auto video fills its even-division slice via existing `videoFit`
  (not clip-natural-length). The `video_fit` diagnostic and the new short-slice
  warning are **distinct** classes; both may fire (raise/ structure the 3-warning
  cap so neither is hidden).
- **D2** — dragging an anchored beat keeps its anchor (no silent conversion)…
- **D4** — "Add next scene" removed (already shipped this change).

Resolved/added during planning (resolving SpecFlow contradictions):
- **D3-revised** — the "first beat starts at 0" rule is a **planner rule**
  (`starts[0] = 0`), not a data mutation. Stored anchor data is preserved; a
  phrase anchor parked at index 0 is inactive but restored when dragged away.
  This resolves the D2↔D3 contradiction (no silent anchor loss).
- **D5** — array order is the user's sequence; the planner never re-sorts. Order
  inconsistent with anchor times is surfaced, not fixed.
- **D6** — `distributeSequenceBeatStarts` clamps anchor times **monotonically**
  (`clamp(t, prevAnchorTime, dur)`), guaranteeing non-negative slices. This is the
  fix that makes the origin's reorder goal real rather than relocating the bug.
- **D7** — an **unresolved phrase anchor degrades to auto** (participates in even
  division) and keeps the `phrase_unresolved` diagnostic.
- **D8 (revised 2026-05-31)** — the agent timing schema keeps all three
  (`auto | phrase | offset`); the system prompt teaches **auto-first** (default
  auto, anchor named phrases) but does not forbid `offset`.

## Acceptance Criteria

### Functional
- [ ] **AE1 (R1,R2):** keyframe₁@2s + 3 autos + keyframe₂@10s → autos at 4s/6s/8s;
      keyframe₁ covers 2–4s.
- [ ] **AE2 (R5,R6):** 4 all-auto beats, drag the last to the front → order
      changes, render still divides evenly (assert the concrete start list); no
      timing edits.
- [ ] **AE3 (R3):** exactly 1 auto between two phrase anchors → lands at the
      midpoint of the resolved phrase times (N=1 stated explicitly).
- [ ] **AE4 (R7):** a project saved before this change opens + renders identically;
      **AE4-b:** an `auto` beat survives `sizzle:update` → `sizzle:list` without
      downgrading to `offset`.
- [ ] **AE5 (R10):** a 1s span with 5 autos (~0.2s each) surfaces a short-slice
      warning **in the idle editor** (not only post-preview) and still renders.
- [ ] **AE6:** trailing autos after the last anchor split `[tLastAnchor, duration]`.
- [ ] **AE7:** an `offset` anchor (not just `phrase`) bounding an auto run.
- [ ] **AE8:** all-auto sequence → `(duration/n)·index`.
- [ ] **AE9:** single auto beat → renders `[0, duration]`; last beat is auto →
      ends at `duration`.
- [ ] **AE10 (D6):** an `offset:8` beat dragged before an `offset:2` beat → the
      later anchor is clamped to ≥ the earlier; slices stay ≥ 0; a diagnostic fires.
- [ ] **AE11 (R4):** new beats (UI add + agent `sequence_scene_append`) default to
      `auto`.
- [ ] **AE12 (R8):** the bus validator accepts `{kind:"auto"}` and rejects `auto`
      carrying `startSec`/`endSec`/`phrase`/`durationSec`.
- [ ] **AE13 (R9):** an auto beat shows the timing-kind `<select>` but no
      start/length/phrase inputs; promoting it to `phrase` reveals the phrase input.
- [ ] **AE14:** self-drop (`from===to`) dispatches nothing and doesn't bump
      `modifiedAt`.
- [ ] **AE15 (D3-revised):** a `phrase` beat dragged to index 0 keeps its stored
      phrase; dragged back, the phrase anchor takes effect again.
- [ ] **AE16 (Phase 5):** after a drag reorder, ⌘Z restores the previous beat
      order and ⌘⇧Z re-applies it; rapid narration typing collapses to one undo
      step.

### Non-Functional / Quality Gates
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` all green; renderer build bundles.
- [ ] No new `schemaVersion` bump; no migration code.
- [ ] Parity test: `resolveBeatWindows` vs `fallbackSequenceBeats` agree on starts
      for an offset-only scene.

## Resolved Decisions (confirmed 2026-05-31)
- **R10 threshold** — `SHORT_SLICE_SEC = 0.4`, measured on the final clamped
  `endSec − startSec`. ✅
- **Undo/redo — IN SCOPE** (Phase 5). Covers the active project's scene-list edits
  broadly (reorder, timing-kind, add/remove, narration), since all funnel through
  `onScenes`. ✅
- **Keyboard reorder** — ↑/↓ arrows remain the keyboard-accessible path + `aria`
  labels; native HTML5 DnD stays mouse-only. ✅
- **D8 (agent timing)** — **keep `offset`**; agent schema is `auto | phrase |
  offset`, steered auto-first by the prompt. ✅

## Risks & Mitigation
- **Silent round-trip downgrade** → Phase 1 `sanitizeBeatTiming` arm + store test.
- **Preview/render divergence** → single shared fn + parity test.
- **Reorder races** (stale write / stale preview) → coalesced `onScenes` path +
  generation bump (existing discipline; see
  [v2-editor races](2026-05-23-001-feat-v2-editor-plan.md)).
- **Agent regressions** (emits invalid mixes) → zod union + bus validator fail
  closed; prompt tuning monitored, not correctness-gating.

## Dependencies & Prerequisites
None external. Builds directly on the shipped sequence-scenes feature and the
wavesurfer/auto-load work already on `feat/sizzle-sequence-preview`.

## Test Plan
- **Planner unit** (`sequence-planner.test.ts`): AE1, AE3, AE6–AE10, short-slice.
- **Shared unit** (new, e.g. `protocol.test.ts` or a sizzle-timing test):
  `distributeSequenceBeatStarts` table — even runs, trailing run, all-auto,
  monotonic clamp, single beat.
- **Store** (`sizzle-store.test.ts`): `auto` round-trip (AE4-b) + unknown-kind
  graceful default.
- **Validator** (`sizzle-validators.test.ts`): accept auto / reject auto+fields.
- **Renderer** (`SizzleApp.test.tsx`): default-auto (AE11), R9 inputs (AE13), drag
  reorder + dispatch (AE2), self-drop no-op (AE14), reorder discards stale preview.
- **Agent** (`sizzle-tool-allowlist` test if present): schema accepts auto;
  `toSequenceBeat` maps it.

---

## Sources & References

### Origin
- **Origin document:** [docs/brainstorms/2026-05-31-sizzle-auto-beat-timing-requirements.md](../brainstorms/2026-05-31-sizzle-auto-beat-timing-requirements.md).
  Carried forward: the even-division rule (N+1 slices, leading anchor keeps slice
  0), auto-default (R4), additive-no-migration (R7), and decisions D1/D2/D4. This
  plan **resolves** the origin's open contradictions (D3 vs D2, out-of-order
  anchors) with D3-revised + D5/D6/D7/D8.

### Internal References (file:line)
- Planner funnel: `apps/desktop/src/main/sizzle/sequence-planner.ts:48,133,147,182,190-205,215-224`
- Shared types + normalizer: `packages/shared/src/protocol.ts:662-711` (and `resolveSizzleAudioSource:779-802`)
- Persistence + the downgrade bug: `apps/desktop/src/main/sizzle/sizzle-store.ts:25-28,225,258-281,292-322`
- Bus validator: `apps/desktop/src/main/handlers/sizzle-validators.ts:366-466,468-543`
- Agent schema + prompt: `apps/desktop/src/main/ai/sizzle-tool-allowlist.ts:78-93,155-180`; `apps/desktop/src/main/ai/sizzle-chat-system-prompt.ts:44-50`
- Renderer fallback + beat-row + reorder + warnings: `apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx:134-159,383-392,721-728,1326-1333,1351-1362,1617-1788`
- Drag precedent: `apps/desktop/src/renderer/src/features/cart/CartPanel.tsx:223-243`; `apps/desktop/src/main/cart/cart-store.ts:86-96`

### Related Work
- Predecessor plan: [2026-05-30-001-feat-sizzle-sequence-scenes-plan.md](2026-05-30-001-feat-sizzle-sequence-scenes-plan.md)
- Retro: [docs/solutions/2026-05-30-sizzle-sequence-scenes.md](../solutions/2026-05-30-sizzle-sequence-scenes.md)
- Schema-additive rule: [docs/solutions/2026-05-12-settings-substrate.md](../solutions/2026-05-12-settings-substrate.md)
- Frontend-races discipline: [docs/plans/2026-05-23-001-feat-v2-editor-plan.md](2026-05-23-001-feat-v2-editor-plan.md)

### AI-Era Notes
- Research: `repo-research-analyst` + `learnings-researcher` (parallel) mapped the
  exact file:line touchpoints; `spec-flow-analyzer` surfaced the D2↔D3 contradiction
  and the negative-slice failure mode — both resolved above. Given rapid
  implementation, weight the round-trip, parity, and monotonic-clamp tests heavily.
