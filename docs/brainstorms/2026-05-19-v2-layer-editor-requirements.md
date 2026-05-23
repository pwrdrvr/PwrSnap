---
date: 2026-05-19
topic: v2-layer-editor
---

# v2 Layer Editor

## Problem Frame

PwrSnap's primary job is **fast screenshot annotation by humans, with AI as a first-class second user of the same primitives.** The v1 editor delivers that today through a simple toolbar (arrow, text, rect, blur, highlight, undo/redo). A user takes a screenshot, places an annotation, and is done in seconds — no concept of layers, no panels, no scope creep into image editing.

The v2 bundle format ([docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md](../plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md)) shipped a layer-tree data model that's strictly richer than v1's flat overlay array. That richness unlocks two things the user values:

1. **AI primitives.** A structured layer model gives Codex App Server something coherent to reason about. AI can say "add an arrow from (x1,y1) pointing at the Submit button" or "blur the credit-card field" and produce annotations that show up in the same layer model the user manipulates. AI annotations and user annotations are indistinguishable in behavior; only their `source` field tracks origin.
2. **Smart annotations.** The most valuable v1 → v2 capability for *annotators* (not image editors) is the **contextual blur**: drag the blurred region and it follows what's below it. Today's static blur bakes its pixels at draw time; v2's effect layer re-samples on every render. The user thinks "blur," not "effect layer."

The trap to avoid: the v2 bundle plan's richness ALSO unlocks Photoshop-class capabilities (multi-image canvas, layer panels, group/ungroup, free transform, masks, brushes). Building all of that as the v2 editor's first surface would overwhelm a first-time user and miss the point. PwrSnap stays an annotator; the layer model is plumbing.

The right framing: **the editor LOOKS like v1 on day one. The layer model exists underneath. Progressive disclosure surfaces deeper capability when a user genuinely needs it. AI uses the full primitive set from day one because that's where the structured-data win lives.**

## Requirements

- **R1.** **Day-one parity with v1's annotation surface.** Every v1 tool keeps working with the same muscle memory: arrow, text, rect, blur, highlight, undo/redo, drag-to-move, click-to-edit. The toolbar, default canvas behavior, and "place → edit → done" loop match v1. A user opening a v2 capture for the first time can't tell the data model changed.

