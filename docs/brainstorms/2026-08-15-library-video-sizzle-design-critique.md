---
date: 2026-08-15
topic: library-video-sizzle-design-critique
status: critique + handoff briefs (no code changes in this doc)
---

# Design Critique: Library, Right Bar, Video, Grid, Sizzle Reels

Six surfaces reviewed against the 2026-08-15 screenshots (Grid / Focus / Video
viewer / Cart / Sizzle editor) **and the code that renders them**, so every
recommendation names the file it lands in. Each section ends with a
**handoff brief** sized for a fresh session (owner model, base branch,
scope, acceptance). Priorities and a suggested PR fan-out are at the end.

Line numbers reference `main` at `2ffe55f2` unless the section says otherwise.

---

## Overall impression

The Library shell is strong: black surfaces, tangerine accent, mono
eyebrows, day-banner grid, and a Cart that turns multi-select into a real
workflow. The gaps are all in the **second layer** — the state model behind
the sidebar, the affordances painted on top of tiles, the seams between the
right bar's sub-components, and two feature surfaces (Video, Sizzle) that
still expose their v1 data model to the user. None of it needs a redesign of
the shell. Items 1–3 and 5 are correctness-of-model + polish PRs; items 4
and 6 are genuine feature work and are the only two that merit Claude Design
mockups before code.

Legend: 🔴 blocks the user's goal · 🟡 slows / confuses · 🟢 polish

---

## 1. Left sidebar — two filter paradigms in one column

### What's actually there

