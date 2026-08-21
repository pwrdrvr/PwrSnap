---
date: 2026-08-21
topic: focus-stage-chrome-design-review
status: critique + options (no code changes in this doc)
mockups: Claude Design › PwrSnap project › "PwrSnap Stage Chrome.html"
---

# Design review: Focus-mode stage chrome (Image + Video editor)

Reviewed against the 2026-08-21 screenshots (v1.1.0-alpha.4: video focus,
image focus, grid with "star map" search active) **and the code that renders
them**. Mockups for every option live in the Claude Design PwrSnap project as
`PwrSnap Stage Chrome.html` (sections: 00 Today annotated · A · B · C).

Line numbers reference branch `claude/cool-bartik-a7a21e` at `ce392f8a`.

## What's actually there

The Focus pane is `.psl__focus` ([library.css:3681](../../apps/desktop/src/renderer/src/styles/library.css#L3681)),
a plain in-flow div in the Library's content grid cell. Everything the user
complained about is `position: absolute` inside it:

| Element | Where | Rule |
|---|---|---|
| Breadcrumb (app pill · date · dims · **counter pill**) | [Stage.tsx:198–212](../../apps/desktop/src/renderer/src/features/library/Stage.tsx#L198) | `.psl__stage-meta { top:12; left:24 }` |
| × close | [Stage.tsx:216–235](../../apps/desktop/src/renderer/src/features/library/Stage.tsx#L216) | `.psl__focus-close { top:14; right:14; 32px }` |
| "back to grid **esc**" hint | [Stage.tsx:236–239](../../apps/desktop/src/renderer/src/features/library/Stage.tsx#L236) | `.psl__focus-close-hint { top:18; right:56; 10px mono, text-muted }` |
| ←/→ | [Stage.tsx:242–288](../../apps/desktop/src/renderer/src/features/library/Stage.tsx#L242) | `.psl__stage-nav { top:50%; translateY(-50%) }` — **50% of the pane** |
| Media | `.psl__stage-img` → `<Editor>` (image) or `<VideoStage>` (video) | |

`<VideoStage>` ([VideoStage.tsx:596–640](../../apps/desktop/src/renderer/src/features/library/VideoStage.tsx#L596))
is a column: `.psl__video-frame` (flex:1) + `.psl__vt` transport (36px) +
`.vtl` timeline (~118–134px incl. padding). All three live *inside*
`.psl__stage-img`, so the pane's 50% line is ~75–80px below the video
frame's center. For images the `EditToolbar` floats over the stage and the
canvas is centered in the pane, so 50% happens to be right.

The counter is wired at [Library.tsx:4143–4151](../../apps/desktop/src/renderer/src/features/library/Library.tsx#L4143):

```ts
posLabel={{ idx: selectedIdx + 1, total: isTrashView ? visibleRecords.length : totalLive }}
```

`totalLive` is the app-wide live count (same source as the title bar's
"3638 captures"), while `selectedIdx`, `prevRecordId`, `nextRecordId`
([Library.tsx:2210–2226](../../apps/desktop/src/renderer/src/features/library/Library.tsx#L2210))
all index into `visibleRecords` — the **filtered** set. With the "star map"
search active that's 3 records, so the UI says "1 / 3635" and → wraps after 3.
The title bar already has the correct number: `searchResultCount` →
"3 matches" ([Library.tsx:3402–3418](../../apps/desktop/src/renderer/src/features/library/Library.tsx#L3402)).

## Findings

Legend: 🔴 blocks / misleads · 🟡 slows or confuses · 🟢 polish

| # | Finding | Sev | Why it happens | Recommendation |
|---|---|---|---|---|
| 1 | Video ←/→ look vertically misaligned | 🟡 | Anchored to 50% of the pane; the pane includes transport + timeline | Anchor the arrows to the **media band**: for video, the vertical center of `.psl__video-frame`; for image, the canvas viewport (unchanged). Cleanest: render the arrows *inside* the band element (`VideoStage` passes a `navSlot`, or `Stage` positions them with a measured `top` from a `ResizeObserver` on the frame). Don't hand-tune a pixel offset — the timeline has a `--compact` variant and the transport can grow. |
| 2 | Counter shows "1 / 3635" while ←/→ cycle 3 records | 🔴 | `total: totalLive` ignores search/type/app filters; only Trash uses `visibleRecords.length` | Source of truth for `total` must be the same set `prevRecordId/nextRecordId` walk. When a search is active use `searchResultCount` (already capped/"+"-aware); otherwise the filtered count (today that's `visibleRecords.length`, with the keyset-pagination caveat that it undercounts until pages load — show "N+" or just `loadedCount` with the existing "+" convention). Never `totalLive` unless no filter is active. This fix is independent of which option below ships. |
| 2b | Floating counter competes with the media and duplicates the title-bar count | 🟡 | Absolute pill inside the breadcrumb | Move it out of the stage (Option B/C) or into a reserved row (Option A). The idea of "position in set" is still useful — it's the *placement* and the *number* that are wrong. |
| 3 | × and "back to grid esc" are hard to read and get in the way | 🟡 | 10px mono `--text-muted` (~5.7:1 on black, but painted over arbitrary screenshot pixels with a blurred pill); the × overlaps the top-right of tall captures; the esc hint is pure text | Stop painting chrome over media. Either reserve a row (A), move close/esc into the title bar (B), or reduce to a hover-revealed × with esc as its tooltip (C). In every option the esc *text* goes away; the key stays discoverable via tooltip or a `kbd` chip in persistent chrome. |
| 4 | Breadcrumb (app · date · dims) duplicates the DetailRail header | 🟢 | Rail header already shows "Electron snap · 1440×938 · 866 KB · VIDEO · Aug 20 · [Electron]" | Drop it from the stage when the rail is pinned/open. Keep a minimal app pill only if the rail is collapsed (its hover-pop has it anyway). |
| 5 | Reel mode shares the same chrome (`ReelStage`, no ×) | 🟢 | same `.psl__stage-meta` / `.psl__stage-nav` | Whatever ships for Focus must keep Reel consistent — Reel pins the canvas top-left with `padding-top: 44px` to clear the breadcrumb ([library.css:3742](../../apps/desktop/src/renderer/src/styles/library.css#L3742)); removing the breadcrumb lets that padding go too. |

## Options (mockups in Claude Design)

### A · Reserved chrome row above the media

A 32px flex row at the top of `.psl__focus` (in-flow, not absolute):
`[app pill] [date] [dims] ··· [2 of 3 · "star map"] [back to grid esc] [×]`.
Media starts below it; ←/→ anchor to the media band. Chips degrade by pane
width (mockup "A · Breakpoints"):

| pane width | keeps |
|---|---|
| ≥ 900 | everything |
| ≥ 700 | drop dims + time; esc hint → bare `esc` key |
| ≥ 520 | drop date + filter label; count → `2/3`; esc → × tooltip |
| < 520 | app pill + × only; count moves to the title bar |

Pros: nothing floats over media; the × stays where muscle memory expects it;
works identically when the rail is collapsed. Cons: 32px less canvas; it's a
second header under the title bar; breakpoint logic to maintain; the × either
shrinks to 28px or overhangs the row by 2px (mockup shows 28px in-row).

### B · Title bar owns the chrome — **recommended**

While `view.kind === "focus"`:
- the REEL/GRID segmented control's GRID cell reads **`⊞ BACK TO GRID esc`**
  (it's already the control that leaves Focus — `TOGGLE_VIEW`); REEL stays as
  the second cell.
- the count slot (`.psl__count`) reads **`2 / 3 · star map`** — same slot,
  same mono style, accent index. Falls back to `2 / 3638` with no filter.
- the stage renders **only** the media + ←/→ (anchored to the frame) + the
  EditToolbar for images. No breadcrumb (rail has it), no ×, no esc text.
- Reel mode: same title bar treatment minus the back affordance.

Pros: zero floating chrome, zero new rows; uses two slots that already exist
and already change by mode; the count stops lying because it's computed where
`searchResultCount` lives; esc stays visible as a `kbd` chip in persistent
chrome. Cons: the × moves ~60px up-right into the title bar — a small
relearn; on very narrow windows (`isToolbarNarrow`) the segment label must
collapse to the icon + `esc`.

### C · Cinema (minimal)

Strip everything; ←/→ and × rest at ~45% opacity and brighten on pane hover;
esc is the ×'s tooltip; count appears as `· 2 of 3` in the rail header and
`2 of 3 matches` in the title bar. Pros: smallest diff, most canvas. Cons:
least discoverable (hover-only affordances, no visible esc), and the × still
overlaps the top-right of tall captures.

### What I'd ship

**B, plus the two fixes that are option-independent:**

1. `total` = the filtered set (same array ←/→ walk), "+" when capped.
2. Arrows anchored to the media band for video.

Then remove `.psl__stage-meta`, `.psl__focus-close`, `.psl__focus-close-hint`
from `Stage.tsx`, and add the focus-mode variants of `.psl__view` and
`.psl__count` in `Library.tsx`. If B's title-bar × feels too far from the
image in use, A is the fallback — it's the same chips, just in a row under
the title bar.

## Handoff brief — **Opus 5**, new worktree, PR off `main`

- Scope: (1) correct `posLabel.total`; (2) video ←/→ anchored to
  `.psl__video-frame`'s band (ResizeObserver or slot); (3) Option B title-bar
  chrome — focus-mode GRID cell → "BACK TO GRID esc", `.psl__count` →
  `idx / total · <query>`; (4) delete stage breadcrumb / × / esc hint; (5)
  Reel: drop the 44px breadcrumb clearance; (6) goldens + E2E selectors that
  referenced `.psl__focus-close` (grep `e2e/` for `focus-close`, `back to grid`).
- Non-goals: EditToolbar, DetailRail, VideoTransport, filter semantics.
- Acceptance: with "star map" active, open result 2 → title bar reads
  `2 / 3 · star map`, → goes to 3/3, → again wraps to 1/3; video focus: the
  ←/→ centers equal the `<video>` element's vertical center ±1px at two window
  heights; no element paints over the capture except ←/→ and (images) the
  toolbar; Esc and the title-bar cell both return to Grid; Reel unchanged
  except the removed top padding.
- Files: `Stage.tsx`, `VideoStage.tsx`, `Library.tsx` (3376–3418 topbar,
  4143–4151 posLabel), `library.css` (3681–3900), `video-timeline.css`.
