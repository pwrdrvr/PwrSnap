---
title: v2 editor — tool-UX refresh, right-sidebar shell, and phased layer-model migration
type: feat
status: active
date: 2026-05-23
origin: docs/brainstorms/2026-05-19-v2-layer-editor-requirements.md
---

# v2 editor — tool-UX refresh, right-sidebar shell, and phased layer-model migration

## Enhancement Summary

**Deepened on:** 2026-05-23
**Sections enhanced:** all (overview, phase ordering, all 8 phases, data model, system-wide impact, acceptance criteria, risks, success metrics)
**Reviewers applied:** kieran-typescript, julik-frontend-races, agent-native-reviewer, architecture-strategist, code-simplicity-reviewer, data-integrity-guardian, data-migration-expert, deployment-verification-agent, pattern-recognition-specialist, performance-oracle, security-sentinel, schema-drift-detector, frontend-design (skill), agent-native-architecture (skill), best-practices-researcher

### Key changes vs. first-cut plan

| Change | Driver |
|---|---|
| **Phase order: 1 → 2 → 3 → 6 → 4 → 5 → 7 → 8** (flag flip MOVES before v2-only features). Originally 6 came after 5. | architecture-strategist + agent-native: v2-only features (smart blur, multi-image) need a real install base; flipping after they ship means they're dogfood-only. |
| **Doctor coords corrected**: v1 overlays are NORMALIZED [0,1], not absolute. Doctor multiplies by source dims. | data-migration-expert + repo grep against `overlay-schemas.ts:8-23`. My first plan was wrong. |
| **v1 blur conversion picked**: convert to v2 sample-below effect layer (NOT "static" — that's a schema contradiction). User may see blur shift if they later move layers underneath. | data-migration-expert: caught the contradiction. |
| **Migration head is 0012, not 0009.** Plan's migration references updated. | schema-drift-detector. |
| **AI tool surface = thin shim + capability discovery, NOT workflow wrappers.** Replaces `add_arrow(...)` per-kind tools with 5-6 primitive tools that mirror `layers:*` verbatim + `list_layer_capabilities` generated from zod. | agent-native-architecture skill. |
| **Add `render:composite` + AI tool style context injection.** AI was blind after every write and didn't know the user's stoplight pattern. | agent-native-architecture skill. |
| **Phase 5 Finder drop needs `assertSafePastedFile`.** Symlink/privileged-dir reject. | security-sentinel. |
| **Phase 7 Codex trust boundary**: per-turn op cap (30 calls), per-session cap (5 turns/min), confirm-batch affordance for ≥N writes. | security-sentinel. |
| **Tool state window-scoped active, Settings-scoped defaults.** Was global; multi-window broadcast stomps. | architecture-strategist. |
| **5 tool-popovers → 1 `ToolStylePopover`** (kind-conditional body). 13 new Phase 1 files → 7. | code-simplicity-reviewer. |
| **Hover delays: 300ms enter / 500ms exit + safe triangle** (per NN/g). Was 200ms — too aggressive. | best-practices-researcher (NN/g + Baymard citations). |
| **Migration mapping table** (v1 overlay → v2 layer field-by-field). Added to Phase 3. | data-migration-expert: most common bug class. |
| **Phase 3 doctor reads bundle manifest for idempotency check, not DB row.** Atomic ordering: write-bundle → tx(insert layers + update captures) → fsync → rename → DELETE overlays. | data-integrity-guardian. |
| **`migration:status` cached-snapshot verb** (mirror of legacy-bundle-migration pattern). Toolbar disabled until doctor settles. | julik-frontend-races: optimistic editor open caused ghost overlays. |
| **`layers:upsertBatch` verb for AI transactional writes** (one broadcast per run, not per-layer). | performance-oracle + julik-races: AI run thrashed the renderer. |
| **Doctor result persistence**: new migration `0013_v1_to_v2_migration_status` (own column, not reusing `legacy_bundle_attempts`). | schema-drift-detector + deployment-verification-agent. |
| **Phase 4 smart-blur drag**: CSS `backdrop-filter` live preview; composeV2 commit at pointerup. | performance-oracle: per-frame composeV2 is 4-12fps at 4K. |
| **Phase 5 paste**: sharp decode + sha256 in worker thread; "Pasting…" affordance immediately. | performance-oracle: 150-250ms baseline is visibly slow. |
| **No telemetry assumption removed**: weakened Phase 6 verification from "telemetry catches regressions" to "user-reported only + manual rollback procedure." Add Phase 5.5: optional v1 sidecar dual-write for rollback safety. | deployment-verification-agent. |
| **Marquee user moment named explicitly** for Phase 1 (4 clicks → red arrow + matching red label, cursor already on next arrow). | frontend-design skill. |
| **Stoplight coachmark** (first popover open only). Per-tool COLOR slot SHARED across tools (picking red for arrow → text defaults to red). | frontend-design skill. |
| **Acceptance criteria + risk analysis expanded** for all of the above. | synthesis. |

### New considerations discovered

- **AI's chat surface is the most under-spec'd part of the plan.** Phase 7 has 6 gaps (composite vision, tool style context, partial reject, per-tool-call zod errors, ask-vs-act system prompt design, capability discovery). Bumps Phase 7 from 20-30h to 26-40h.
- **Telemetry doesn't exist yet.** Plan can't gate Phase 6 on "monitor v2 adoption" without a telemetry substrate. Either ship a minimal telemetry pre-Phase-6 OR weaken the rollout gate to "manual user-report watch."
- **Multi-window tool state is genuinely subtle.** "Open editor A red, open editor B → it inherits red" requires careful broadcast suppression. Plan now explicitly window-scopes active state.

---

## Overview

PwrSnap's job is **fast screenshot annotation by humans, with AI as a first-class second user of the same primitives** (see origin: [problem frame](../brainstorms/2026-05-19-v2-layer-editor-requirements.md)). The v1 editor delivers fast annotation today via a simple toolbar (arrow / text / rect / blur / highlight + undo/redo). The v2 bundle format shipped in PR #14 gives us a layer-tree data model that's strictly richer than v1's flat overlay array — but the renderer hasn't moved over yet, and the design refresh now in `design/PwrSnap Editor.html` calls out two visible gaps:

1. **No tool style affordances.** Picking an arrow gives you no color picker, no end-style options, no thickness presets. The user's stoplight-color annotation pattern (red = bad, yellow = ok, green = good, blue/gray = context) is not expressible today.
2. **No right-sidebar.** The activity-bar shell the brainstorm specced doesn't exist yet — Info / Chat / Tool Config panels have nowhere to live.

This plan ships the editor in eight phases, ordered for **minimum delta first and shipped-into-real-use-fast**: Phase 1 is a pure v1-editor UX refresh (tool dropdowns + sticky tool mode + matching-text flow + Crop tool + right-sidebar shell), all over the existing `overlays:*` IPC. Users get a visible upgrade with zero data-layer risk. Phases 2-3 wire dual-format reading + lazy v1→v2 doctor. **Phase 6 (default flip) moves up before Phase 4-5** so the v2-specific features (smart blur, multi-image) ship against a real v2 install base instead of dogfood-only. Phase 7 adds the AI surface; Phase 8 retires the v1 codepath.

Carries forward the brainstorm's two marquee positions:
- **For users**: smart blur is the v2 differentiator they can feel — drag the blurred region; blur tracks what's beneath it.
- **For AI**: the layer-tree IPC is the documented annotation contract — Codex uses the same `layers:*` verbs the renderer uses; AI-produced annotations show up as layers indistinguishable in behavior from user-drawn ones.

User feedback layered on top of the brainstorm:
- **Drop the Layers panel.** Users don't need a list of layers — they think in placed annotations, not layers (see origin: §"Layers panel" decision was originally one of four R5 panels; user clarification removes it).
- **Tool dropdowns + Tool Config panel** become first-class — color picker per tool, preset sizes, arrow end styles, stem styles.
- **Sticky tool mode + style memory** — after placing an arrow, stay in arrow mode with the same color/style; matching-text flow lets the user place a label that visually matches the arrow with one click.
- **Crop tool** — currently missing from the toolbar; add it.

**The Phase 1 marquee user moment to optimize for** (per frontend-design skill): click arrow → drag a red arrow → "+ Add label" appears at the arrow's tail → click it → click on the canvas → type "missing index" → ⏎ → label appears in red, matching the arrow, and the cursor is *already on the next arrow*. Four clicks + typing replaces what used to be ten clicks + typing.

## Problem Statement

The v1 editor is the surface every annotation flows through today, and it has three shapes of pressure on it:

**Pressure 1: User-visible UX gaps.** No color picker, no tool style options, no sticky tool mode (every annotation re-prompts tool selection), no canvas-side affordances for related-annotation creation, no Crop. The result is that even the most common annotation workflow — "place arrow → place matching label → place another arrow → place another label" — requires constant toolbar round-trips and produces visually inconsistent annotations. The user's stoplight color pattern (red/yellow/green/blue/gray/black coordinated between arrow and text) is impossible to execute fast.

**Pressure 2: Data-layer fork.** The v2 bundle format (PR #14) ships a layer-tree data model and IPC (`layers:*` verbs at [packages/shared/src/protocol.ts:857-877](../../packages/shared/src/protocol.ts:857-877)). The renderer doesn't use it. v2 captures created with `PWRSNAP_BUNDLE_V2=1` immediately fail in the editor because [Editor.tsx:318](../../apps/desktop/src/renderer/src/features/editor/Editor.tsx:318) calls `overlays:upsert` unconditionally and `refuseIfV2Capture` (overlays-handlers.ts) rejects them. Until the renderer learns to dispatch on `bundle_format_version`, the v2 flag can't safely flip — and the brainstorm's marquee wins (smart blur, multi-image, AI primitives) all require v2 captures.

**Pressure 3: AI integration debt.** The brainstorm specifies AI as a first-class consumer of the layer-tree IPC via Codex App Server, with a user-facing Chat panel that materializes AI's annotations as layers (see origin: R6 + R6.1). Today PwrSnap has no AI annotation surface — the Codex protocol exists but isn't wired to the layers IPC.

The three pressures share a root cause: the editor's tool model is fused to a flat overlay array, and overlays carry only the minimum properties v1 needed (kind + geometry + a few style fields). Decoupling the tool surface from the data layer lets us:
- Add tool-UX features without touching the data layer (Phase 1)
- Swap the data layer per-capture transparently (Phases 2-3)
- Flip the default so the v2-specific work has a real install base (Phase 6)
- Light up v2-only features against real captures (Phases 4-5)
- Open the AI surface against the same IPC contract everything else uses (Phase 7)

## Proposed Solution

**Eight phases, sequenced for ship-early-ship-often.** Phase 1 is the user-visible win and ships independently; Phases 2-3 + 6 are the v2 transition arc; Phases 4-5 are v2-only marquee features; Phase 7 is AI; Phase 8 is cleanup.

```
Phase 1 — Tool-UX refresh (v1 only, no data-layer changes)
  ├─ Right-sidebar shell (activity bar + Info / Chat-stubbed / Tool Config / Help)
  ├─ Unified ToolStylePopover (color, end styles, stem, thickness — kind-conditional)
  ├─ useEditorToolState (sticky mode + per-tool style memory, window-scoped active state)
  ├─ Matching-text affordance ("+ Add label" on canvas after placing an arrow)
  └─ Crop tool

Phase 2 — Dual-format editor (renderer reads both)
  └─ Branch on record.bundle_format_version → overlays:* or layers:*

Phase 3 — v1→v2 lazy doctor (per-capture, on first edit-open)
  ├─ Read v1 bundle → build v2 layer tree (multiply normalized [0,1] coords by source dims)
  ├─ Convert v1 blurs to v2 sample-below effect layers (the v2 convention)
  ├─ Atomic: write-bundle → tx(INSERT layers + UPDATE captures) → fsync → rename → DELETE overlays
  ├─ Idempotency check reads bundle manifest, not DB row
  ├─ migration:status cached-snapshot verb; editor toolbar disabled until doctor settles
  └─ Brief "Upgrading…" indicator; view-only fallback on failure

Phase 6 — Default flag flip (MOVED UP from original Phase 6)
  └─ isV2WriteEnabled() returns true; new captures = v2

Phase 4 — Smart blur effect layer (v2-only)
  ├─ Blur tool produces effect layer with sample-below semantics
  ├─ CSS backdrop-filter live preview during drag; composeV2 commit at pointerup
  └─ Drag-the-blur tracks pixels underneath

Phase 5 — Multi-image paste/drop
  ├─ ⌘V on canvas → raster layer from clipboard image
  ├─ Drag from Finder → raster layer (with assertSafePastedFile security gate)
  └─ Sharp decode + sha256 in worker thread; "Pasting…" affordance

Phase 7 — Chat panel + AI primitives wrapper
  ├─ Codex App Server bridge — thin shim over layers:* (no workflow wrappers)
  ├─ list_layer_capabilities tool generated from zod schemas
  ├─ render:composite bus verb so AI can see what user sees
  ├─ AI session context includes settings.editor.toolStyles + last-N edits
  ├─ layers:upsertBatch for transactional AI runs (one broadcast per run)
  ├─ Per-turn op cap (30), per-session rate limit (5 turns/min), confirm-batch ≥N writes
  ├─ Chat history persisted in bundle (chat.json with 1MB cap; excluded from clipboard fragments)
  └─ Single-step undo per AI run

Phase 8 — Retire v1 codepath
  ├─ Boot-time reconcile sweep upgrades any remaining v1 captures
  ├─ Refuse-to-migrate gate in 0014_drop_overlays_table.sql (count check)
  ├─ Delete overlays:* IPC handlers + repo
  ├─ Delete editor's dual-mode branching
  └─ Delete doctor (job done; all captures are v2)
```

**Key sequencing rationale:**
- Phase 1 ships ALONE as a v1-editor refresh. Users see the tool UX win on day one; no data-layer risk.
- Phases 2-3 are invisible plumbing; unlock Phase 6.
- **Phase 6 moves up** so Phases 4-5 ship features that exercise a real v2 install base. Originally I had 6 after 5; architecture-strategist + agent-native both flagged this as wrong.
- Phase 7 (AI) is standalone after the data layer settles. Could be its own follow-up PR if scope pressure surfaces.
- Phase 8 is the cleanup pass after a soak period proves v2 is stable.

## Technical Approach

### Architecture

```
┌─────────────────── EDITOR RENDERER ───────────────────┐
│                                                        │
│  ┌──── EditorToolbar ────┐  ┌─ ActivityBar (right) ─┐ │
│  │ V A R B H T C │ ↶↷ Z │  │ ⓘ 💬 ⚙ ?              │ │
│  │ ┌─ caret ─ ToolStylePopover ┐ │   │                │ │
│  │ │ COLOR / THICKNESS / END / │ │   ├─ Info panel    │ │
│  │ │ STEM / ✓ Double-ended     │ │   ├─ Chat panel    │ │
│  │ └────────── kind-conditional ─┘ │   ├─ Tool Config  │ │
│  └──────────────────────────────┘  │   └─ Help (stub) │ │
│                                    └────────────────────┘ │
│  ┌────────── Canvas ─────────┐                          │
│  │ <CanvasSvg layers={tree}> │                          │
│  │ + draft + drag preview    │                          │
│  │ + crop overlay (modal)    │                          │
│  │ + "+ Add label" affordance│                          │
│  └───────────────────────────┘                          │
│                                                          │
│  Tool state: useEditorToolState()                       │
│   • active tool (window-scoped)                         │
│   • active style per tool (window-scoped)               │
│   • defaults persist via Settings (debounced 500ms,     │
│     committed on window-close beforeunload)             │
│   • COLOR slot SHARED across tools (stoplight pattern)  │
└──────────────────────────────────────────────────────────┘
                       │
              record.bundle_format_version
                       │
       ┌───────────────┴───────────────┐
       ↓                                ↓
  v1 → overlays:*                v2 → layers:*
  (Phase 1 surface)              (Phase 2 surface)
  - flat array, normalized       - flat list + parent_id, absolute px
    [0,1] coords                 - vector / raster / effect / group
  - vector shapes                - effect = sample-below at composite
  - blur = static bake
```

**Six structural decisions baked into Phase 1:**

1. **Tool state is window-scoped (active) + Settings-backed (defaults).** Per architecture-strategist: a previous "global broadcast" design would let Window A change color from red to blue and stomp Window B mid-edit. New design: each editor window owns its `active` tool state (React state); the Settings substrate stores DEFAULTS that are read at window-open and written at window-close (or 500ms debounce, whichever first). Cross-window changes do NOT broadcast.

2. **COLOR slot shared across tools, other style slots per-tool.** Per frontend-design skill: picking red for arrow should also set text/rect/highlight to red on next selection. Thickness/end-style/etc. stay per-tool. This is what makes the stoplight pattern feel native.

3. **Single `EditorChrome` shell.** The activity bar + sidebar panel area is one component that brackets the existing `Editor` viewport, modeled on the design's `EditorChrome` in `design/src/Editor.jsx:324-350`. The viewport itself remains chromeless (used both by the standalone Editor window AND by the Library Focus mode); only the standalone Editor window wraps it in `EditorChrome`.

4. **One `ToolStylePopover` with kind-conditional body** (NOT 5 separate popovers). Per code-simplicity-reviewer: the popover shell is the same; only the field set differs per tool. Mirror `design/src/EditorPanels.jsx:176-320`'s StylePanel pattern. ~150 LOC total vs ~600 if split.

5. **Activity bar panel area uses the documented popover-measurement pattern.** Per AGENTS.md "Tray + float-over popover sizing — outer `inline-block` measurer", any panel that resizes its content measures via an `inline-block` wrapper outside the styled container. Fixed-width 38px icon strip; pinned panel = 320px; hover-popped overlay = content-sized capped at 380px.

6. **Hover timings per NN/g**: 300ms hover-in delay, 500ms mouse-out grace + safe-triangle (Amazon mega-menu pattern). First-click is always pinned (teaches the pattern by example); hover-pop-out is enabled only after the user has clicked at least once. Stored in CSS custom properties for tuning:
   ```css
   :root {
     --pse-panel-hover-delay-ms: 300ms;
     --pse-panel-grace-ms: 500ms;
     --pse-panel-slide-dur: 180ms;
     --pse-panel-slide-ease: cubic-bezier(0.32, 0.72, 0, 1);
     --pse-affordance-auto-dismiss-ms: 8000ms;
   }
   ```

**IPC contract during Phase 2 (dual-mode editor):**
```ts
// useCaptureModel.ts — discriminated union return for compile-time safety
type CaptureModel =
  | { format: 1; record: CaptureRecord; layers: LayerView; dispatchEdit: (op: OverlayOp) => Promise<Result<void, PwrSnapError>>; loading: false }
  | { format: 2; record: CaptureRecord; layers: LayerView; dispatchEdit: (op: LayerOp) => Promise<Result<void, PwrSnapError>>; loading: false }
  | { loading: true };

// Editor.tsx — opens via:
const model = useCaptureModel(captureId);
if (model.loading) return <Spinner />;
// Renderer paths share the LayerView shape; edit dispatch is format-typed
```

The `overlay-to-layer-shim` (inlined inside `useCaptureModel`, not a separate file per code-simplicity-reviewer) synthesizes a flat layer-tree view from v1 overlays so the rendering code path is the same for both formats. Edit writes still hit the format-specific IPC. This shim is throwaway code — deleted in Phase 8 when overlays goes away.

**Color tokens added to `tokens.css`:**
```css
:root {
  --swatch-red:    #ff5f57;
  --swatch-yellow: #facc15;
  --swatch-green:  #28c840;
  --swatch-blue:   #1f7cff;
  --swatch-gray:   #8b8a87;
  --swatch-black:  #0a0a0a;
  --swatch-white:  #f5efe3;
  --swatch-accent: var(--accent);  /* tangerine — default */
}
```

The arrow color picker shows these eight swatches + a "Custom…" button that opens a native `<input type="color">` in a hidden `<dialog>` (so the popover doesn't close on OS color picker focus shift — known footgun). Same swatches used by text, rect, highlight tools for cross-tool visual consistency.

**First-run stoplight coachmark** (per frontend-design skill): the very first time the user opens any tool popover, show a 3-second auto-dismissing micro-coachmark at the top of the popover:
> 💡 Stoplight palette: red = bad, green = good, blue = context. Same colors across all tools.

Track via `settings.editor.coachmarks.stoplightSeen: boolean`. Once dismissed, never shown again.

### Data Model

**No SQLite migrations in Phases 1-2, 4-7.** Phase 3 adds **one new migration**, Phase 8 adds another.

- **`captures`** — unchanged through Phase 2; Phase 3 adds two columns via migration `0013_v1_to_v2_migration_status.sql`:
  ```sql
  ALTER TABLE captures ADD COLUMN v1_to_v2_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE captures ADD COLUMN v1_to_v2_last_failed_at TEXT;
  ALTER TABLE captures ADD COLUMN v1_to_v2_last_error_code TEXT;
  ```
  Separate from `legacy_bundle_*` columns (different lifecycle: lazy-on-open vs batch-on-boot).
- **`overlays`** — still used by v1 captures in Phases 1-7; **NOT dropped in Phase 8** (per schema-drift-detector: dropping requires another migration and breaks rollback). Left dormant.
- **`layers`** — used by v2 captures from Phase 2 onward.

Phase 1 adds a Settings field (TypeScript-level only; no DB change, no `schemaVersion` bump per AGENTS.md substrate rules):
```ts
// packages/shared/src/protocol.ts — Settings.editor extension
settings.editor = {
  toolStyles: {
    arrow: {
      color: ColorToken | string,  // ColorToken = "red" | "yellow" | "green" | "blue" | "gray" | "black" | "white" | "accent"
      thickness: "auto" | "small" | "medium" | "large" | number,
      endStyle: "filled-triangle" | "open-triangle" | "line" | "dot",
      stemStyle: "solid" | "dashed" | "dotted",
      doubleEnded: boolean
    },
    text: { color: ColorToken | string, fontSize: "auto" | "small" | "medium" | "large" | number, weight: "regular" | "bold" },
    rect: { color: ColorToken | string, thickness: "auto" | "small" | "medium" | "large" | number, filled: boolean },
    blur: { mode: "gaussian" | "pixelate" | "redact", radius: { mode: "auto" } | { mode: "px", value: number } },
    highlight: { color: ColorToken | string, opacity: number, blend: "multiply" | "screen" | "overlay" }
  },
  coachmarks: {
    stoplightSeen: boolean
  },
  matchingText: { enabled: boolean },  // user can disable the affordance
  sidebar: {
    pinned: boolean,
    lastSelectedPanel: "info" | "chat" | "toolConfig" | "help"
  }
};
```

`parseV1` in `desktop-settings-service.ts` handles the missing-field case gracefully (existing precedent: `recording`, `appearance`, `updates`, `general.developerMode` all landed post-v1 without `schemaVersion` bump).

Phase 7 adds a new bundle entry for chat history:
- **v2 bundle gains `chat.json`** (alongside `manifest.json`, `document.json`, `sources/`, `layers/`, `composite.png`).
- Schema: array of `{ id, role: "user" | "assistant", content: ChatMessageContent, created_at, ai_run_id?, tool_calls? }` where `ChatMessageContent` is a discriminated union over `kind: "text" | "tool_call" | "tool_result"`.
- **Size cap 1 MB** (per schema-drift-detector); zod rejects larger payloads at read/write.
- **Excluded from `clipboard:pasteLayerFragment` payload** (per data-integrity + security: chat content often contains PII/secrets the user typed; would leak across instances on cross-app paste).
- The v2 path validator (`validateBundleZipEntryNamesV2` at [packages/shared/src/bundle-manifest-schema-v2.ts:258](../../packages/shared/src/bundle-manifest-schema-v2.ts:258)) gains `chat.json` in its allowlist.
- **Unit test required** asserting `chat.json.bak` and `chat.json/../etc/passwd` are rejected.

### Implementation Phases

Each phase below has:
- **Goal** — what's the user-visible outcome (or "invisible plumbing" if not)
- **Files** — what gets touched
- **Approach** — execution notes + the patterns from research to follow
- **Test scenarios** — the integration-level "did this work" checks
- **Verification** — the "done" signal

---

#### Phase 1 — Tool-UX refresh (v1 only) (~12-16h)

**Goal.** Ship a visible upgrade to the existing v1 editor on day one. User sees: right-edge activity bar (Info / Chat-stubbed / Tool Config / Help icons), inline color picker on the toolbar when a tool is selected, tool style options (end styles, stem, thickness presets) reachable via a small caret on the active tool button, sticky tool mode (placing an arrow stays in arrow mode), matching-text flow (a small "+ Add label" affordance appears near the just-placed arrow), and a new Crop tool. All over `overlays:*`. Zero data-layer risk.

**Execution note.** Test-first for state management hooks. Characterization-first for any refactor of the existing toolbar — capture current behavior via Playwright before changing the structure.

**Patterns to follow:**
- `BlurMenu.tsx` — toolbar-button + popover pattern for the unified `ToolStylePopover`
- `ZoomMenu.tsx` — focused-input-on-open detail
- AGENTS.md "Settings substrate" — for `settings.editor.toolStyles` (no debounce in caller; substrate already serializes writes)
- AGENTS.md "Tray + float-over popover sizing — outer `inline-block` measurer" — for the activity bar panel area and all tool popovers
- NN/g hover timing — 300ms enter, 500ms exit with safe-triangle
- `apps/desktop/src/renderer/src/features/editor/Editor.tsx:148-159` — refetch-with-cancelled-flag (the existing pattern; reuse it)

**Files (consolidated from 13 down to 7 per code-simplicity-reviewer):**
- *Added:*
  - `apps/desktop/src/renderer/src/features/editor/EditorChrome.tsx` — activity bar + sidebar shell (with Help panel inlined as a single-component stub)
  - `apps/desktop/src/renderer/src/features/editor/panels/InfoPanel.tsx` — capture metadata; reads via existing `useCaptureRecord` (no new IPC)
  - `apps/desktop/src/renderer/src/features/editor/panels/ToolConfigPanel.tsx` — mirrors the inline ToolStylePopover; same kind-conditional body
  - `apps/desktop/src/renderer/src/features/editor/ToolStylePopover.tsx` — unified popover (kind-conditional body for arrow/text/rect/blur/highlight)
  - `apps/desktop/src/renderer/src/features/editor/CropTool.tsx` — crop mode component
  - `apps/desktop/src/renderer/src/features/editor/useEditorToolState.ts` — sticky mode + per-tool style memory + matching-text affordance state machine (consolidated from 3 hooks per code-simplicity-reviewer)
  - `apps/desktop/src/renderer/src/styles/editor.css` — mine `design/src/editor.css` for class conventions
  - **Tests**: 1 E2E spec per user-visible scenario (skip duplicate hook unit tests per code-simplicity-reviewer):
    - `apps/desktop/e2e/editor-tool-styles.spec.ts`
    - `apps/desktop/e2e/editor-sticky-tool.spec.ts`
    - `apps/desktop/e2e/editor-matching-text.spec.ts`
    - `apps/desktop/e2e/editor-activity-bar.spec.ts`
- *Updated:*
  - `apps/desktop/src/renderer/src/features/editor/Editor.tsx` — refactor to consume `useEditorToolState`; wrap in `EditorChrome` when not inside Library Focus
  - `apps/desktop/src/renderer/src/features/editor/editor-tools.tsx` — add `crop` to Tool union; add `satisfies` check against the toolbar order array
  - `apps/desktop/src/renderer/src/features/library/EditToolbar.tsx` — same tool-set + style memory (Library Focus is chromeless; no `EditorChrome`)
  - `apps/desktop/src/renderer/src/styles/tokens.css` — add `--swatch-*` color tokens
  - `packages/shared/src/protocol.ts` — extend `Settings.editor` with the new shape; `ColorToken` branded union; `ChatMessageContent` discriminated union (Phase 7 prep)
  - `apps/desktop/src/main/settings/defaultSettings.ts` — defaults for `editor.toolStyles` + `editor.coachmarks` + `editor.matchingText` + `editor.sidebar`
  - `apps/desktop/src/main/settings/desktop-settings-service.ts` — `parseV1` for the new nested fields (additive, no schemaVersion bump)
  - `packages/shared/src/overlay-schemas.ts` — extend `ArrowOverlay` zod with `endStyle` / `stemStyle` / `doubleEnded` (v1 overlays accept the new fields; existing arrows without them render with the old defaults)

**Test scenarios:**
- Place an arrow → "+ Add label" affordance appears within 200ms anchored at the arrow's tail. Click it → tool flips to text mode with arrow's color. Click on canvas → text input at click point, pre-styled red. Type "missing index" → ⏎ commits → editor returns to arrow tool with red still selected.
- Open arrow tool popover → first-time-only stoplight coachmark appears for 3s, then auto-dismisses. Closing + reopening any popover later does NOT re-show.
- Pick red for arrow → next text tool's color defaults to red (cross-tool COLOR slot shared).
- Pick "small" thickness for arrow → text/rect/highlight thickness UNCHANGED (per-tool slot).
- Click activity bar Info icon → panel opens pinned. Click again → closes. Settings persist the pin/last-panel.
- Hover Tool Config icon after first session (when first-click-pinned has been satisfied) → 300ms delay → panel pops out as overlay. Mouse out → 500ms grace + safe-triangle → auto-hides.
- ⌘\ toggles entire sidebar; ⌘1/⌘2/⌘3 select Info/Chat/Tool Config.
- Click Crop tool → crop overlay appears with 8 handles, rule-of-thirds guides while dragging, live W×H + ratio in HUD. ↵ commits.
- ⌘Z after placing arrow → arrow removed; tool state stays the same.
- Open editor, change arrow color to green, close editor, reopen → green is still selected (style memory persists via Settings).
- Open editor A with red selected, open editor B (different capture) → B starts with the SAVED default (red), but changes in B do NOT immediately stomp A's active state (window-scoped).
- ⌥-click toolbar tool → single-shot mode (legacy behavior) — place ONE annotation, then return to Pointer.

**Verification:**
- `pnpm -r typecheck` clean
- All E2E specs pass on macOS local + Linux CI
- No `overlays:*` IPC changes; v1 capture flow is unchanged at the data layer
- `bundle_format_version` is not read anywhere in the renderer in this phase
- `useEditorToolState` has 5 cancel sites for the matching-text timer: tool change, capture switch, editor unmount, explicit dismiss, 8s auto

---

#### Phase 2 — Dual-format editor (~6-8h)

**Goal.** Renderer reads both v1 and v2 captures. Invisible plumbing — no user-facing change. Unlocks Phase 3+ and lets us safely create v2 captures via the flag.

**Patterns to follow:**
- `apps/desktop/src/main/render/coordinator.ts:83` — existing main-side branch on `bundle_format_version >= 2`. Use `>= 2` not `=== 2` (per kieran-typescript).
- `apps/desktop/src/renderer/src/features/editor/Editor.tsx:148-159` — refetch-with-cancelled-flag.
- `assertNever(record.bundle_format_version)` exhaustive switch so adding v3 fails compilation (per kieran-typescript).

**Files:**
- *Added:*
  - `apps/desktop/src/renderer/src/features/editor/useCaptureModel.ts` — single hook returning discriminated union (see Architecture section above). Includes the `overlay-to-layer-shim` inlined (per code-simplicity-reviewer). MUST set `cancelled` flag across BOTH branches AND any later doctor call (per julik-races).
  - `apps/desktop/src/renderer/src/features/editor/__tests__/useCaptureModel.test.ts`
  - `apps/desktop/e2e/editor-v2-capture-open.spec.ts`
- *Updated:*
  - `apps/desktop/src/renderer/src/features/editor/Editor.tsx` — consume `useCaptureModel`; drop the direct `overlays:list` calls
  - `apps/desktop/src/renderer/src/features/editor/useUndoRedo.ts` — branch the replay path on the model's format. Add `mouse-up + 300ms grace window per (layer id, op kind)` coalescing per Alt 5 below.
  - `apps/desktop/src/renderer/src/features/library/EditToolbar.tsx` — same hook adoption

**Test scenarios:**
- Open a v1 capture in the editor → `overlays:list` is dispatched; rendering is byte-equivalent to Phase 1
- Open a v2 capture (created via `PWRSNAP_BUNDLE_V2=1`) → `layers:list` is dispatched; rendering byte-equivalent
- Rapidly switch v1 ↔ v2 captures → in-flight requests cancel; no stomp (test: capture A's overlays:list resolves AFTER capture B mounts; A's data must NOT reach B's render)
- ⌘Z works on both formats (replays via the correct IPC family)
- Continuous drag of a layer → ONE undo step (mouse-up boundary)
- Rapid color-burst click (5 swatch clicks within 300ms) → ONE undo step (300ms grace window)

**Verification:**
- `pnpm -r typecheck` clean; both `overlays:list` AND `layers:list` are called from the renderer (greppable)
- Existing v1 captures behave identically to Phase 1
- New v2 captures (via flag) open without the v2-refusal error
- `useCaptureModel`'s cancel-safety verified by a test that resolves the slow branch SECOND

---

#### Phase 3 — v1→v2 lazy doctor (~10-14h, up from 6-8h after deepening)

**Goal.** First time the user opens a v1 capture for editing, migrate it to v2 in place. After Phase 3, every just-opened capture is v2; only never-opened captures stay v1 (and the library grid keeps showing them via the existing dual-read).

**Critical execution corrections (from deepening):**

1. **v1 overlay coords are NORMALIZED [0,1], NOT absolute.** Per `packages/shared/src/overlay-schemas.ts:8-23` (`NormalizedScalar = z.number().min(0).max(1)`) and `migrations/0002_overlays.sql:20`. The doctor MUST multiply by source dims (which equal canvas dims in v1 since v1 has no separate canvas concept). Doctor unit test must round-trip a v1 arrow at `{x:0.5, y:0.5}` on a 2000×1000 source and assert the v2 layer ends at `{x:1000, y:500}`.

2. **v1 blur → v2 sample-below effect layer.** "Static effect layer" is a schema contradiction. Convert v1 blurs to v2 effect layers with sample-below semantics. User-facing implication: if the user later moves layers underneath the blur, the blur will re-render against the new content. This is the v2 marquee — users opening v1 captures get the upgrade. (Alternative considered: rasterize into source — rejected because it loses editability. Alternative considered: add `pinned_sample` schema field — rejected as too big a scope expansion.)

3. **Disk + DB can't be one atomic unit. Strict ordering required:**
   ```
   1. atomicWriteBundle(tempPath, v2_bytes) → fsync
   2. BEGIN IMMEDIATE
      INSERT INTO layers (...)
      UPDATE captures SET bundle_format_version = 2, bundle_path = tempPath, ...
      COMMIT
   3. rename(tempPath → finalBundlePath) + dir-fsync
   4. DELETE FROM overlays WHERE capture_id = ? (idempotent; reconcile-safe)
   ```
   On crash between step 1 and step 2: bundle is in temp location; next boot's reconcile sweep finds orphan temp file, cleans up, re-attempts.
   On crash between step 2 and step 3: DB says v2 + bundle_path points at temp file; next boot's reconcile sweep detects (stat fails on bundle_path), reverts DB UPDATE, re-attempts.
   On crash between step 3 and step 4: orphan rows in overlays table; harmless, swept on next doctor run for ANY capture.

4. **Idempotency check reads bundle manifest, not DB row.** If the DB says v1 but the bundle on disk is v2 (mid-crash gap), the early-return based on DB row would re-attempt a v1→v2 migration on an already-v2 bundle. Doctor reads the bundle manifest's `bundle_format_version` field as authoritative. The v2 plan's "Doctor reconcile — bundle as authoritative source for version fields" pattern (§429-470 of bundle-format-v2 plan) covers this; cite it.

5. **v1 → v2 migration mapping table** (added per data-migration-expert as "the most common bug class for this kind of migration"):

   | v1 overlay column / field | v2 layer field | Transform |
   |---|---|---|
   | `id` | `id` | preserve |
   | `kind` | `kind: "vector"` for arrow/rect/text/highlight; `kind: "effect"` for blur | mapped |
   | `data.x` (NormalizedScalar) | `transform[4]` (translate-x) | × source_width |
   | `data.y` (NormalizedScalar) | `transform[5]` (translate-y) | × source_height |
   | `data.width` (NormalizedScalar) | layer-kind-specific (rect: clip_rect.w; arrow: derived) | × source_width |
   | `data.height` (NormalizedScalar) | layer-kind-specific | × source_height |
   | `data.color` | `style.color` (vector) | preserve |
   | `data.strokeWidth` | `style.thickness` (vector) | preserve |
   | `data.text` | `style.text` (text vector) | preserve |
   | `data.fontSize` | `style.fontSize` (text vector) | preserve |
   | `data.blurMode` | `effect_params.mode` (effect) | preserve |
   | `data.blurRadius` | `effect_params.radius` (effect) | preserve |
   | `z_index` | `z_index` | preserve |
   | `source` (`"user" \| "codex" \| "draft"`) | `source` | preserve |
   | `ai_run_id` | `ai_run_id` | preserve (parent group for run created if non-null) |
   | `applied_at` | `applied_at` | preserve |
   | `rejected_at` | `rejected_at` | preserve |
   | `superseded_by` | `superseded_by` | preserve |
   | `created_at` | `created_at` | preserve |
   | `schema_version` | (dropped — v2 layers carry their own kind discriminator) | drop |
   | `data.crop` (CropOverlay) | special: bake into canvas_dimensions; or carry as vector layer with `kind: "crop"` | **TBD at impl time** (recommend: bake into canvas dims, drop the overlay) |

6. **`edits_version` preservation** so cache-buster URLs (`pwrsnap-cache://r/<id>/<w>w.<fmt>?v=<edits_version>`) stay stable across the migration. Library thumbnails won't reflow.

7. **`migration:status` cached-snapshot verb** mirroring `legacy-bundle-migration.ts:261-277`. Editor renders toolbar disabled with "Upgrading…" banner during the doctor run; opens the toolbar after the cached "complete" snapshot arrives.

**Files:**
- *Added:*
  - `apps/desktop/src/main/persistence/migrations/0013_v1_to_v2_migration_status.sql` — adds `v1_to_v2_attempts`, `v1_to_v2_last_failed_at`, `v1_to_v2_last_error_code` columns
  - `apps/desktop/src/main/persistence/v1-to-v2-doctor.ts`:
    - `migrateBundleV1ToV2(captureId): Promise<Result<{ migrated: boolean, reason?: "already_v2" }, PwrSnapError>>` — conforms to AGENTS.md Result pattern per kieran-typescript
    - Internal helper `synthesizeV2DocumentFromV1Overlays(overlaysArray, manifestV1): BundleDocumentV2` with the mapping table above
    - `reconcileV1ToV2OnBoot()` — boot-time sweep that finds (DB says v1) ∧ (bundle is v2) or (DB says v2) ∧ (bundle is v1) mismatches and fixes them; also cleans up orphan temp files
  - `apps/desktop/src/main/handlers/migration-handlers.ts` (or extend existing) — adds `migration:upgradeBundle` bus verb; `migration:status` bus verb (snapshot reader)
  - `apps/desktop/src/main/__tests__/v1-to-v2-doctor.test.ts` — including the coordinate-round-trip test
  - `apps/desktop/src/main/__tests__/v1-to-v2-reconcile.test.ts` — injected crash scenarios
  - `apps/desktop/e2e/v1-to-v2-doctor-on-open.spec.ts`
- *Updated:*
  - `packages/shared/src/protocol.ts` — add `migration:upgradeBundle` + `migration:status` verbs
  - `apps/desktop/src/renderer/src/features/editor/useCaptureModel.ts` — separate `useEnsureV2()` orchestration hook (per architecture-strategist: don't bundle migration triggering inside the data-access hook). On v1 capture, call `useEnsureV2` first; while it's in-flight, render toolbar disabled.
  - `apps/desktop/src/main/index.ts` — boot-time `reconcileV1ToV2OnBoot()` call

**Test scenarios:**
- Open a v1 capture with no overlays → doctor produces a single-raster v2 bundle; reopens as v2; composite identical
- Open a v1 capture with 3 arrows + 1 text + 1 blur → doctor produces 1 raster + 4 vector layers + 1 effect layer; coords multiplied by source dims; reopens as v2; composite identical to v1 composite at moment of migration
- Open the same v1 capture twice — second open is a no-op (already v2; idempotency reads bundle manifest)
- Open 5 v1 captures concurrently from Library (rapid click) → each gets its own doctor run; no cross-capture interference
- Inject failure: kill process between step 1 (bundle written to temp) and step 2 (DB COMMIT) → next boot's reconcile sweep deletes temp file; doctor retries on next user open
- Inject failure: kill process between step 2 (DB COMMIT) and step 3 (rename) → next boot's reconcile sees DB says v2 + bundle_path points at temp that doesn't exist; reverts DB to v1; doctor retries
- Inject failure: kill process between step 3 (rename) and step 4 (DELETE overlays) → orphan rows in overlays table; reconcile sweeps next run; no user-visible impact
- Doctor fails 5 times → row parked (`v1_to_v2_attempts ≥ 5`); banner "Couldn't upgrade — read-only view"; user sees retry button; capture stays openable as read-only v1
- v1 capture with `ai_run_id` populated → migrated v2 preserves the ai_run_id and creates a parent group layer per run
- v1 capture with soft-deleted overlays (`rejected_at` non-null) → migrated v2 has the same layers with `rejected_at` preserved; ⌘Z restores them correctly

**Verification:**
- `pnpm -r typecheck` clean
- All doctor unit tests pass, including coordinate-round-trip test
- All 3 crash-injection tests pass
- On-open migration is invisible for the typical small-capture case (<200ms p95; <500ms p99)
- Doctor failure leaves on-disk state in a recoverable form (reconcile sweep heals on next boot)
- View-only fallback works: user sees the capture rendered correctly but no toolbar

---

#### Phase 6 — Default flag flip (~3-4h, MOVED UP from original Phase 6)

**Goal.** New captures are v2 by default. The `PWRSNAP_BUNDLE_V2` env var survives as a debug override.

**Why this moves before Phase 4-5** (per architecture-strategist + agent-native): smart blur and multi-image are v2-only features. If they ship before the flag flip, they only work for users with the env var set — dogfood-only. Flipping first lets real user captures exercise the smart blur + paste flows.

**Patterns to follow:**
- `apps/desktop/src/main/feature-flags.ts:31` — existing flag implementation
- v2 bundle plan §"Shipping Status" — promotion checklist

**Rollout safety (gaps surfaced by deployment-verification-agent):**
- **No telemetry exists.** Original plan called for "telemetry catches regressions" — weakened to "user-reported only + manual rollback procedure" since PwrSnap has no telemetry substrate.
- **Optional Phase 5.5 dual-write window**: write the v2 bundle AND a v1 sidecar (`overlays-v1-sidecar.json`) for the first 2 weeks after flip. Lets users roll back individual captures if a v2 codepath bug surfaces. Adds ~20% disk overhead temporarily; deletable via a one-shot sweep after the soak period.
- **Settings → Storage → "Upgrade all captures now" action** (per deployment-verification-agent Q3): users who want a clean upgrade can trigger the doctor for all v1 captures in one batch. Optional; not required for Phase 6.
- **Rollback procedure documented**: `PWRSNAP_BUNDLE_V2=0` reverts new-capture creation to v1. Existing v2-on-disk captures stay v2; if Phase 5.5 sidecar is in place, they can be rolled back individually via a Settings action.

**Files:**
- *Updated:*
  - `apps/desktop/src/main/feature-flags.ts` — `isV2WriteEnabled()` returns true unless `PWRSNAP_BUNDLE_V2=0`
  - `AGENTS.md` "Bundle format v2 — experimental, opt-in" section — update to reflect default-on
  - `docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md` "Shipping Status" — "v2 is the default"
- *Optional (Phase 5.5 sidecar):*
  - `apps/desktop/src/main/persistence/bundle-store.ts` — `writeV2BundleWithV1Sidecar()` helper
  - `apps/desktop/src/main/handlers/library-handlers.ts` — `library:rollbackV2ToV1` verb + Settings → Storage button

**Test scenarios:**
- Fresh boot, no env var → new capture writes a v2 bundle
- `PWRSNAP_BUNDLE_V2=0` → new capture writes a v1 bundle (escape hatch)
- Existing v1 capture on disk → still opens; Phase 3 doctor upgrades on first edit
- Phase 5.5 sidecar (if enabled): rollback a v2 capture to v1 → libraries see the v1 bundle, editor loads as v1, no data loss

**Verification:**
- E2E pass with the flag off (default), confirming v2 capture creation
- The doctor (Phase 3) handles existing v1 captures correctly
- Rollback verified end-to-end
- AGENTS.md "Bundle format v2" section updated

---

#### Phase 4 — Smart blur effect layer (~10-14h, up from 8-10h after deepening)

**Goal.** Blur tool produces a v2 effect layer with sample-below semantics. User-facing behavior: drag the blurred region; the blur visibly tracks the pixels now underneath it.

**Performance design (per performance-oracle):** naive wire-up would dispatch `layers:upsert` per `pointermove`, triggering re-fetch + re-compose + PNG encode at ~80-250ms per encode = 4-12fps at 4K. Unacceptable.

**Drag preview architecture:**
1. **During pointerdown..pointermove**: render the effect as `backdrop-filter: blur(Npx)` on a positioned `<div>` overlay (zero IPC, GPU-composited, 60fps). The `<div>` follows the cursor.
2. **On pointerup**: dispatch ONE `layers:upsert` with the final geometry. composeV2 produces the authoritative composite. backdrop-filter overlay removed.
3. **For static (non-drag) renders**: composeV2 produces the sample-below result. Cache key includes `hash_of_layers_below`; `renderHashTree` invalidates correctly.

**Patterns to follow:**
- v2 bundle plan §"Render contract — tree-walking compositor with sample-below" — existing `composeV2` already implements sample-below
- The blur tool's existing UX (`BlurMenu.tsx`) — UX-equivalent in the new `ToolStylePopover` blur branch

**Files:**
- *Added:*
  - `apps/desktop/src/renderer/src/features/editor/EffectDragPreview.tsx` — CSS backdrop-filter overlay for the during-drag preview
  - `apps/desktop/src/renderer/src/features/editor/__tests__/blur-tool-produces-effect-layer.test.ts`
  - `apps/desktop/e2e/editor-smart-blur.spec.ts` — includes "drag the blur over a moving raster" scenario
  - `apps/desktop/e2e/editor-smart-blur-perf.spec.ts` — measures per-frame compose time during drag; asserts p95 < 33ms (30fps)
- *Updated:*
  - `apps/desktop/src/renderer/src/features/editor/Editor.tsx` — when v2 mode AND blur tool active, persistOverlay routes through `layers:upsert` with `kind: "effect"` payload
  - `apps/desktop/src/main/render/compose-tree.ts` — verify (no change expected) sample-below works for editor's effect-layer payload
- *Removed (in Phase 8, not here):*
  - `BlurMenu.tsx`, `BlurOverlays.tsx` — kept alive in Phase 4 for v1 captures (gated by `format` from useCaptureModel); deleted in Phase 8

**Test scenarios:**
- Place a blur over a screenshot of a credit card → cmd-drag the blur down 100px → blur now obscures what was 100px lower (proves sample-below in user's hand)
- Same flow but move the source layer underneath the blur → blur's pixel content changes
- Blur radius 12px → bump to 24px via popover → blur re-renders coarser
- Place blur with mode=redact → solid black-fill effect layer
- v1 capture migrated to v2 (post-Phase 3) → existing blur overlays are now effect layers; behavior matches a fresh v2 blur
- Perf E2E: drag a blur over a 4K raster for 5 seconds; assert frame time p95 < 33ms (CSS preview), assert single composeV2 commit on pointerup

**Verification:**
- `pnpm test` for render assertions
- Visual regression: blur position vs underlying pixel content
- E2E spec proves drag flow end-to-end on macOS
- Perf E2E confirms the CSS-preview-then-commit pattern works
- v2 bundle's `document.json` post-edit contains the new effect-layer node with correct `clip_rect` + `effect_params`

---

#### Phase 5 — Multi-image paste/drop (~8-10h, up from 5-7h after deepening)

**Goal.** ⌘V on the canvas creates a raster layer from the clipboard image. Drag a file from Finder onto the canvas does the same. Both work on v2 captures only.

**Security gates (per security-sentinel):**

1. **`assertSafePastedFile(path)`** for Finder-dropped files:
   - `lstat` reject symlinks
   - Reject non-regular files
   - Reject paths inside privileged dirs: `/private/etc`, `/private/var`, `~/Library/Keychains`, `~/.ssh`, `~/.aws`, `/System`, `/Volumes/.timemachine.local`
   - Mirror `assertSafeBundleFile` semantics from `bundle-store.ts:123`
2. **Same 5-defense pipeline as `clipboard-handlers.ts`**:
   - Size cap (32 MiB per file)
   - sharp decode-probe with `MAX_IMAGE_DIM_PX` (32768²) check
   - sha256 content-integrity (the file's sha256 is the bundle source filename)
   - Sanitized errors (no path leakage in errors flowing to renderer)
3. **E2E with malformed PNG fixture** — assert paste rejects + reports a clear error

**Performance design (per performance-oracle):**
- **Sharp decode + sha256 in worker thread** (`node:worker_threads`), not main thread
- **"Pasting…" affordance** appears immediately at click point; resolves to raster layer when worker returns
- Hash and metadata run concurrently via `crypto.createHash` streaming

**Patterns to follow:**
- PR #48 (`capture:pasteFromClipboard`) — existing clipboard-image pipeline; reuse for "add to current capture as raster layer"
- `apps/desktop/src/main/handlers/clipboard-handlers.ts:255-410` — `clipboard:pasteLayerFragment`'s 5-defense paste pattern

**Files:**
- *Added:*
  - `apps/desktop/src/main/security/assertSafePastedFile.ts` — security gate for dropped files
  - `apps/desktop/src/main/workers/paste-image-worker.ts` — off-main sharp decode + sha256
  - `apps/desktop/src/renderer/src/features/editor/usePasteImage.ts` — ⌘V handler; dispatches to bus
  - `apps/desktop/src/renderer/src/features/editor/useDropImage.ts` — Finder-drop handler; same dispatch path
  - `apps/desktop/src/main/handlers/editor-handlers.ts` (extend) — `editor:pasteImageAsLayer` and `editor:dropImageAsLayer` bus verbs. Internally call `layers:upsertRasterFromBytes` so AI gets parity (see Phase 7).
  - `apps/desktop/e2e/editor-paste-image-layer.spec.ts`
  - `apps/desktop/e2e/editor-paste-image-security.spec.ts` — malformed PNG, symlink reject
- *Updated:*
  - `packages/shared/src/protocol.ts` — new bus verbs

**Test scenarios:**
- Copy a PNG to clipboard → focus editor → ⌘V → "Pasting…" affordance at click point → raster layer appears centered within 300ms (assert latency)
- Drag a `.png` file from Finder onto canvas → raster layer at drop point
- Drag a `.txt` file → rejected with toast "Only image files supported"
- Drag a symlink that points at `~/.ssh/id_rsa` → rejected with toast "Invalid file"
- Drag a path inside `/etc/` → rejected
- Paste a malformed PNG → sharp decode fails → rejected with sanitized error
- Paste an image > 32 MiB → size cap rejects
- ⌘V with no clipboard image and a layer-fragment instead → routes to `clipboard:pasteLayerFragment` (existing path); no double-handling

**Verification:**
- E2E pass for paste + drop flows + all security rejections
- Worker thread offloading verified (main thread not blocked > 50ms during paste of 5 MB PNG)
- All clipboard:pasteLayerFragment defenses (size cap, schema, sha256-verify, decode-probe, sanitized errors) replicated for editor:pasteImageAsLayer

---

#### Phase 7 — Chat panel + AI primitives wrapper (~26-40h, up from 20-30h after deepening)

**Goal.** The Chat with AI panel becomes live. User types a request; Codex App Server reads the capture (composite + layer tree + style preferences) as context; AI's annotations land as layers; user can undo, accept-each, or modify. Chat history persists with the bundle.

**Architectural reshape per agent-native-architecture skill:** Phase 7's three-file split (codex-editor-bridge + layers-tool-surface + chat-handlers) is correctly sized, but the **tool surface itself was wrong-shape** in the first draft. Replaced workflow wrappers (`add_arrow(...)`) with primitive shim + capability discovery. Six gaps addressed:

**Gap 1 — Primitive shim, not workflow wrappers.** Tool surface exposes `layers:*` verbs verbatim as 5 Codex tools:
```ts
// apps/desktop/src/main/ai/layers-tool-surface.ts — thin shim
tool("list_layer_capabilities", "Discover current layer kinds, effects, style options",
     async () => generateCapabilityFromZod(BundleLayerNode));  // self-modifying via schema
tool("layers_list", { capture_id }, async (a) => bus.dispatch("layers:list", a));
tool("layers_upsert", { capture_id, layer: BundleLayerNode }, async (a) => bus.dispatch("layers:upsert", a));
tool("layers_delete", { layer_id }, async (a) => bus.dispatch("layers:delete", a));
tool("layers_reparent", { id, new_parent_id }, async (a) => bus.dispatch("layers:reparent", a));
tool("layers_reorder", { id, z_index }, async (a) => bus.dispatch("layers:reorder", a));
// Phase 5 parity
tool("layers_upsertRasterFromBytes", { capture_id, png_b64, position }, async (a) => bus.dispatch("layers:upsertRaster", a));
// Crop parity (per agent-native-reviewer)
tool("document_crop", { capture_id, rect }, async (a) => bus.dispatch("document:crop", a));
// AI run grouping (built into layers_upsert via parent_id)
```
No `add_arrow`, no `add_blur`, no `add_text` — AI composes from primitives. When Phase 9 ships brush layers, `list_layer_capabilities` automatically reports them; AI learns without code change.

**Gap 2 — `render:composite` for AI vision.** New bus verb returns base64 PNG of current canvas at downsampled resolution (1440px longest edge — per security-sentinel privacy concern). AI uses for vision-grounded spatial reasoning + self-verification after writes ("did the blur land over the credit card?").

**Gap 3 — AI session context includes user's tool style preferences.** `codex-editor-bridge.ts` builds a per-session system context that injects:
```
## User's tool style preferences (from settings.editor.toolStyles)
- arrow: red for errors, green for confirmation, default thickness "medium"
- text: same color as paired arrow (matching-text flow active)
- stoplight semantics: red=bad, yellow=warn, green=good, blue=context

## Recent activity (last 5 user edits this session)
- 14:32: placed red arrow at (220,180)
- 14:32: placed red text "this fails" at (240,200)
- 14:31: placed green arrow at (520,180)
```
Re-injected on every `chat:send`. AI-placed annotations match the user's stoplight pattern by default.

**Gap 4 — Per-layer reject within an AI run (not just whole-run undo).** Each AI-placed layer renders with a small "✕" badge while the AI turn is "open" (before next user turn). Click ✕ → rejects that one layer. Whole-run ⌘Z still works (rejects parent group + cascades). Two reject paths; user picks.

**Gap 5 — Per-tool-call zod errors surface to AI.** When AI's `layers_upsert` payload fails zod validation, return a structured error to the AI as a tool result:
```
{ isError: true, text: "Invalid payload: opacity must be 0-1, got 1.5. Expected shape: {...}" }
```
AI sees the error and self-corrects. Chat panel shows a subtle "AI's last call was rejected — retrying" indicator. NOT a full-turn reject (which was the first-draft behavior).

**Gap 6 — System prompt biases toward act-then-offer-followups.** Codex thread system prompt template:
```markdown
## When to ask vs act
Before placing layers, use render_current_composite to ground your reasoning. Then:
- If the request is unambiguous + you can see the target → ACT
- If multiple equally-good targets exist → act on most likely + offer "I picked X; also Y and Z?"
- If you can't see the referenced element at all → ASK before acting
Prefer fast wrong-then-correct over slow right.
```

**Gap 7 — Capability discovery via `list_layer_capabilities`.** Reads zod schema's `_def` to enumerate kinds/fields. Self-modifying: new layer kinds added in Phase 9+ automatically light up for AI without bridge code change.

**Security gates (per security-sentinel):**
- Codex is a separate local process; treat its output as untrusted regardless of process locality
- Per-turn op cap: max 30 tool calls per AI turn
- Per-session rate limit: max 5 turns/min
- Confirm-batch affordance: if AI proposes ≥ 5 layer writes in one turn, show "Apply 5 changes from AI" + Accept/Reject before applying
- Re-validate every tool-call payload through the same zod schemas the renderer would use
- AI-supplied raster bytes: apply the same 5-defense pattern as `clipboard:pasteLayerFragment`
- Markdown in AI responses: render as text, never as HTML (XSS via AI response is a real risk if panel uses `dangerouslySetInnerHTML`)

**v1 capture gate (per agent-native-reviewer):**
Chat panel is disabled with banner "Open this capture in the editor first to enable AI annotation" for any capture with `bundle_format_version !== 2`. Prevents AI from operating on a capture that's mid-doctor-migration.

**Chat history persistence + export:**
- Lives in `chat.json` inside the bundle (1MB cap)
- Settings toggle `settings.editor.chat.includeInExports: boolean` (DEFAULT OFF)
- Excluded from `clipboard:pasteLayerFragment` payload by default (privacy)
- Failed AI turn: keep user message persisted; mark AI response as `error` (per data-integrity-guardian's explicit pick)

**Files:**
- *Added:*
  - `apps/desktop/src/main/ai/codex-editor-bridge.ts` — opens Codex App Server thread per chat session; builds per-session system context (Gap 3)
  - `apps/desktop/src/main/ai/layers-tool-surface.ts` — thin shim over `layers:*` + `list_layer_capabilities` discovery tool (Gaps 1, 7)
  - `apps/desktop/src/main/ai/system-context-builder.ts` — injects user prefs + recent activity (Gap 3)
  - `apps/desktop/src/main/ai/ai-rate-limiter.ts` — per-turn op cap + per-session rate limit (security)
  - `apps/desktop/src/main/render/composite-snapshot.ts` — `render:composite` verb implementation (Gap 2)
  - `apps/desktop/src/main/handlers/chat-handlers.ts` — `chat:send`, `chat:history`, `chat:rejectAiRun`, `chat:rejectLayer` bus verbs
  - `apps/desktop/src/main/persistence/chat-repo.ts` — chat.json read/write
  - `packages/shared/src/chat-schemas.ts` — zod schemas with discriminated union for `ChatMessageContent` (Gap 5; addresses kieran-typescript's flag)
  - `apps/desktop/src/renderer/src/features/editor/panels/ChatPanel.tsx` — replaces Phase 1 stub
  - `apps/desktop/src/renderer/src/features/editor/AiLayerBadge.tsx` — per-layer ✕ badge during open AI turn (Gap 4)
  - Multiple test files per module
- *Updated:*
  - `packages/shared/src/bundle-manifest-schema-v2.ts` — `validateBundleZipEntryNamesV2` accepts `chat.json`; reject `chat.json.bak` / path-traversal variants (test)
  - `apps/desktop/src/main/persistence/bundle-store.ts` — pack/unpack chat.json
  - `apps/desktop/src/main/handlers/clipboard-handlers.ts` — `copyLayerFragment` excludes chat.json from payload by default
  - `packages/shared/src/protocol.ts` — Chat bus verbs + `render:composite` + namespace decision: use `codex:` for AI verbs (per pattern-recognition: don't add a new `chat:` namespace next to existing `codex:*`)
- *New IPC verbs added to layer surface (per agent-native-reviewer):*
  - `layers:upsertBatch` — transactional batch + single broadcast (performance + atomic AI runs)
  - `layers:upsertRaster` — direct raster-from-bytes (so AI doesn't need clipboard/drop state)
  - `layers:atPoint` — hit-test (so AI can answer "what's at (340, 220)?")
  - `layers:bbox` — bounding box of a layer (so AI can place "next to layer X")
  - `layers:undo` / `layers:redo` — programmatic undo (so AI can recover from its own bad turn)
  - `document:crop` — canvas crop (so AI can use Crop)
  - `editor:listToolStyles` — read-only view of user's style preferences (so AI doesn't have to read raw Settings)

**Test scenarios:**
- User types "blur the credit card" → AI calls `render_current_composite`, then `layers_upsert` with effect layer → blur appears + chat reply "I added a blur over the credit-card field"
- User undoes (⌘Z) → entire AI run reverts (parent group rejected, all children cascade)
- User clicks ✕ on one of 3 AI-placed arrows → that arrow disappears; other 2 stay
- User asks "add 3 arrows pointing at the buttons" → AI adds 3 vector layers via `layers_upsertBatch` → ONE broadcast → renderer re-renders ONCE → ⌘Z reverts all 3 in one step
- AI proposes 10 layer writes → "Apply 10 changes from AI" affordance appears with Accept/Reject buttons
- AI exceeds 30 tool calls in one turn → handler returns `Result.err({ kind: "ai", code: "rate_limited" })` → chat shows "AI exceeded action budget"
- AI sends malformed `layers_upsert` payload → bridge returns per-tool-call zod error → AI sees it + retries
- AI's payload references a layer_id that doesn't exist → bridge returns clear error → AI sees it
- Chat history persists across editor close/reopen; survives bundle round-trip
- Export bundle with `includeInExports: false` → received bundle has NO chat.json
- `clipboard:copyLayerFragment` → received fragment has NO chat content
- v1 capture → Chat panel disabled with banner; opening it triggers doctor + then re-enables chat
- AI tries to operate on a capture whose `bundle_format_version === 1` → handler refuses with clear error

**Verification:**
- All chat-related unit + integration tests pass
- Chat history survives bundle round-trip
- AI annotations carry `source: "codex"` + valid `ai_run_id`
- E2E exercises full chat → tool calls → layer materialization (with stubbed Codex for CI reliability)
- Per-layer ✕ reject works
- Whole-run ⌘Z works
- Per-tool-call zod error visible to AI in retry chain
- Rate-limit + op-cap enforced

---

#### Phase 8 — Retire v1 codepath (~10-14h, up from 4-6h after deepening)

**Goal.** After Phase 6 has soaked for ≥ N weeks (recommend ≥ 4) AND zero user-reported v2 regressions in that period, retire the v1 codepath.

**Hard prerequisite gates:**
1. **All v1 captures upgraded**: run a one-shot upgrade job (`reconcileV1ToV2OnBoot()` extended to walk every `bundle_format_version = 1` row). Settings → Storage → "Upgrade all captures now" surfaces this for users who want a clean start.
2. **Refuse-to-migrate guard in `0014_drop_overlays_table.sql`** (per data-integrity-guardian): the migration first runs `SELECT count(*) FROM captures WHERE bundle_format_version = 1` and aborts if non-zero.

**Files:**
- *Removed:*
  - `apps/desktop/src/main/handlers/overlays-handlers.ts`
  - `apps/desktop/src/main/persistence/overlays-repo.ts`
  - `apps/desktop/src/renderer/src/features/editor/BlurMenu.tsx`
  - `apps/desktop/src/renderer/src/features/editor/BlurOverlays.tsx`
  - `apps/desktop/src/main/persistence/v1-to-v2-doctor.ts` (job done; but keep the boot-time reconcile)
- *Updated:*
  - `apps/desktop/src/renderer/src/features/editor/useCaptureModel.ts` — collapse to single-format path
  - `packages/shared/src/protocol.ts` — remove `overlays:*` verbs
- *NOT removed* (per schema-drift-detector): the `overlays` SQLite table. Dropping it requires another migration that breaks rollback for any user on an old build. Maintenance cost of carrying an empty table is ~zero (16 bytes/row of nothing).

**Test scenarios:**
- Existing v2 captures continue to open and edit
- The one-shot upgrade job processes every remaining v1 capture before this phase ships
- No grep hits for `overlays:` in the codebase after this phase
- The `0014` migration refuses to run if any v1 captures remain (gate works)

**Verification:**
- `pnpm -r typecheck` clean
- Full E2E suite green
- DB has zero rows with `bundle_format_version = 1`

## Alternative Approaches Considered

**Alt 1: Big-bang single PR.** Rejected: too much surface; user-facing value blocked until everything is ready.

**Alt 2: v2-only editor, no dual-mode.** Rejected: makes doctor blocking for any v1 capture open; first-open feels broken; ⌘Z on a fresh-migrated capture could be confusing. Dual-mode is safer for the transition window.

**Alt 3: Layers panel as long-tail follow-up.** Removed entirely per user feedback (rather than deferred). Implications: users have no panel-side reorder/hide; must click annotation directly. Acceptable per the user's articulation; re-add if usage signals demand.

**Alt 4: AI as separate plan, not a phase here.** Phase 7 could absolutely be its own follow-up plan. Including it here keeps the editor + AI thinking unified. Marked as scope-cut candidate if timeline pressure surfaces.

**Alt 5: Undo coalescing strategy.** Chosen: **mouse-up boundary + 300ms grace window per (layer id, op kind)** for user-driven edits. For AI runs: **explicit `beginAiRun()` / `endAiRun(groupId)` markers** since AI has no mouse-up. The AI run's batch is one undo step regardless of how many `layers:upsert` calls happen between markers (per julik-frontend-races: mouse-up boundary alone is insufficient for programmatic edits).

**Alt 6: Phase ordering 1→2→3→4→5→6→7 (original) vs 1→2→3→6→4→5→7 (chosen).** Original had v2-only features (Phase 4-5) shipping before flag flip → dogfood-only audience. Chosen order flips first so real captures exercise the features. Architecture-strategist + agent-native both recommended this.

**Alt 7: AI tool surface as workflow wrappers (`add_arrow`, `add_blur`) vs primitive shim.** Original draft used wrappers. Replaced with thin shim over `layers:*` + `list_layer_capabilities` discovery tool per agent-native-architecture skill. Wrappers encode UI choices the AI shouldn't make; primitives let AI compose novel annotations from existing parts (e.g., "callout box" = group + rect + text without a `add_callout` tool needing to exist).

**Alt 8: AI annotation review flow — instant-with-undo vs propose/apply gate.** Chosen: **instant-with-undo + per-layer ✕ + ≥N confirm-batch**. Reasons: matches "annotator first" framing; fast iteration; user trusts AI more over time. Propose/apply gate considered but feels too gated for an annotator (Photoshop's Smart Object workflow isn't what users want here).

**Alt 9: `chat.json` as separate bundle entry vs embedded in `document.json`.** Chosen: separate file. Pattern-recognition flagged that tags + description are embedded in manifest, so chat could be embedded in document.json. Going with separate file because chat is a list (vs scalar) and could grow large; size cap is easier to enforce on a separate entry; zod read of `document.json` shouldn't blow up because of chat-history-related issues.

## System-Wide Impact

### Interaction Graph

```
USER ACTION: drag an arrow's endpoint
  → editor onPointerMove (continuous)
    → updates draft geometry locally (no IPC during drag)
  → editor onPointerUp
    → flushes draft to bus: layers:upsert (v2) OR overlays:upsert (v1)
      → handler validates payload via zod
        → INSERT into layers / overlays + bump captures.edits_version (txn)
          → broadcastLayersChanged([captureId]) or broadcastCapturesChanged([captureId])
            → every BrowserWindow receives the event
              → library re-fetches its head page
              → editor re-fetches via useCaptureModel (with cancelled flag)
              → float-over re-renders if showing this capture
          → scheduleRepack(captureId) — debounced 5s v2 / 1s v1
            → eventually writes a new .pwrsnap bundle atomically
              → updates captures.bundle_modified_at + bundle_edits_version
    → undo/redo stack pushes the inverse op (with mouse-up boundary + 300ms grace)
  → onPointerUp also fires the matching-text affordance for arrow placements
    → renders "+ Add label" button at arrow's tail endpoint
    → countdown timer; auto-dismisses on tool change, capture switch, editor unmount, 8s

AI RUN: user types "blur the credit card" in Chat
  → chat-handlers.ts dispatches chat:send to Codex App Server
    → bridge attaches per-session system context (settings.editor.toolStyles + last-5 edits)
    → AI calls render_current_composite → 1440px downsampled PNG
    → AI reasons over pixels; calls layers_upsert with effect layer payload
      → bridge validates via zod
        → on failure: structured error returned as tool result; AI self-corrects
        → on success: dispatches layers:upsert via bus (rate-limit checked first)
          → handler stamps source: "codex", ai_run_id
            → broadcast (or coalesces if part of layers:upsertBatch)
              → editor renders the AI-placed layer with ✕ badge (open AI turn)
    → AI's response message + tool_call records appended to chat.json
  → user clicks ✕ on one AI-placed layer → chat:rejectLayer → that one removed
  → user ⌘Z → chat:rejectAiRun → entire run reverted via group cascade
```

Two-level trace: **place-arrow → 5 main-side hooks fire** (validate → insert → broadcast → scheduleRepack → reconcile). **AI run → 8 main-side hooks** (rate-limit → bridge → zod → bus → insert → broadcast → repack → chat-repo). Both synchronous on the main thread.

### Error & Failure Propagation

| Surface | Failure mode | Where caught | User sees |
|---|---|---|---|
| `layers:upsert` zod refuse | malformed payload | handler returns `Result.err({kind: "validation", code: "schema_mismatch"})` | Toast "Couldn't save: schema mismatch"; undo restores prior state |
| `layers:upsert` BEGIN IMMEDIATE deadlock | concurrent reparent + this insert | handler converts to `Result.err({kind: "validation", code: "would_create_cycle"})` | Toast "Couldn't move: would create cycle" |
| `migration:upgradeBundle` read fail | corrupt v1 bundle | handler returns `Result.err({kind: "io", code: "read_failed"})` | Banner "Couldn't upgrade — read-only view"; editor toolbar disabled |
| `migration:upgradeBundle` write fail | disk full mid-write | atomic ordering guarantees rollback or boot-time reconcile heals; handler returns `Result.err({kind: "io", code: "write_failed"})` | Same banner; underlying v1 bundle unchanged |
| Doctor crash between bundle-write and DB COMMIT | process kill | boot-time reconcile sweep finds orphan temp file, cleans up | Next user open retries the doctor |
| Doctor crash between DB COMMIT and rename | process kill | boot-time reconcile sweep detects (stat fails on bundle_path), reverts DB UPDATE | Next user open retries the doctor |
| `editor:pasteImageAsLayer` symlink reject | malicious drop | `assertSafePastedFile` rejects; handler returns `Result.err({kind: "security", code: "unsafe_path"})` | Status toast "Invalid file" |
| `editor:pasteImageAsLayer` non-image | user pasted text or fragment | handler returns `Result.err({kind: "validation", code: "not_image"})` | Status toast "Only images can be pasted onto the canvas" |
| `chat:send` Codex unreachable | Codex CLI not installed / wrong path | handler returns `Result.err({kind: "ai", code: "codex_unreachable"})` | Chat panel "Codex is not configured — open Settings → AI" with link |
| `chat:send` per-tool-call zod fail | AI produced invalid layer payload | bridge returns structured error to AI as tool result; AI self-corrects | Chat shows subtle "AI's last call was rejected — retrying" |
| `chat:send` rate limit | AI exceeded 30 calls/turn or 5 turns/min | handler returns `Result.err({kind: "ai", code: "rate_limited"})` | Chat shows "AI exceeded action budget" |
| `chat:send` confirm-batch | AI proposed ≥N writes | bridge pauses; UI shows "Apply N changes" Accept/Reject | User explicitly approves |
| Failed AI turn rollback | mid-turn crash | user message kept; AI response marked `error` | User sees their message + a clear "AI failed to respond" indicator |

### State Lifecycle Risks

**Phase 1 — Tool state persistence.** `settings.editor.toolStyles` writes pass through `DesktopSettingsService` (substrate serializes; no caller-side debounce per pattern-recognition). Commit-on-window-close via `beforeunload` so a ⌘Q within 300ms doesn't lose the in-flight color change.

**Phase 3 — Doctor partial-write atomicity.** Strict ordering: write-bundle-to-temp → tx(INSERT layers + UPDATE captures) → fsync → rename → DELETE overlays. Each step is recoverable on its own; reconcile sweep heals any mid-step crash. The DELETE is intentionally last + idempotent so a crash there leaves orphan rows that are swept on next doctor run.

**Phase 3 — Settings substrate corruption fallback.** Per data-integrity-guardian: if Settings file is corrupted, substrate quarantines as `pwrsnap-settings.corrupt-<iso>.json` AND fires a `SettingsCorruptionDetected` event. Add a one-time toast on this event ("Your settings file was reset; previous file backed up as …"). Applies to ALL settings; promote to a substrate-level pattern.

**Phase 4 — Effect layer orphan reference.** A v2 effect layer's `clip_rect` references a region of the canvas. If a raster layer underneath is deleted (or repositioned off-canvas), the effect layer still has a valid `clip_rect` — render is over whatever pixels are now there (possibly transparent canvas). Compositor behavior: render normally; transparent canvas underneath = transparent blur. Acceptable.

**Phase 5 — Source PNG orphans.** Plan defers to bundle repack sweep. Add ordering constraint: repack sweep requires debounce ≥ undo-stack-retention-window (currently 5s) OR uses ref-counted soft-delete (mark orphan, sweep on next repack). Phase 5 will use the simpler "debounce-then-sweep" pattern; revisit if telemetry shows the orphan window matters.

**Phase 7 — Chat history during failed AI turn.** Decision picked: keep user message persisted; mark AI response as `error`. User doesn't lose typed prompts on Codex disconnect.

**Phase 7 — Multi-window editor tool state.** Tool state is window-scoped. Settings broadcasts of `settings.editor.toolStyles` DO NOT trigger live re-application in other open editor windows (would be jarring). Other windows pick up new defaults on next open. Acceptable trade-off.

### API Surface Parity

The plan touches four IPC families:
- **`overlays:*`** — used by v1 captures (Phases 1-7); deleted in Phase 8
- **`layers:*`** — used by v2 captures (Phase 2-onward); expanded in Phase 7 with `upsertBatch`, `upsertRaster`, `atPoint`, `bbox`, `undo`, `redo`
- **`editor:*` orchestration verbs**: `pasteImageAsLayer`, `dropImageAsLayer` (Phase 5); `listToolStyles` (Phase 7)
- **`codex:*`** AI verbs (extending the existing `codex:` namespace per pattern-recognition): `codex:chat:send`, `codex:chat:history`, `codex:chat:rejectAiRun`, `codex:chat:rejectLayer`
- **`migration:*`**: `migration:upgradeBundle`, `migration:status`
- **`render:*`**: `render:composite` (Phase 7, for AI vision)
- **`document:*`**: `document:crop` (Phase 7 for AI parity)

Surface parity check (per agent-native-reviewer):
- Library Focus mode (`features/library/EditToolbar.tsx`) currently uses `overlays:*` directly. Phase 2 migrates it to `useCaptureModel`. The editor + Focus share the same hook so they stay parity-locked.
- The float-over (post-capture toast) doesn't edit; only renders. Main-side `coordinator.ts` already dual-reads; no change.
- AI parity: every user-facing capability (place arrow, crop, paste image, undo) has an AI-accessible IPC equivalent. Tool style preferences readable via `editor:listToolStyles`. Crop is a bus verb. Paste image's primitive is `layers:upsertRaster`.

### Integration Test Scenarios

1. **Phase 3 doctor + Phase 1 sticky tool state.** Open v1 capture, doctor migrates to v2, place an arrow with the red color the user selected previously, sticky tool stays in arrow mode. Tests: doctor runs, tool style preserved across migration, arrow IPC routes via `layers:upsert` (v2 path).

2. **Phase 4 smart blur + Phase 5 multi-image paste.** Paste an image, place a blur over part of it, drag the image. Blur should track the new pixels. Verify the entire chain: paste → raster layer insert → effect-layer-over-raster compose → reposition → re-compose with new sample-below.

3. **Phase 7 AI run + cross-layer undo.** AI places 4 arrows + 2 labels under one ai_run_id (group layer). User ⌘Z → all 6 disappear in one step. ⌘⇧Z → all 6 reappear. Per-layer ✕ on one of the 4 arrows during open AI turn → that arrow alone is rejected; group still exists.

4. **Phase 7 AI rate limit + per-tool-call retry.** AI run that sends a malformed payload mid-batch → bridge returns per-tool-call zod error → AI sees it + corrects + retries → succeeds. Rate-limit kicks in if AI tries to send > 30 corrected payloads in one turn.

5. **Phase 2 dual-mode + Library Focus open.** Open Library Focus on a v1 capture, EditToolbar uses overlays:*. Close Focus, capture is migrated by Phase 3 doctor, reopen Focus, EditToolbar now uses layers:*. Same component, different IPC, no errors.

6. **Phase 1 tool style + window restart persistence.** Set arrow color red in editor A, close editor, open editor B for a different capture, arrow color is still red (defaults persist via Settings).

7. **Multi-window edit isolation.** Open editor A with arrow=red selected. Open editor B for a different capture. In B, change arrow=green. In A, the active arrow color stays red (window-scoped active state). Closing both and reopening A: A's defaults are now green (settings persisted the most recent change).

8. **Cross-instance clipboard fragment excludes chat.** Open capture A in PwrSnap instance 1, have AI chat history. Copy a layer fragment. Paste into PwrSnap instance 2 → fragment has no chat content; layers materialize correctly.

## Acceptance Criteria

### Functional Requirements

- [ ] **R1 (carries from origin):** Editor opens and exits exactly as today; all 7 toolbar tools (pointer/arrow/rect/blur/highlight/text/crop) work.
- [ ] **R2 (carries from origin):** Every tool produces a layer (v2) or overlay (v1); user-facing behavior identical.
- [ ] **R3 (carries from origin):** Blur tool produces v2 effect layer (Phase 4); dragging blur tracks pixels beneath.
- [ ] **R4 (carries from origin):** Paste (⌘V) and Finder drag create raster layers on v2 captures (Phase 5+).
- [ ] **R5 (carries from origin, modified):** Right-edge activity bar surfaces 3 panels (Info / Chat / Tool Config — Layers removed per user feedback) + Help. Hover/pin/safe-triangle works.
- [ ] **R6 (carries from origin, EXPANDED):** `layers:*` IPC contract is the documented AI primitive surface. Expanded with `layers:upsertBatch`, `layers:upsertRaster`, `layers:atPoint`, `layers:bbox`, `layers:undo`, `layers:redo`, `document:crop`, `editor:listToolStyles`, `render:composite`. AI-produced layers carry `source: "codex"`.
- [ ] **R6.1 (carries from origin):** Chat with AI panel (Phase 7) is live; AI requests produce layers that appear in the editor.
- [ ] **R7 (carries from origin):** Transform handles work on any selected layer kind.
- [ ] **R8 (carries from origin):** Cross-instance clipboard fidelity invisible to users; chat.json NOT carried in clipboard fragments.
- [ ] **R9 (carries from origin):** v1 editor codepath retires (Phase 8) after Phase 6 soaks ≥4 weeks with zero reported regressions.
- [ ] **R10 (carries from origin):** v1→v2 migration lazy, per-capture, on first edit-open (Phase 3); atomic ordering; reconcile-on-boot heals partial crashes.
- [ ] **R11 (carries from origin):** Persistence + repack model carries forward unchanged.
- [ ] **R12 (carries from origin):** Undo/redo extends to every annotator-class action; AI runs collapse to one undo step (per Alt 5).
- [ ] **R13 (carries from origin):** Default flag-flip ships in Phase 6 (now moved before Phase 4-5).
- [ ] **NEW — Tool dropdowns:** Inline color picker + style options for arrow/text/rect/blur/highlight via unified `ToolStylePopover`.
- [ ] **NEW — Sticky tool mode + style memory:** Per-tool style memory; COLOR slot shared across tools; styles persist as defaults via Settings; active state window-scoped.
- [ ] **NEW — Matching-text affordance:** "+ Add label" appears after placing an arrow; click → text mode with arrow color; place text → return to arrow mode.
- [ ] **NEW — Crop tool:** Toolbar tool; commits a new canvas dimension; existing annotations stay at absolute positions.
- [ ] **NEW — Layers panel REMOVED** from R5; activity bar = 4 tabs (Info / Chat / Tool Config / Help).
- [ ] **NEW — Color tokens:** `--swatch-*` added to `tokens.css`; stoplight semantics consistent across all tool style popovers.
- [ ] **NEW — Stoplight coachmark:** First-popover-open shows 3s coachmark explaining stoplight palette; tracked via `settings.editor.coachmarks.stoplightSeen`.
- [ ] **NEW — Migration:status verb:** Toolbar disabled during doctor run; re-enables on cached "complete" snapshot.
- [ ] **NEW — Doctor migration mapping:** v1 overlay → v2 layer field mapping table; coords multiplied by source dims; blur converted to sample-below effect.
- [ ] **NEW — Doctor crash recovery:** Boot-time `reconcileV1ToV2OnBoot()` sweep heals partial failures; orphan temp files cleaned.
- [ ] **NEW — AI primitive shim:** Phase 7 tool surface is `layers:*` verbatim + `list_layer_capabilities`, NOT workflow wrappers.
- [ ] **NEW — AI sees composite + style preferences:** `render:composite` returns 1440px-downsampled PNG; AI session context includes user's stoplight preferences.
- [ ] **NEW — AI per-layer reject + whole-run undo:** ✕ badges during open AI turn; ⌘Z reverts whole run.
- [ ] **NEW — AI rate limits:** 30 ops/turn, 5 turns/min, ≥N confirm-batch.
- [ ] **NEW — Chat history excluded from clipboard fragments** + Settings toggle for export inclusion.
- [ ] **NEW — Phase 5 security gate:** `assertSafePastedFile` for Finder drops; same 5-defense pipeline as clipboard:pasteLayerFragment.

### Non-Functional Requirements

- [ ] **Performance — Phase 4 smart blur drag:** CSS backdrop-filter preview maintains 60fps; composeV2 commit at pointerup < 200ms p95 for typical (1080p) source. **Measured by `editor-smart-blur-perf.spec.ts`.**
- [ ] **Performance — Phase 5 paste:** End-to-end ⌘V → raster layer visible < 300ms for ≤5MB image; < 600ms for ≤25MB. Sharp + sha256 off-main-thread. **Measured by `editor-paste-perf.spec.ts`.**
- [ ] **Performance — Phase 7 AI broadcasts:** Maximum 2 broadcasts per AI turn (one for in-progress group create, one for batch commit) regardless of layer count. **Measured by counter in `chat-handlers.test.ts`.**
- [ ] **Performance — Phase 1 Settings writes:** Max 1 broadcast per 500ms window for swatch-click bursts.
- [ ] **Performance — Activity bar pop-out:** Time-to-first-paint per panel < 50ms; any panel dispatching IPC on mount is a violation.
- [ ] **Performance — Phase 3 doctor:** p50 < 80ms, p95 < 200ms, p99 < 500ms by capture-size bucket.
- [ ] **Performance — Compose cache hit rate during edit sessions:** ≥ 95% (per `renderHashTree`).
- [ ] **Migration safety:** Phase 3 doctor atomic-or-revert; boot-time reconcile heals partial crashes.
- [ ] **Backward compat:** v1 captures continue to render in library, float-over, tray. Doctor migration idempotent.
- [ ] **Security — Phase 5:** All 5 defenses from `clipboard:pasteLayerFragment` replicated; symlink/privileged-dir reject for Finder drops.
- [ ] **Security — Phase 7:** Per-turn op cap (30); per-session rate limit (5 turns/min); confirm-batch ≥N writes; AI markdown rendered as text never HTML; chat excluded from cross-instance fragments.
- [ ] **Accessibility:** All new buttons + popovers have `aria-label`s; sidebar respects `prefers-reduced-motion`; focus rings visible on dark theme; min target size 24×24 (WCAG 2.5.5); arrow keys move within swatch radiogroup; Escape closes popovers + hover-popped panels.
- [ ] **Privacy:** Chat history defaults to NOT included in exports; AI screenshot context downsampled to 1440px longest edge before send.

### Quality Gates

- [ ] All new code has hook-level unit tests + integration-level E2E specs per phase
- [ ] `pnpm -r typecheck` clean across workspace
- [ ] `pnpm test` 100% pass
- [ ] `pnpm exec playwright test` (desktop) all green on macOS local + Linux CI
- [ ] `pnpm licenses:check` clean
- [ ] `pnpm exec eslint` clean
- [ ] Phase 1 separately shippable as a v1-editor refresh PR
- [ ] Phase 7 separately shippable as its own follow-up PR if scope pressure surfaces
- [ ] Design implementation matches `design/PwrSnap Editor.html` mockups within ±10% on layout dimensions
- [ ] AGENTS.md updated for new load-bearing patterns

## Success Metrics

- **User-visible Phase 1 wins (measurable):**
  - Time to place arrow + matching text drops from ~6 clicks to ~3 clicks
  - % of annotations placed with stoplight colors (red/yellow/green) — proxy for new color picker adoption
  - Sticky tool mode adoption: % of annotation sessions with ≥3 same-tool placements in a row
- **Phase 4 smart blur adoption:** % of blurs repositioned after placement (proves sample-below behavior is leveraged)
- **Phase 5 multi-image:** count of `editor:pasteImageAsLayer` dispatches per active user per week
- **Phase 6 default flip:** zero new editor-error reports vs prior 30-day baseline; doctor success rate ≥99% on real user libraries
- **Phase 7 AI usage:** % of captures with at least one `source: "codex"` layer
- **Phase 7 AI quality:** AI run acceptance rate (1 - reject rate); time-to-first-AI-suggestion after `chat:send`

## Dependencies & Prerequisites

- **PR #14 (v2 bundle storage) — merged ✅**
- **PR #46 (storage cache controls) — merged ✅** (Phase 3 reuses `migrateLegacyCaptureSources` infrastructure)
- **PR #48 (paste clipboard images into library) — merged ✅** (Phase 5 reuses clipboard-image-buffer pipeline)
- **Design mockups landed at commit 46c6545 — ✅**
- **Codex App Server protocol package for Phase 7** — verify `pnpm codex:generate-protocol` regenerates against installed Codex Desktop binary at Phase 7 kickoff

## Risk Analysis & Mitigation

| Risk | Likelihood | Blast radius | Mitigation |
|---|---|---|---|
| Phase 1 ships with subtle regression on Library Focus EditToolbar | Medium | All Library users editing inline | Touch both editors in lockstep; E2E coverage both surfaces |
| Phase 3 doctor partial crash leaves user data in inconsistent state | Low | Single capture | Atomic ordering + boot-time reconcile sweep |
| Phase 3 doctor fails on a malformed v1 bundle in the wild | Low | Single capture | Per-capture retry budget (5 attempts) + view-only fallback |
| Phase 4 smart blur drag is too slow at 4K | Medium | Editor feels janky | CSS backdrop-filter preview + composeV2 commit at pointerup |
| Phase 5 multi-image paste leaks source-bytes if user undoes | Low | Bundle bloat | Repack sweep prunes orphan sources; test |
| Phase 5 symlink/path-traversal via Finder drop | Low (with mitigation) | Privacy leak | `assertSafePastedFile`; E2E with malicious fixtures |
| Phase 6 flag flip exposes hidden v2 codepath bug | Medium | All new captures starting that release | Phase 5.5 dual-write window for rollback; manual user-report watch (no telemetry) |
| Phase 7 AI tool surface is wrong shape — wrappers vs primitives | Mitigated | AI capability stalls | Primitive shim + `list_layer_capabilities` per agent-native review |
| Phase 7 AI run thrashes renderer with N broadcasts | Mitigated | UI flicker | `layers:upsertBatch` (one broadcast per run) |
| Phase 7 Codex compromise → unbounded layer writes | Low | User data corruption | Rate limit + op cap + confirm-batch + zod re-validation |
| Phase 7 AI markdown XSS via prompt injection | Low | Renderer exploit | Render AI markdown as text never HTML |
| Phase 7 chat content leaks via clipboard fragments | Low | Privacy leak | Chat excluded from `copyLayerFragment` payload by default |
| Phase 8 cleanup deletes overlays code old build depends on | Low | Old packaged builds break | Bundle backward-compat per-bundle; refuse-to-migrate guard in SQL |
| Recurring rebase tax with main | High | Wall-clock | Ship Phase 1 ASAP; rebase tax compounds on long-running branches |
| User wants single-shot mode (NOT sticky) | Medium | UX papercut | ⌥-click escape: single-shot mode (legacy behavior) |
| Multi-window tool state stomp | Mitigated | Active state surprise | Window-scoped active; settings holds defaults only |
| Doctor coordinate transform is wrong (normalized vs absolute) | Mitigated | All migrated v1 annotations sub-pixel cluster | Unit test round-trip; explicit mapping table |
| Doctor blur conversion ambiguity | Mitigated | Visual regression on migrated v1 captures with blurs | Picked: convert to sample-below; document user-visible implication |
| Settings file corruption silently resets tool styles | Mitigated | UX papercut + lost user prefs | One-time toast on `SettingsCorruptionDetected` substrate event |

## Resource Requirements

- **Team:** 1 senior engineer (familiar with PR #14)
- **Time (revised after deepening):**
  - Phase 1: 12-16h
  - Phase 2: 6-8h
  - Phase 3: 10-14h (up from 6-8h: coordinate transform + atomicity + reconcile sweep + mapping table)
  - Phase 6: 3-4h (up from 2-3h: includes Phase 5.5 dual-write sidecar)
  - Phase 4: 10-14h (up from 8-10h: CSS preview architecture + perf E2E)
  - Phase 5: 8-10h (up from 5-7h: worker thread + security gates)
  - Phase 7: 26-40h (up from 20-30h: 6 agent-native gaps + security gates + per-layer reject UI)
  - Phase 8: 10-14h (up from 4-6h: one-shot upgrade job + refuse-to-migrate gate + soak-period verification)
- **Total:** ~85-120h (vs first-cut ~63-87h). Phase 1 still shippable in a week sprint.
- **Infrastructure:** Existing PwrSnap dev rig
- **AI services:** Codex App Server for Phase 7 (user's existing subscription)

## Future Considerations

After Phase 8, deferred v2 features in the bundle format's scope become unblocked:
- **Brush engine** — entire feature area, separate plan
- **Mask editing UI** — entire feature area
- **Real text tool** (typography, fonts) — entire feature area
- **Free transform** (skew, perspective) — extend transform handles
- **Canvas resize** (beyond Crop) — Phase 9 candidate
- **Multi-select transform** — needs selection model upgrade
- **Layer lock** — trivial after Phase 8; gate by user request
- **Effect rasterization** ("freeze this blur") — schema slot reserved (`layers:rasterize`)
- **PSD / Affinity import-export** — external interop; complex
- **Smart objects / linked external sources** — schema slot reserved
- **Group / ungroup as user-facing operation** — AI uses groups internally; surface to users if requested
- **Telemetry substrate** — pre-Phase-6 nice-to-have; deferred since manual user-report watch suffices for first rollout
- **Layers panel** — re-add if usage signals demand
- **MCP transport for `layers:*`** — bus is already transport-agnostic; expose layer surface to external MCP clients

## Documentation Plan

- **AGENTS.md** — add "v2 editor — tool-state persistence" section (window-scoped active + Settings defaults; commit-on-beforeunload; popover-measurement reuse)
- **AGENTS.md** — update "Bundle format v2 — experimental, opt-in" to reflect Phase 6 default-flip
- **AGENTS.md** — add "AI tool surface — primitives over workflows" note (Phase 7 architectural commitment)
- **docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md** — update "Shipping Status" to "v2 is the default; v1 codepath retired in Phase 8"
- **README** — section on the editor's tool style memory + sticky mode (consumer-facing)
- **THIRD_PARTY_LICENSES** — re-run if any new transitive deps land in Phase 7

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-05-19-v2-layer-editor-requirements.md](../brainstorms/2026-05-19-v2-layer-editor-requirements.md) — key decisions carried forward:
  1. Annotator-first, not editor-first
  2. Smart blur is the marquee user-visible v2 capability
  3. AI primitives are the marquee programmatic v2 capability via `layers:*` IPC
  4. Right-edge activity bar pattern (MODIFIED: Layers panel removed per user feedback)
  5. Lazy v1→v2 doctor on first edit-open
  6. Persistence + repack model carries forward unchanged
  7. Default flag-flip conditional on phases landing (REORDERED: flip moves before v2-only features)

### Internal References

- v2 bundle format plan: [docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md](2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md)
- Existing editor: [apps/desktop/src/renderer/src/features/editor/Editor.tsx](../../apps/desktop/src/renderer/src/features/editor/Editor.tsx)
- Existing editor toolbar: [apps/desktop/src/renderer/src/features/editor/editor-tools.tsx](../../apps/desktop/src/renderer/src/features/editor/editor-tools.tsx)
- Library Focus EditToolbar: [apps/desktop/src/renderer/src/features/library/EditToolbar.tsx](../../apps/desktop/src/renderer/src/features/library/EditToolbar.tsx)
- v1 overlay schema (normalized coords confirmed): [packages/shared/src/overlay-schemas.ts:8-23](../../packages/shared/src/overlay-schemas.ts:8-23)
- v1 overlays migration: [apps/desktop/src/main/persistence/migrations/0002_overlays.sql:20](../../apps/desktop/src/main/persistence/migrations/0002_overlays.sql:20)
- Layers IPC handlers: [apps/desktop/src/main/handlers/layers-handlers.ts](../../apps/desktop/src/main/handlers/layers-handlers.ts)
- Layers repo: [apps/desktop/src/main/persistence/layers-repo.ts](../../apps/desktop/src/main/persistence/layers-repo.ts)
- Feature flags: [apps/desktop/src/main/feature-flags.ts](../../apps/desktop/src/main/feature-flags.ts)
- Bundle-store dual-read: [apps/desktop/src/main/persistence/bundle-store.ts](../../apps/desktop/src/main/persistence/bundle-store.ts) (lines 1036, 1060)
- Render coordinator dual-dispatch: [apps/desktop/src/main/render/coordinator.ts:83](../../apps/desktop/src/main/render/coordinator.ts:83)
- Settings substrate: [apps/desktop/src/main/settings/desktop-settings-service.ts](../../apps/desktop/src/main/settings/desktop-settings-service.ts)
- Legacy bundle migration (Phase 3 cached-snapshot reference): [apps/desktop/src/main/persistence/legacy-bundle-migration.ts](../../apps/desktop/src/main/persistence/legacy-bundle-migration.ts) lines 261-277
- BlurMenu popover pattern: [apps/desktop/src/renderer/src/features/editor/BlurMenu.tsx](../../apps/desktop/src/renderer/src/features/editor/BlurMenu.tsx)
- ZoomMenu popover pattern: [apps/desktop/src/renderer/src/features/editor/ZoomMenu.tsx](../../apps/desktop/src/renderer/src/features/editor/ZoomMenu.tsx)
- DetailRail sidebar pattern: [apps/desktop/src/renderer/src/features/library/DetailRail.tsx](../../apps/desktop/src/renderer/src/features/library/DetailRail.tsx)
- Settings sidebar pattern: [apps/desktop/src/renderer/src/features/settings/SettingsApp.tsx](../../apps/desktop/src/renderer/src/features/settings/SettingsApp.tsx)
- Cancel-safety reference: [apps/desktop/src/renderer/src/features/editor/Editor.tsx:148-159](../../apps/desktop/src/renderer/src/features/editor/Editor.tsx:148-159)
- Color tokens: [apps/desktop/src/renderer/src/styles/tokens.css](../../apps/desktop/src/renderer/src/styles/tokens.css)
- Clipboard 5-defense paste pattern: [apps/desktop/src/main/handlers/clipboard-handlers.ts](../../apps/desktop/src/main/handlers/clipboard-handlers.ts) lines 255-410
- Safe-file pattern: [apps/desktop/src/main/persistence/bundle-store.ts:123](../../apps/desktop/src/main/persistence/bundle-store.ts:123) (`assertSafeBundleFile`)
- v2 path validator: [packages/shared/src/bundle-manifest-schema-v2.ts:258](../../packages/shared/src/bundle-manifest-schema-v2.ts:258) (`validateBundleZipEntryNamesV2`)
- Codex App Server protocol: [packages/codex-app-server-protocol/](../../packages/codex-app-server-protocol/)
- Design assets: `design/PwrSnap Editor.html`, `design/src/Editor.jsx`, `design/src/EditorPanels.jsx`, `design/src/editor.css` (committed at 46c6545)

### External References

- NN/g hover timing: https://www.nngroup.com/articles/timing-exposing-content/
- Baymard hover-delay guidelines: https://baymard.com/blog/dropdown-menu-flickering-issue
- Excalidraw per-tool style memory PR (2025): https://github.com/excalidraw/excalidraw/pull/10743
- Excalidraw color picker redesign: https://github.com/excalidraw/excalidraw/issues/5931
- Mobbin sidebar UI patterns: https://mobbin.com/glossary/sidebar
- Figma color picker docs: https://help.figma.com/hc/en-us/articles/360041003774-Update-fills-using-the-color-picker

### Load-bearing AGENTS.md sections referenced

- "BrowserWindow sizing — `setMinimumSize(0, 0)` after construction"
- "Tray + float-over popover sizing — outer `inline-block` measurer"
- "Settings substrate — every setting + secret goes through one place"
- "Single command bus" (future MCP transport gets `layers:*` for free)

### Related Work

- PR #14: `feat(desktop): bundle storage v1 + experimental v2 layer-tree (opt-in)`
- PR #46: `feat(desktop): add storage cache controls`
- PR #48: `feat(desktop): paste clipboard images into library`
- Library three-state plan (cancel-safety reference): [docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md](2026-05-05-001-feat-library-three-state-view-model-plan.md)
- Settings substrate plan: [docs/plans/2026-05-12-001-feat-settings-substrate-and-design-catchup-plan.md](2026-05-12-001-feat-settings-substrate-and-design-catchup-plan.md)
- v2 bundle format plan: [docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md](2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md)