- LIBRARY (All / Today / Trash) **and** SOURCE APP rows share one union:
  `ActiveLibraryFilter = all | today | trash | { sourceApp, appId }`
  ([Library.tsx:496–500](../../apps/desktop/src/renderer/src/features/library/Library.tsx#L496)).
  So Today and a source app are *mutually exclusive alternatives*, not
  composable facets — you cannot see "Activity Monitor, today".
- TYPES is a separate include-set `{ images, videos, projects }`
  ([Library.tsx:1117–1131](../../apps/desktop/src/renderer/src/features/library/Library.tsx#L1117));
  click = toggle, **shift-click = only** (undiscoverable), all three may be off
  (empty grid, no explanation).
- `selectFilter` never toggles ([Library.tsx:2016–2023](../../apps/desktop/src/renderer/src/features/library/Library.tsx#L2016)):
  clicking the active app re-sets the same filter, so it "does nothing".
- The backend filter is positive-only: `CaptureFilter` has
  `appBundleId | appBundleIds | includeDeleted`
  ([protocol.ts:353–358](../../packages/shared/src/protocol.ts#L353)); the
  repo emits only `=` / `IN` clauses. No exclude, no multi-app-with-negation.
- Today and Types are applied **client-side** after the fetch; source app is a
  separate `library:list` loop cached per app
  ([Library.tsx:1421–1498](../../apps/desktop/src/renderer/src/features/library/Library.tsx#L1421)).

### Findings

| Finding | Sev | Recommendation |
|---|---|---|
| Three sections look like one filter list but behave as radio (LIBRARY), checkbox (TYPES), and radio-that-can't-unselect (SOURCE APP). | 🔴 | Reframe explicitly: **LIBRARY = scope** (radio, always one), **TYPES + SOURCE APP = facets** (composable). Make the visual language match: scope rows get the current filled active row; facet rows get a leading state glyph (checkbox / minus) and *never* the "selected row" fill. |
| Clicking the active source app does nothing. | 🟡 | Click on the active single app → back to All (toggle). This is the universal expectation (Finder sidebar, Lightroom, Photos). |
| No way to say "everything except Electron (988)". | 🟡 | Add exclude: `⌥-click` on any facet row = exclude (row shows a `−` glyph + strikethrough label, count stays). Same gesture on TYPES. |
| No multi-app selection. | 🟡 | `⌘-click` = add/remove from selection. Rows in a multi-selection show a check glyph. Hover on any *non-selected* row while a selection exists reveals a small mono **only** pill (right of the count) that collapses the selection to that app — this is the "only on mouseover" idea and it's the right one; it should exist on TYPES rows too (replaces the hidden shift-click). |
| Tri-state **click cycling** (include → exclude → off) on a single click. | 🔴 if adopted | **Don't.** Cycle-on-click hides state behind an icon and makes the second click unpredictable; every mature filter UI (Lightroom, Linear, Finder smart folders, Photos) uses modifier + hover affordance for the rare negative and keeps plain click as "select". With three types, "not Videos" ≡ "Images + Projects" — negation on TYPES is derivable, so it can be a nicety via ⌥-click, not the primary path. |
| The composed filter is invisible — nothing tells you Today + Videos + not-Electron is what you're looking at. | 🟡 | Add a **filter chip row** under the day-banner header ("Today · Videos · not Electron ×"), each chip clearable, plus "Clear". This is the source of truth that makes multiple facets legible; without it, multi/negative filters are unsafe to ship. |
| Today can't combine with a source app; Trash bypasses TYPES silently. | 🟡 | Split the union: `scope: all \| today \| trash` + `sourceApps: { mode: include \| exclude, appIds }` + `types`. Trash keeps ignoring types (say so in the empty state). |
| All three TYPES off → empty grid, no message. | 🟢 | Guard: turning off the last type re-enables the others ("only" semantics) *or* show an empty state with "Show all types". |

### Recommended interaction spec (one screen)

```
LIBRARY (scope, radio)      click = select        (active row fill)
TYPES (facet, include-set)  click = toggle        ⌥-click = exclude   hover → [only]
SOURCE APP (facet)          click = only this app / click active = All
                            ⌘-click = add/remove   ⌥-click = exclude   hover → [only]
Chip row above grid         shows the composed filter; × per chip; Clear
```

State: `{ scope, types: Set, sourceApps: { mode, appIds } }`. Backend: add
`excludeAppBundleIds?: string[]` to `CaptureFilter` and a `NOT IN` clause in
`captures-repo.ts` (~L429–460); the per-app client cache in `Library.tsx`
already handles multi-bundle include lists.

### Handoff brief — **Opus 5**, new worktree, PR off `main`

- Scope: state split, toggle-off, ⌘/⌥ modifiers, hover **only** pill, chip
  row, `excludeAppBundleIds` in shared protocol + repo, tests for the
  reducer/`FILTER_CHANGED` and repo clause building.
- Non-goals: saved filters, tag/OCR facets, changing counts semantics.
- Acceptance: Today + one app + Videos composes; ⌥-click Electron hides 988
  and chip reads "not Electron"; clicking active app returns to All; grid
  never silently empties.
- Files: `Library.tsx` (aside 3153–3353, filter state 496–563, effect
  1421–1498, universe 1572–1594), `library-view.ts` (`FILTER_CHANGED`),
  `library.css` (`.psl__nav*`, `.psl__type-*` ~899–1061),
  `packages/shared/src/protocol.ts` (`CaptureFilter`), `captures-repo.ts`.

---

## 2. Grid startup selection + closed-right-bar behavior — review of PR #385

Reviewed at `7f4adcc3` in `/Users/huntharo/.pwragent/worktrees/mst7dz52/PwrSnap`
([PR #385](https://github.com/pwrdrvr/PwrSnap/pull/385)).

### What the PR does (correctly)

- Right-column occupancy is now **pin + cart only**; selection never toggles
  `data-right` (`Library.tsx` `gridRailOccupiesColumn`). This kills the
  reflow-under-cursor bug at the root rather than papering over it. ✅
- Pinned + nothing selected renders an inert empty inspector shell
  (`DetailRail.tsx` `psl__right-empty`) so a later select updates in place. ✅
- Pinned Grid default-selects `visibleRecords[0]` after settings hydrate
  (`resolveDefaultPinnedGridSelection`, `history: "replace"`). ✅ — and it's
  safe: Grid has no Delete/Backspace binding on the selection, so a user
  who "didn't select anything" can't accidentally trash the first tile.
- Unpinned + selection → `GridCopyPalette`: draggable, keyboard-focusable,
  reuses `CopyButton` / `VideoExportPresetsPanel` / `copyImagePreset*` — no
  second copy path. ✅ Grip + separator + clamp reuse EditToolbar's language. ✅
- ⌘1/2/3 now work in Grid. ✅

### Findings

| Finding | Sev | Recommendation |
|---|---|---|
| Palette defaults to **bottom-center of `.psl__main`** — often 600+ px from the tile that was just clicked; the eye has to hunt for it. | 🟡 | Add an **anchor mode**: `follow` (default) positions the palette adjacent to the selected tile — below it, flipping above / to the side when clipped, popover-style — and re-anchors on selection change and scroll; `pinned` keeps a user-dragged position (dragging switches to `pinned` implicitly). A tiny toggle on the grip end (📌 icon, `title="Follow selection / Stay put"`) flips it. Persist in Settings (`library.gridCopyPalette.anchor`) — the PR keeps position module-scoped "like EditToolbar", which is fine for *position* but the *mode* is a preference. |
| No preview of what you're about to copy — with small tiles (5+ cols) the L/M/H cards float over a grid where the selection ring is the only cue. | 🟡 | Add a **collapsible preview drawer**: chevron on the eyebrow row expands a ~200–240 px-tall contain-fit preview of the selected capture (image: `CellThumb`-style full-res; video: `HoverAutoplayVideo` muted). Collapsed by default; remember open/closed in Settings alongside anchor mode. |
| Palette hidden while pinned "so copy isn't duplicated" — but the pinned rail's footer is off-screen for a scrolled grid? No: rail is sticky. OK. However, on narrow windows `railEffectivePinned` flips false → palette appears with no explanation. | 🟢 | Fine as-is; add a one-line comment in `Library.tsx` that palette presence follows *effective* pin. |
| Video variant is much taller (6 cards). | 🟢 | Accept; with the drawer added, cap palette height at `min(60vh, …)` and let the body scroll. |
| Empty pinned shell text "Select a capture to inspect" is a dead end at startup, but default-select makes it near-unreachable — only after filtering to zero. | 🟢 | Reword to the filter context: "No captures match this filter." |
| Startup default-select fires the per-capture inspector IPCs (metrics, AI usage) for a capture the user didn't ask for. | 🟢 | Acceptable cost; note it in the PR body. |

### Handoff brief — **Opus 5**, stacked commits on PR #385 (or a stacked PR)

- Commit A: anchor mode (`follow` default, flip logic, drag → `pinned`,
  📌 toggle, Settings field `library.gridCopyPalette.anchor`).
- Commit B: preview drawer (chevron, contain-fit, Settings field
  `library.gridCopyPalette.previewOpen`).
- Commit C: empty-shell copy tweak; refresh the darwin golden.
- Acceptance: click a tile in an unpinned 6-col grid → palette appears
  within ~12 px of the tile without covering it; drag once → stays put across
  selections; ⌘-click another tile re-anchors only in `follow` mode.
- Files: `GridCopyPalette.tsx`, `library.css` (`.psl__grid-copy-palette*`),
  `Library.tsx` (pass selected tile rect / cell ref), `protocol.ts` Settings.

---

## 3. Right bar — seams between sub-components

### What's actually there

- The aside draws `border-left` ([library.css:2148–2157](../../apps/desktop/src/renderer/src/styles/library.css#L2148)),
  **and** `.rab__panel--pinned` draws its own `border-left`
  ([RightActivityBar.css:21–25](../../apps/desktop/src/renderer/src/features/shared/RightActivityBar.css#L21)),
  **and** `.rab__activity` draws a third. `.rab` is
  `grid-template-columns: 1fr auto auto`; the pinned panel is 320 px inside a
  360 px column, so the `1fr` slack track leaves a 1–2 px gutter between the
  aside's line and the panel's line → the visible double rule.
- `.psl__right--vertical` is `grid-template-rows: 1fr auto`; the
  `RightActivityBar` lives only in the `1fr` row, so the 38 px icon rail
  **stops** where `.psl__right-footer` (COPY TO CLIPBOARD) begins.
- The DetailTab stacks two boxed cards (Codex banner + model/cost strip)
  above the first field.

### Findings

| Finding | Sev | Recommendation |
|---|---|---|
| Double left border on the top half. | 🟡 | Drop `border-left` from `.rab__panel--pinned` when hosted inside `.psl__right` (scoped override) **and** set `pinnedWidthPx` = column − rail − 1 so the slack track is 0. One rule, no gutter. |
| Icon rail ends abruptly above the export footer; footer spans full width so it visually "belongs" to a different component. | 🟡 | Make the rail **full height**: move `RightActivityBar` to own the aside, and put the footer *inside* the panel column (below the tab body). Cost: footer goes from ~358 → 320 px; the three L/M/H cards lose ~12 px each — still comfortably above their content width. Benefit: one continuous rail, one separator, and the collapsed (38 px) state no longer has to `display:none` the footer — the hover-pop panel can carry the same footer. This is the "don't force it wider" answer: it goes *narrower*, not wider. |
| Two boxed cards before the first field (Codex banner, model/cost). | 🟢 | Merge into one row: `✦ Description filled from Codex · GPT-5.6-Luna · <$0.001` with **Regenerate** at the right; move the token detail into a hover title. Recovers ~70 px for Description. |
| The footer repeats the preset three times (card, FILE button, then File/Editor/trash row). | 🟢 | Put the FILE (drag/save) affordance *inside* each card's footer edge; keep the row below as `File · Editor · 🗑`. One fewer row. |
| Rail icons: second icon shows an accent dot with no legend. | 🟢 | Add `aria-label`/`title` and make the dot mean exactly one thing (e.g. "has OCR"). |

### Handoff brief — **Opus 5**, new worktree, PR off `main`

- Scope: border dedupe; full-height rail with footer inside the panel;
  banner+cost merge; card/FILE consolidation. Refresh visual goldens.
- Non-goals: changing tab set, cart tab, or copy behavior.
- Acceptance: exactly one 1 px separator between grid and rail in pinned
  and collapsed states; rail spans title-bar-to-footer; footer buttons ≥
  32 px tall; no `display:none` on the footer in collapsed state.
- Files: `library.css` (2146–2230, `.psl__right-footer`),
  `RightActivityBar.css`, `RightActivityBar.tsx`, `DetailRail.tsx`
  (760–855, 1389–1432).

---

## 4. Video viewer + export — half a surface

### What's actually there

- The viewer is a bare `<video controls playsInline preload="metadata">`
  ([Stage.tsx:293–310](../../apps/desktop/src/renderer/src/features/library/Stage.tsx#L293));
  `EditToolbar` is gated off for videos. So the user gets the Chromium
  control bar (⋮ menu with download/PiP), no scrubber feel, no trim.
- **Trim already exists end-to-end in the backend and is unexposed**:
  `VideoExportRequest.range?: VideoRange`
  ([protocol.ts:283–294](../../packages/shared/src/protocol.ts#L283)),
  `VideoCaptureMetadata.defaultRange`, IPC `video:setDefaultRange`
  ([protocol.ts:3686](../../packages/shared/src/protocol.ts#L3686)); the
  exporter applies `-ss/-t`
  ([recording-exporter.ts:374–412](../../apps/desktop/src/main/recording/recording-exporter.ts#L374)).
  Zero renderer callers of `video:setDefaultRange`. The FloatOver comment
  claiming a sub-range editor lives there is stale.
- Waveform: `SequenceWaveform` (wavesurfer.js, display-only, 24 px) is
  local to `SizzleApp.tsx:594`; audio extraction exists in
  `main/sizzle/audio-extract.ts`. No frame/thumbnail extraction IPC exists.

### Findings

| Finding | Sev | Recommendation |
|---|---|---|
| No trim in/out anywhere, though the pipeline supports it. | 🔴 | Ship a **transport + trim bar** first; it's mostly wiring. |
| Native controls: ⋮ menu exposes download/PiP, volume slider style clashes, no keyboard model. | 🟡 | Drop `controls`; render our own transport (play/pause, timecode `0:03.4 / 0:16.0` in mono, mute, loop-in-range, fullscreen). |
| No scrubber "feel": no filmstrip, no waveform, no frame step. | 🟡 | Timeline strip under the video: filmstrip thumbnails (new IPC `video:frames` → ffmpeg `fps=1/N` contact strip, cached like exports), waveform lane (lift `SequenceWaveform` to `features/shared/`), playhead, in/out handles bound to `defaultRange`. Keys: `I`/`O` set in/out, `←/→` frame step, `⇧←/→` 1 s, `J/K/L`, space, `Home/End`. |
| Export cards ignore the range in their labels. | 🟡 | After a range is set: eyebrow reads `EXPORT · 0:03–0:11 (8 s)`, sizes re-estimate, `range` rides on `video:export`; a "Full clip" chip resets. Same in the FloatOver toast (mini scrubber with in/out only). |
| No cursor/click emphasis, no speed, no crop. | 🟢 | Phase 2 (own plan): speed ramps, crop, cursor highlight, split/join. |

### Handoff brief — **Fable 5**, new worktree, **plan doc first** (`docs/plans/`), then PR(s) off `main`

- Phase A (one PR): custom transport, filmstrip + waveform timeline, in/out
  trim persisted via `video:setDefaultRange`, export cards honoring range,
  FloatOver mini-trim. New IPC `video:frames` (+ cache table or reuse
  `video_export_cache` keyed by `(capture, "frames", n)`).
- Phase B (separate plan): editing beyond trim.
- Acceptance: open a 16 s recording → set I at 3 s, O at 11 s with keys →
  MP4 MED export is 8 s; relaunch → in/out restored; FloatOver shows the
  same range.
- Files: `Stage.tsx`, new `features/library/VideoTransport.tsx` +
  `VideoTimeline.tsx`, `features/shared/SequenceWaveform.tsx` (moved),
  `main/handlers/recording-handlers.ts`, `recording-exporter.ts`,
  `protocol.ts`, `float-over/FloatOver.tsx`.
- **Claude Design**: worth a mockup pass for the timeline strip (filmstrip +
  waveform + handles) before code; the rest follows EditToolbar's language.

---

## 5. Grid tile affordances — invisible checkbox, tiny actions

### What's actually there

- Cart checkbox: 22×22, `opacity: 0` until tile hover, no scrim
  ([library.css:1674–1714](../../apps/desktop/src/renderer/src/styles/library.css#L1674)).
  On light screenshots (most of them) the unchecked box is a faint outline on
  white.
- Edit / trash / duplicate: 22×22 buttons with **12 px** icons that animate
  `max-width 0→22px` on hover
  ([library.css:1581–1633](../../apps/desktop/src/renderer/src/styles/library.css#L1581))
  — a width tween that shifts the duration chip sideways while appearing.
- No context menu on capture tiles (only Sizzle projects get one,
  `Library.tsx:4575`). Double-click behavior is the only "big target".

### Findings

| Finding | Sev | Recommendation |
|---|---|---|
| Checkbox is effectively undiscoverable. | 🔴 | (a) Paint a **corner scrim** (radial/linear, top-left, ~40 px) under it on hover so it reads on any thumbnail. (b) Once **any** tile is checked, show all tiles' checkboxes at rest (`.psl:has(.psl__cell-cart.is-checked) .psl__cell-cart { opacity: .9 }`) — "selection mode", as Photos/Drive do. (c) 24 px box, 2 px stroke, filled accent when checked, hollow white-on-scrim when not. |
| Action icons 12 px in 22 px targets, hidden until hover, width-animated. | 🔴 | 28×28 targets, 16 px icons, on a dark pill (`bg-panel` @ 85% + blur) inside a **bottom-right scrim**; fade + 2 px translate, **no width tween**. Show all actions together; keep the duration chip stable. Add `title`s. Also mirror the actions in a right-click **context menu** on capture tiles (Edit, Copy Low/Med/High, Save File, Reveal in Finder, Add to Cart, Move to Trash) so tiny buttons are never the only path. |
| Time badge, app pill, duration chip, actions all live on the four corners with different chrome. | 🟡 | One chrome: same radius, same 85% panel bg, same 10 px mono. The app pill's accent outline is fine as the one emphasized element. |
| Hover ring vs selected ring vs checked ring are three different treatments. | 🟢 | Selected = 2 px accent ring; checked = accent ring + filled box; hover = 1 px `border-default` lift. Document in `library.css` header. |
| Selection ring on light thumbnails: accent on white is fine; on white the *checkbox outline* is not — covered by scrim. | 🟢 | — |

### Handoff brief — **Opus 5**, new worktree, PR off `main`

- Scope: scrims, checkbox size/contrast/selection-mode, 28 px actions with
  16 px icons, no width tween, unified corner chrome, capture-tile context
  menu (renderer-built menu, same actions as the tile buttons).
- Non-goals: changing selection semantics, cart behavior, or grid zoom.
- Acceptance: on a pure-white capture, the unchecked box has ≥ 3:1 contrast
  against its scrim; check one tile → every tile's box is visible; actions
  hit-test at ≥ 28 px; refreshed darwin golden.
- Files: `Library.tsx` (`CartCellCheckbox` 183–207, tile JSX 4564–4700),
  `library.css` (1552–1714).

---

## 6. Sizzle Reels — the default model is the wrong one

### What's actually there

- `cart:commitToNewProject` maps **one `simple` scene per capture**
  ([cart-handlers.ts:288–320](../../apps/desktop/src/main/handlers/cart-handlers.ts#L288)):
  each gets its own script line, its own TTS clip, its own crossfade. That is
  the mode the screenshot shows and the one nobody wants for a 30–60 s reel.
- The right model **already exists**: `kind: "sequence"` = one narration
  block + ordered **beats** with `offset | phrase | auto` timing, per-beat
  transitions and video-fit policies, word-level speech timing, and even
  Ken Burns on image beats
  ([protocol.ts:1058–1300](../../packages/shared/src/protocol.ts#L1058),
  [2026-05-30 requirements](2026-05-30-sizzle-sequence-scenes-requirements.md),
  [2026-05-31 auto-beat plan](../plans/2026-05-31-001-feat-sizzle-auto-beat-timing-reorder-plan.md)).
  It is reachable only via a per-scene **Sequence** button
  (`SizzleApp.tsx:2788`) that converts one scene into a one-beat sequence.
- Layout: 240 px RECENTS/PROJECTS rail + 400 px chat = 640 px of a 1440 px
  window before the editor gets a pixel ([sizzle.css:9–19, 1311–1328](../../apps/desktop/src/renderer/src/features/sizzle/sizzle.css#L9)).
  The scene column is a vertical stack of form cards; the sequence timeline
  (`.szl__sequence-timeline`, waveform + beat track + playhead) exists but is
  buried inside a card.

### Findings

| Finding | Sev | Recommendation |
|---|---|---|
| Default = N isolated narrated scenes. | 🔴 | **Default to one sequence scene** with N `auto` beats in cart order, empty narration, `audioSource: voiceover`. Offer "Split into scenes" (one per beat) and "+ Scene" (new narration segment) as explicit actions. Keep `simple` for legacy projects; hide the per-card Sequence button behind "Convert". |
| Vocabulary is inverted for the user ("Scene" cards that are really slides; "Sequence" that is really a scene). | 🔴 | Name by narration: **Scene** = one voiceover segment (what a viewer hears as one thought); **Clips** = the visuals inside it, joined by **cuts** (or a transition). Between scenes: **transition**. Rename `Sequence` → `Scene` in UI copy; the type name in code can stay. |
| 1/3 of the screen is a list of other reels. | 🟡 | Collapse the left rail to a **breadcrumb dropdown** in the title bar (`SIZZLE REELS ▾ Untitled draft`) with recents inside; the rail becomes a toggle (⌘⇧L). Reclaims 240 px for the timeline. |
| No primary timeline; timing hidden per card. | 🔴 | Make the center a **player + timeline**: preview player (existing preview) on top; below it a scene strip where each scene is a lane: narration text (click a word → set a phrase anchor for the active clip — word timings exist), waveform under the text, clip thumbnails as draggable segments on the same time axis, transition pips between clips, and scene boundaries as heavier dividers. Card fields (duration override, fit policy, trim) become an inspector for the selected clip on the right, sharing the chat column via tabs (Inspect / Compose). |
| Voice / Provider / Resolution occupy the toolbar for every session. | 🟢 | Move to a "Reel settings" popover on the title; show a compact summary chip. |
| Render is a single button with no length/cost preview. | 🟢 | Show total duration + per-scene durations live in the strip header; Render button reads `Render · 0:42`. |
| Chat composer is 400 px fixed. | 🟢 | Make it a resizable pane, min 320, collapsible; when collapsed leave a slim "Compose" tab. |

### Handoff brief — **Fable 5**, new worktree, **requirements + plan first**, then PRs off `main`

- Slice 1 (small, ships first): default `cart:commitToNewProject` (and
  `sizzle:create` from the sidebar) → one sequence scene with N auto beats;
  UI rename Sequence → Scene / Clips; "Split into scenes" + "+ Scene".
- Slice 2: layout — rail → breadcrumb dropdown; chat pane resizable/collapsible.
- Slice 3: timeline — player + scene lanes (narration text with word-anchor
  clicking, waveform, clip segments, drag reorder reusing the auto-beat
  work), clip inspector tab beside chat.
- Acceptance (slice 1): cart of 5 → one scene, 5 clips, one narration box;
  render produces one continuous voiceover with 5 visuals; existing simple
  projects open unchanged.
- Files: `cart-handlers.ts` (230–320), `SizzleApp.tsx` (`convertToSequence`
  2086–2099, timeline ~760–830, cards ~2350–2800), `sizzle.css`,
  `SizzleChatPanel.tsx`, `main/sizzle/*` untouched for slice 1.
- **Claude Design**: yes — the timeline/lane surface is the one screen in this
  critique that deserves 2–3 mockup variants before code. Feed it the
  `design/` bundle for tokens.

---

## Consistency (cross-surface)

| Element | Issue | Recommendation |
|---|---|---|
| Hover-revealed controls | Tile actions (22/12 px), sidebar `only` (proposed), palette grip, rail hover-pop — four sizes/animations. | One rule: ≥ 28 px target, 16 px glyph, fade + 2 px translate, 100–130 ms, no width tweens. |
| Floating chrome | EditToolbar, GridCopyPalette, rail hover-pop, FloatOver toast each set their own bg/blur/shadow. | One `--floating-*` token set (bg @ 96 % + blur 20 px, `border-subtle`, `shadow-md`, radius 10). #385 already reuses EditToolbar's grip — extend that. |
| Selection semantics | Grid: selected ring vs checked ring; Sizzle: no visible selected clip. | Selected = accent ring everywhere; checked = ring + filled box; document once. |
| Terminology | Sizzle "Scene/Sequence/beat"; Library "Cart"; Video "range/defaultRange". | User-facing: Scene / Clip / Cut / Transition; Cart stays (it's good); "Trim". |

## Accessibility (spot checks against the screenshots)

- **Contrast**: `--text-muted` (`#8c857a`) on black is ≈ 5.7:1 — passes AA,
  but at 10 px mono it sits at the readability floor; don't go below
  `--text-secondary` for anything ≤ 10 px. The unchecked tile checkbox fails
  outright on light thumbnails (fixed by the scrim in §5).
- **Targets**: tile actions are 22 px (12 px glyph) — under the 24 px
  minimum; the sidebar type checkbox glyph is 12 px but the whole row is
  the target, so it hit-tests fine and only *reads* small. Palette FILE
  buttons are ~22 px tall. Bring all standalone controls to ≥ 28.
- **Keyboard**: PR #385's palette is focusable and ⌘1/2/3 work in Grid — good.
  The video viewer has no keyboard model at all today; §4 defines one.
- **Labels**: rail icons and the palette 📌 toggle need `aria-label`s; the
  sidebar's proposed `−`/`✓` glyphs need `aria-pressed`/`aria-checked`.

## What works well

- The Grid: day banners with counts, thumbnail-first tiles, the app pill,
  ⌘/pinch zoom with the `− 3 cols +` nudge — this is the app's spine and it holds.
- The Cart as a rail tab with Trash / New Sizzle / Add to existing / ZIP
  export — multi-select that goes somewhere.
- The Inspector's content: Codex title/description/filename/tags with
  suggested-tag chips is genuinely useful; only its chrome needs work.
- PR #385's core decision (occupancy = pin + cart) is the right architecture,
  and it reused every copy primitive instead of forking one.
- The Sizzle **backend** (sequence scenes, phrase anchors, auto beats,
  fit policies, word timings, Ken Burns) is far ahead of its UI — the fix is
  exposure, not invention.

## Priority recommendations

1. **Sizzle default → one scene, N clips (§6 slice 1)** — a ~200-line change
   in `cart-handlers.ts` + copy renames that flips the product from
   "slideshow with per-slide TTS" to "narrated reel". Highest value per line.
2. **Grid affordances (§5)** — the checkbox and actions are the first thing
   a new user fails to find; pure CSS + one context menu.
3. **Video trim + transport (§4 phase A)** — backend is done; exposing it
   turns "not a video editor" into "a trimmer with a real scrubber".
4. **Sidebar model (§1)** — fixes a paradigm mismatch; the chip row is the
   piece that makes the rest safe.
5. **Right bar seams (§3)** and **PR #385 follow-ups (§2)** — polish, both
   contained, both good Opus-sized PRs.

## Status (2026-08-15, same day)

| § | PR | Base | Notes |
|---|---|---|---|
| 1 sidebar facets | [#392](https://github.com/pwrdrvr/PwrSnap/pull/392) | `main` | scope/types/sourceApps split, ⌘/⌥, hover **only**, chip row, `excludeAppBundleIds` (NULL-safe `NOT IN`; sidebar exclude is client-side for now) |
| 2 palette follow-ups | [#390](https://github.com/pwrdrvr/PwrSnap/pull/390) | #385 | follow/pinned anchor mode + 📌, preview drawer, both persisted in Settings |
| 3 right bar | [#388](https://github.com/pwrdrvr/PwrSnap/pull/388) | `main` | one separator (`pinnedWidthPx="fill"`), full-height rail with footer in the panel, merged Codex/cost row, FILE folded into cards |
| 4 video phase A | in flight | `main` | plan doc + transport + filmstrip/waveform timeline + trim → export + FloatOver mini-trim |
| 5 grid tiles | [#391](https://github.com/pwrdrvr/PwrSnap/pull/391) | `main` | scrims, 24 px checkbox + selection mode, 28 px actions, unified chip chrome, capture context menu (+ new `capture:saveAs`) |
| 6 slice 1 | [#387](https://github.com/pwrdrvr/PwrSnap/pull/387) | `main` | one scene, N clips by default; Scene/Clip vocabulary; clip-aware membership |
| 6 slice 2 | [#389](https://github.com/pwrdrvr/PwrSnap/pull/389) | #387 | rail → crumb dropdown, resizable chat, reel-settings chip, **Split into scenes** |
| 6 slice 3 | pending mockups | — | lane timeline; brief in the PwrDrvr Design System project (`briefs/sizzle-timeline-brief.md`) |

All PRs note that darwin visual goldens need a headed refresh before merge.
#391 and #392 both touch `Library.tsx` / `library.css`; merge one, rebase the other.

## Suggested PR fan-out

| # | Branch base | Owner | Worktree | Docs first? |
|---|---|---|---|---|
| §6 slice 1 | `main` | Fable 5 | new | short plan (reuse 05-30 reqs) |
| §5 grid affordances | `main` | Opus 5 | new | no |
| §4 video phase A | `main` | Fable 5 | new | plan in `docs/plans/` |
| §1 sidebar filters | `main` | Opus 5 | new | no (this doc's spec suffices) |
| §3 right bar | `main` | Opus 5 | new | no |
| §2 palette follow-ups | stacked on #385 | Opus 5 | `mst7dz52` | no |
| §6 slices 2–3 | `main` (after slice 1) | Fable 5 | new | requirements + plan + Claude Design mockups |

Note on "use Claude Design": the `DesignSync` tool available here syncs a
component library *to* a Claude Design project; it does not generate
mockups. The two surfaces worth mockups are the video timeline (§4) and the
Sizzle scene-lane timeline (§6). Everything else is spec'd tightly enough
above to go straight to code against the existing tokens.