- **R2.** **Every annotation tool produces a layer underneath.** The user doesn't see "layers"; they see arrows, text, blurs they've placed. Click a placed annotation → it selects → handles appear → drag / resize / delete works. Internally each tool maps to a layer kind:
  - Arrow / text / rect / shapes → vector layer (same as today's overlays, just stored in the new schema)
  - Blur tool → effect layer with **sample-below** semantics (NEW capability vs v1's static blur)
  - Highlight tool → effect layer with sample-below
  - Paste / drag-drop image → raster layer

- **R3.** **Smart blur and highlight.** The blur and highlight tools produce effect layers that re-render as the layers beneath them move. User-facing behavior: drag a blurred region and the blur visibly tracks what's now underneath. This is the v2 brainstorm's "blur over sensitive data → drag to right place" use case, and it's the most valuable v1 → v2 capability for annotators. The user never thinks "effect layer"; they think "the blur follows the thing I'm dragging because that's obviously what it should do."

- **R4.** **Multi-image is opportunistic, not a feature surface.** Users can paste an image with `⌘V` (reuses PR #48's clipboard-paste pipeline) or drag-drop an image file from Finder. Pasted/dropped images become raster layers; that's it. There is **no** dedicated "Add Image…" toolbar button, no "Import" menu item, no Library-to-editor drag. If a user pastes a screenshot of their terminal into a screenshot of their app, the canvas shows both — but the editor never markets itself as a multi-image canvas.

- **R5.** **Right-edge activity bar surfaces progressive-disclosure panels.** A thin icon strip lives on the right edge of the editor window (VS Code activity-bar pattern, mirrored to the right). The strip is always present but unobtrusive — icons only, no labels. Each icon activates one panel:
  - **Info (i)** — metadata about the open capture (source app, captured_at, dimensions, sha, tags, description). Replaces the current Library detail-rail content, scoped to the editor's open capture.
  - **Chat with AI** — conversational surface for AI annotation (see R6.1). User types "blur the credit-card field"; AI annotations appear as layers; user accepts / rejects / iterates.
  - **Layers** — the layer tree. Eye toggle, drag to reorder, rename, delete. Same surface deferred from the prior brainstorm; now lives behind this icon instead of a toolbar toggle.
  - **Style** — properties of the currently-selected tool or layer (color, thickness, opacity, blur radius, font size, etc.). Replaces inline-in-toolbar tool properties from v1 where it makes the property set unwieldy; simple properties may still live in the toolbar for ⌘-paint-fast use.

  Sidebar behavior:
  - **Collapsed by default.** Just the icon strip, ~36px wide. The icon strip is the only persistent right-edge chrome.
  - **Click icon → expand + pin.** Panel takes its space from the canvas (canvas resizes); panel stays open as the user works; selected panel is remembered per-window.
  - **Hover-while-collapsed → pop out as overlay.** Mouse over the icon strip; panel slides out as a floating overlay over the canvas (doesn't resize canvas). Auto-hides on mouse-out. Lets users glance without committing screen real estate.
  - **Explicit pin/unpin toggle** inside each panel. Pin = panel stays expanded after mouse-out (same as click-to-expand). Unpin = collapse back to icon strip on next mouse-out.
  - **Last-selected panel remembered** per-window so reopening the editor restores the user's preferred layout.

  This is the progressive-disclosure surface. New users see a tiny icon strip and can ignore it. Returning users discover Info / Chat / Layers / Style at their own pace. AI usage is one click away — discoverable without being in-your-face.

- **R6.** **AI primitives are a first-class IPC surface (programmatic contract).** The layer-tree IPC verbs (`layers:list`, `layers:upsert`, `layers:reparent`, `layers:reorder`, `layers:delete`) become the documented contract for AI annotation. Codex App Server uses the same verbs the renderer uses; AI-produced annotations carry `source: "codex"` (already in the schema) and an `ai_run_id` so users can review/accept/reject in batches. Coordinate inputs are absolute canvas pixels (R3 of v2 bundle brainstorm) so AI can reason about position without normalization math. The set of primitives AI can compose:
  - Add a vector layer (arrow, rect, text, shape) with absolute coords + style
  - Add an effect layer (blur, highlight) over a region
  - Add a raster layer from a source sha (e.g., a generated diagram, a fetched image)
  - Read the layer tree (so AI can see what the user has placed and reason about it)
  - Edit / reject / restore layers (so AI can iterate on its own suggestions)

- **R6.1.** **Chat with AI is the user-facing surface for R6's primitives.** Lives in the right-sidebar Chat panel (R5). User types a request ("blur the credit-card field," "draw an arrow pointing at the Submit button," "label these three buttons"); the conversation goes to Codex App Server with the current capture's screenshot + layer-tree as context; AI responds with annotations that materialize as layers in the editor. The chat surface is also where AI replies to clarifying questions, reports what it changed ("I added two arrows and a label"), and offers undo on its own suggestions. Chat history is per-capture and persists with the bundle (carried in the bundle alongside the layer tree, similar to how tags and description already are). v1 captures with chat history migrate forward; chat history is not retroactive (v1 captures opened in v2 start with empty chat).

- **R7.** **Transform handles work on whatever layer is selected.** Same model as v1 today (click an overlay → handles appear → drag to move, drag corner to resize). Generalized: a selected raster, vector, or effect layer all show the same 8-handle bounding box. Multi-select (cmd-click) is **out of scope** for MVP — defer to progressive-disclosure follow-up.

- **R8.** **Cross-instance clipboard fidelity stays invisible.** The private-UTI layer fragment work already shipped — copy a layered selection in PwrSnap A, paste in PwrSnap B, get the full tree back. Users don't need to know this exists; it Just Works. Non-PwrSnap consumers still get the PNG composite via the standard fallback.

- **R9.** **The v1 editor codepath is retired.** The existing Editor BrowserWindow (opened by `editor:open`) gets rebuilt as the v2 editor. There is one editor surface, not two. Inline Focus mode in the Library stays lightweight; it isn't the layer editor.

- **R10.** **v1→v2 migration is lazy, per-capture, on first editor open.** A v1 capture stays on disk as v1 until the user opens it for editing. First open triggers an in-place migration (read v1 bundle → build v2 layer tree from overlays + canvas dims = source dims → atomically swap on disk → open in editor). The user sees a brief "Upgrading…" indicator (<1s typical) but no consent prompt. Migration is idempotent + atomic; failure leaves the v1 bundle untouched and opens the capture in a view-only fallback with an error toast. Never-edited captures stay v1 indefinitely; the library grid keeps reading both formats via the existing dual-read path.

- **R11.** **Persistence + repack model carries forward from v1.** Every layer edit hits the DB immediately (insert/reject/restore + `edits_version` bump in one transaction). Bundle re-pack stays debounced. No Save button, no "unsaved changes" indicator, no save-state UI. Carried forward without change so users feel no behavioral difference at this seam.

- **R12.** **Undo/redo extends to every annotator-class action.** A user action is the unit of work, even when it maps to multiple internal layer ops. Examples: "place arrow" = one undo step (even though it inserts a vector layer + bumps edits_version + may auto-select). "Drag arrow" = one undo step (even with continuous transform updates). "Recolor arrow" = one undo step. "Paste image" = one undo step. AI-produced annotations from a single AI run collapse to one undo step ("Undo AI suggestion").

- **R13.** **Default flag-flip is conditional on R1–R12 landing.** Once the v2 editor reaches the bar above AND a packaged build has been smoke-tested for cross-instance clipboard AND the v1→v2 doctor handles real user data without loss, `isV2WriteEnabled()` flips to return `true` by default. From that release every new capture writes v2. The env var override survives as a debug knob.

## Success Criteria

- A new user installs PwrSnap, takes their first screenshot, opens the editor, places an arrow, types a label, and shares it — without ever noticing the data model changed from v1.
- An existing user with 400 v1 captures opens one of them, the migration runs invisibly in under a second, the editor opens, every annotation they previously placed is still there and still editable.
- A user adds a blur over a credit-card number in a screenshot. They notice the credit-card field is slightly off-position. They drag the blurred region; the blur tracks the new pixels underneath (proves R3 in the user's hand, not just in a test).
- A user pastes a second screenshot onto an open editor canvas. It lands as a positioned raster layer. They drag it, then close the editor, then reopen the next day — both images are in their last-positioned spots.
- A user hovers the right-edge icon strip for the first time after weeks of using the app. The Info panel pops out as an overlay; they see capture metadata, mouse away, it auto-hides. The next session they click the Layers icon, see what they've placed, reorder one annotation, click the pin button so the panel stays open — and the layout persists across reopening the editor.
- A user types "blur the credit-card field" into the Chat panel. AI reads the screenshot, places a blur effect over the right region, and the user sees both the chat reply ("I added a blur over the credit-card field") and the layer in the canvas. If the position is slightly off, the user drags it to the right spot — the blur tracks the underlying pixels because R3 makes that work. If they don't like it at all, undo removes it.
- Codex App Server, given a screenshot of a UI and a prompt like "circle the Submit button and add a label 'Click here'," produces two layers that show up in the editor exactly as if the user had drawn them. The user can click either one and edit it.
- A user copies a layered selection in PwrSnap A and pastes into PwrSnap B; every annotation including effects and source bytes arrives intact.
- The v2 default flag flips and there's no user-visible regression vs v1 behavior; the new capabilities (smart blur, paste-image, layer panel) are present but discoverable rather than in-your-face.

## Scope Boundaries

- **Out of scope:** Brush engine (raster painting with pressure/bristles, color picker, brush sizes). v1 doesn't have it; v2.0 doesn't add it.
- **Out of scope:** Mask editing UI. Mask layers were dropped from the v2 data model entirely in the original v2 brainstorm.
- **Out of scope:** Real text tool (typography controls, font selector, kerning, character panel). v1's basic text overlay carries forward unchanged.
- **Out of scope:** Free transform (skew, perspective, distort). Translate + uniform scale + rotation only. Multi-select transform also out of MVP.
- **Out of scope:** Crop / canvas resize. Canvas dimensions are set at capture time.
- **Out of scope:** Group / ungroup as a user-facing operation. The data layer supports `group` nodes; the editor doesn't expose them in MVP. AI can use groups internally to organize multi-layer annotations; users only see flat layer lists in the layer panel.
- **Out of scope:** Layer lock. v1 doesn't have it; if a user accidentally moves something, undo fixes it.
- **Out of scope:** Effect rasterization ("freeze this blur into static pixels"). Photoshop-class; defer until a user actually asks. The data layer reserves the slot via `layers:rasterize`.
- **Out of scope:** Drag from PwrSnap Library into editor. Power-user feature; defer to v2.1 if usage signals demand.
- **Out of scope:** Explicit "Add Image…" toolbar button. Paste and Finder drag are sufficient; adding a button signals "this is a multi-image canvas" which we explicitly don't want to lead with.
- **Out of scope:** Linked external sources / smart objects. Schema reserves `source_ref.kind === "linked"`; v2.0 ships embedded-only.
- **Out of scope:** Eager v1→v2 background sweep. Lazy on-open only.
- **Out of scope:** PSD / Affinity / Sketch import-export.
- **Out of scope:** Brush-class blend modes (hue/saturation/color/luminosity). Sharp's native set ships.

## Key Decisions

- **Annotator-first, not editor-first.** The v2 layer model is plumbing for AI primitives + smart effects, not a feature surface. The editor LOOKS like v1 on day one; deeper capability discovers itself when the user explores.
- **Smart blur is the marquee user-visible v2 capability.** Of the v2 plan's three new user-facing capabilities (multi-image, contextual effects, cross-instance fidelity), the contextual blur-follows-thing is the one annotators directly value. Multi-image is opportunistic; cross-instance is invisible.
- **AI primitives are the marquee programmatic v2 capability.** The structured layer model exists primarily so Codex App Server can compose annotations. The same IPC the renderer uses is the AI contract; no separate AI-only API.
- **Layer panel hidden behind toolbar toggle.** Progressive disclosure without abandoning discoverability. State persists per-window.
- **Cut everything that signals "this is a layer editor":** the Add Image button, Library-drag, group/ungroup, lock, multi-select, rasterize-effect, mask UI. All deferred or cut. Each was tempting; each would push us toward Photoshop and away from annotator.
- **Rebuild the existing Editor window rather than open a second one.** One editor surface; the v1 codepath retires.
- **Lazy on-open migration, not eager sweep.** Disk churn spreads over user activity; never-edited captures stay v1 indefinitely.
- **Persistence model carries forward from v1.** No Save button; debounced bundle re-pack stays a background concern.
- **Default-flip is conditional, not calendared.** Flips after R1–R12 ship, cross-instance smoke-tested, doctor proven on real user data.

## Dependencies / Assumptions

- The v2 bundle PR (#14) has merged and is in production.
- The v1→v2 doctor implementation (deferred from the v2 bundle plan) lands as part of this work, gated by R10.
- The existing layer-tree IPC (`layers:list`, `layers:upsert`, `layers:reparent`, `layers:reorder`, `layers:delete`, `layers:rasterize`) is the contract both the editor AND AI consume. New IPC verbs may be needed for: image import via clipboard/drag, AI-run grouping, undo/redo coordination across multi-layer ops.
- Phase 6 E2E specs from the v2 bundle plan (`bundle-v2-roundtrip.spec.ts`, `clipboard-layer-fragment.spec.ts`) move from "deferred" to "must ship with this editor."
- Codex App Server protocol can address the layer-tree IPC verbs as MCP-style tool calls. If the existing protocol can't, that integration shape needs definition in planning.
- Design mockups for the editor surface (default toolbar state, layer panel layout when revealed, migration indicator, smart-blur tracking feedback, paste-an-image feedback) are an explicit input to planning. The user has offered to drive design via Claude Design.

## Outstanding Questions

### Resolve Before Planning

*(empty — every product decision needed before mockups is captured. The questions below are all `Deferred to Planning` because they're best answered with mockups in hand OR require Codex App Server protocol research.)*

### Deferred to Planning

- **[Affects R1, R5][UX]** Toolbar layout: does the new "Show Layers" toggle live to the right of the existing tools, in a separate utility cluster, or in a hamburger overflow? Resolved by mockups.
- **[Affects R3][UX]** Smart-blur visual feedback: when the user drags a blurred region and the blur re-samples what's now underneath, do we show a brief shimmer, a subtle outline, or nothing (the pixels are their own feedback)? Resolved by mockups.
- **[Affects R5][UX]** Layer panel detail level when revealed: just a list with eye/name/delete, OR thumbnails + grouping + filter-by-source ("hide all AI annotations"). Mockups answer.
- **[Affects R7][UX]** Transform handle styling: copy v1 exactly, or refresh as part of the v2 work? Mockups.
- **[Affects R10][UX]** Migration "Upgrading…" indicator placement: inline inside the opening window, toast in the library, brief modal? Mockups.
- **[Affects R4][UX]** Paste/drop affordance: when a user drops an image on the canvas, do we briefly highlight the drop region, animate the layer in, snap to a sensible default position (centered? at drop point? smart-aligned to existing layers?)? Mockups.
- **[Affects R6][Needs research]** AI primitives surface: does the existing Codex App Server protocol support MCP-style tool calls that target the `layers:*` IPC, or does this require a wrapper layer in main? Likely a wrapper that translates AI tool calls into bus dispatches.
- **[Affects R6][UX]** AI annotation review flow: when AI produces a batch of annotations (say, three arrows + a label), how does the user see them — appear instantly with an "Accept / Reject all" affordance, or land in a "pending" state that needs explicit accept-each, or just appear and rely on undo? Mockups + product call.
- **[Affects R6][Technical]** AI grouping: does AI use the `group` layer kind to bundle a multi-layer suggestion under one node (so "Undo AI suggestion" = reject the parent group)? Likely yes; confirm at planning.
- **[Affects R12][Technical]** Undo coalescing: continuous transforms (drag a layer = N transform writes) need to collapse to one undo step. Implementation approach: timestamp-based coalescing window, mouse-up boundary, explicit `beginEditSession`/`endEditSession` IPC. Pick at planning.
- **[Affects R11][Needs research]** Repack debounce tuning under continuous transform: original v2 brainstorm specced 5s steady / 30s iCloud. Drag-a-layer-around generates continuous edits; the right value is likely "on mouse-up + 5s idle" rather than "every 5s." Validate against real interaction.
- **[Affects R10][Technical]** v1→v2 doctor failure UI: when the per-capture migration fails, the spec is "view-only fallback + error toast." Define what the view-only mode actually shows and what recovery actions surface (retry, skip, report).
- **[Affects R3, R5][Technical]** "The user thinks 'blur,' not 'effect layer'" — confirm the layer panel surfaces effect layers with friendly names ("Blur," "Highlight") rather than internal jargon. AI-produced layers may want richer names ("Blur — credit card field").

- **[Affects R5][UX]** Icon strip width + iconography: 36px is a starting guess; final width depends on icon size + spacing chosen in mockups. Icons themselves need design (Info — circled i is the obvious one; Chat — speech bubble; Layers — stacked rectangles; Style — paint/brush/sliders?).

- **[Affects R5][UX]** Sidebar panel width: fixed (e.g. 280px when expanded), user-resizable via drag-handle, or content-driven? Photoshop is fixed; Figma is fixed-with-collapse; VS Code is user-resizable. Mockups answer.

- **[Affects R5][UX]** Hover-pop-out timing: how long does the user have to hover the icon strip before the overlay appears? Too fast = accidental triggers when reaching for the close button or scrollbar; too slow = feels sluggish. ~150-300ms typical for similar UIs.

- **[Affects R5][UX]** Pop-out auto-hide trigger: mouse-out from the panel, OR explicit close button, OR escape key, OR all of the above? Lightweight is better — annoyingly sticky is worse than annoyingly transient for a hover surface.

- **[Affects R6.1][Technical]** Chat history persistence: lives inside the v2 bundle (alongside tags + description in the same way) so it travels with the capture (export, clipboard fragment, library backup). Confirm the bundle schema can accommodate without a v3 format bump.

- **[Affects R6.1][UX]** Chat-driven annotation review flow: when AI replies with "I added two arrows and a label," do the layers appear instantly (and user can undo or modify), or land in a "pending approval" state (and user must explicitly accept)? Probably instant-with-undo for fast iteration; review-first feels too gated for an annotator. Resolve with mockups.

- **[Affects R6.1][Needs research]** Chat context payload: how much does AI need to see — just the capture's flat PNG, or the layer tree too, or both? Probably both (image for visual reasoning, layer tree for "what's already annotated and what isn't"). Confirm with Codex App Server protocol limits at planning.

- **[Affects R5][UX]** Style panel scope: which properties move from the v1-style inline toolbar into the Style panel, and which stay inline? Probably: simple/frequent stuff (color, thickness) stays inline; advanced/rarely-tweaked (opacity, blend mode, blur radius detail) goes to Style panel. Mockups draw the line.

## Next Steps

→ Hand requirements to Claude Design for editor surface mockups. Focus areas:
   1. **Default editor state** — should look ~indistinguishable from v1 today, plus the right-edge icon strip (4 icons: Info / Chat / Layers / Style)
   2. **Right-sidebar mechanics** — collapsed icon strip vs hover-pop-out overlay vs click-to-pin-expand; pin/unpin affordance inside each panel; remembered last-selected panel
   3. **Each of the four panels' layouts** — Info, Chat with AI, Layers, Style. Keep each minimal; support the annotator use case (not Photoshop)
   4. **Chat with AI flow** — message composition, AI reply rendering, "AI added 2 layers" surfaces with accept/reject/iterate affordances, conversation history per-capture
   5. **Smart-blur interaction** — what does it look like as the user drags a blurred region over a moving layer
   6. **Multi-image paste/drop feedback** — discoverable but not in-your-face
   7. **Migration "Upgrading…" indicator** — brief, non-modal
   8. **Style panel vs inline toolbar properties** — which properties live where (simple ones in toolbar for fast use, advanced ones in Style panel)
→ When mockups land, run `/ce:plan` with this brainstorm + mockups as joint inputs.
