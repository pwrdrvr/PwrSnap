# PwrSnap Repository Guidance

## Source of Truth

- Implementation plans live in `docs/plans/`. The current canonical buildout plan is
  [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md) —
  read it before changing scope, schema, IPC contracts, or phase order.
- Brainstorm / requirements docs (when they appear) live in `docs/brainstorms/`.
- Solution learnings (post-incident notes, gotchas) live in `docs/solutions/`.
- The original Claude Design handoff bundle (HTML/JSX/CSS reference for the
  Library + Float-Over + Tray surfaces) is preserved verbatim under `design/`.
  Treat it as a visual reference, not as code to import.

## Workflow

- Treat plan documents as decision artifacts, not implementation scripts.
- Keep changes aligned with the current active plan unless the user explicitly
  changes scope.
- Do not delete or "clean up" files in `docs/brainstorms/`, `docs/plans/`, or
  `docs/solutions/`.

## Agent Instruction Files

- Keep a sibling `CLAUDE.md` symlink next to every `AGENTS.md`, pointing at
  that `AGENTS.md`, so Codex and Claude read the same local guidance.
- Project root: `CLAUDE.md → AGENTS.md` (this file).

## Brand and Identity

- Product name is **PwrSnap** — one word, two capitals (`Pwr` + `Snap`),
  rendered as `Pwr` in primary text + `Snap` in copper accent. Never insert
  whitespace between the halves; never lowercase the second capital.
- Company is **PwrDrvr LLC**. License markings are `UNLICENSED` —
  v1.0 is closed-source proprietary.
- Visual language follows the design system in `design/` — warm near-black
  surfaces, burnt-copper accent (`#e8743a`), Geist + Geist Mono.

## Codex App Server is the AI brain

**All AI features in PwrSnap go through the user's installed Codex CLI / Codex
Desktop instance over stdio JSON-RPC.** This is the schtick — annotation,
description generation, tag suggestion, smart filenames, sensitive-data
review, voice describe, sizzle-reel composition. No direct OpenAI / Anthropic
/ xAI calls in `apps/desktop`.

### Protocol package

TypeScript types for the protocol live at
[packages/codex-app-server-protocol/](packages/codex-app-server-protocol/).
The contents of its `src/` are **generator output** — do not hand-edit.

To (re)generate the protocol types from the locally-installed Codex CLI:

```bash
pnpm codex:generate-protocol
```

(equivalent: `pnpm --filter @pwrsnap/codex-app-server-protocol generate`)

By default this runs against **Codex Desktop's bundled binary** at
`/Applications/Codex.app/Contents/Resources/codex`. Override via
`PWRSNAP_CODEX_BIN=/path/to/codex pnpm codex:generate-protocol` to point at
a system-installed CLI, a custom build, or a CI install. The generated files
under `packages/codex-app-server-protocol/src/` are committed so the rest of
the workspace builds without a Codex install at hand.

Regenerate whenever Codex Desktop autoupdates or a new protocol surface lands
that PwrSnap wants to consume.

### Connecting at runtime

PwrSnap discovers and connects to the user's local Codex install — same model
as PwrAgnt. Settings → AI surfaces every detected Codex binary, lets the user
pick newest / pin a specific path, and persists the choice. Discovery code in
`apps/desktop/src/main/settings/codex-discovery.ts` mirrors PwrAgnt's
implementation; see plan §"Phase 0.5".

### One-shot vs multi-turn

Both shapes go through Codex App Server:

- **Phase 4 background pipelines** (annotate / describe / tag / filename) use
  ephemeral threads + `DynamicToolCall` for structured output. Image input
  rides as a `ContentItem` in `TurnStartParams`. Thread is closed immediately
  after the turn completes.
- **Phase 4+ user-facing AI surface** ("ask Codex about this snap") uses
  long-lived threads with normal `turn/start` cadence.
- **Phase 6 sizzle composer** uses multi-turn agentic flow.
- **Phase 5+ voice describe** uses `ThreadRealtime*`.

PwrSnap is an App Server *client* only — never an App Server *implementation*.

## Repository conventions

- **pnpm workspaces.** Apps in `apps/*`, packages in `packages/*`. Always run
  `pnpm install` from the repo root.
- **Channel naming.** IPC channels use bare `<domain>:<verb>` (`capture:region`,
  `library:list`, `overlays:upsert`). No `pwrsnap:` prefix; matches PwrAgnt.
- **Single command bus.** All commands route through
  `apps/desktop/src/main/command-bus.ts`. ipcMain (Phase 1), HTTP RPC
  (Phase 7), and a future MCP transport all dispatch through it. There is
  exactly one place to register a command and exactly one place to enforce
  auth + capability checks.
- **TypeScript strict.** `tsconfig.base.json` has `strict`,
  `verbatimModuleSyntax`, `isolatedModules`, and (per the deepening plan)
  `exactOptionalPropertyTypes`.
- **Renderers stay sandboxed.** Every `BrowserWindow` is created with
  `contextIsolation: true, sandbox: true, nodeIntegration: false`. The Phase 6
  Remotion player runs in a sandboxed renderer; render orchestration runs in
  a Node child process. Lifecycle test enforces.
- **Result-pattern for cross-process errors.** Electron `invoke` strips
  `instanceof`. All command handlers return `Result<Res, PwrSnapError>` —
  `{ ok: false, error: { kind, code, message, cause? } }`.

## BrowserWindow sizing — `setMinimumSize(0, 0)` after construction

**Any BrowserWindow that auto-sizes to its content via `setContentSize`
at runtime must call `setMinimumSize(0, 0)` once after construction.**
This applies to the tray popover, the float-over toast, the E2E test
fixtures, and any future popover / HUD that grows or shrinks past its
initial frame.

### What goes wrong without it

When a BrowserWindow is constructed with explicit `width` and `height`,
Electron records those values as the IMPLICIT MINIMUM CONTENT SIZE
(this is internal — there's no `minimumSize` constructor option that
makes it explicit). Subsequent `setContentSize` calls are then clamped
at that minimum on macOS — the call returns without error, but the
window's content area never grows or shrinks past the constructor
frame. `getContentSize()` reads back the requested value, so the
clamp is invisible from the main process side; only the rendered
window reveals it.

Symptom: the renderer's ResizeObserver fires the resize-to-fit IPC
with the right measured height, main dutifully calls `setContentSize`,
and the popover stays stuck at its constructor frame. Rows past the
clamp are clipped off the bottom edge. Looks like a CSS / measurement
bug, isn't.

This is amplified for `type: 'panel'` (NSPanel) windows because
`resizable: false` removes `NSResizableWindowMask` from the styleMask,
which AppKit interprets as "no programmatic resize either." The
implicit min-size is the headline issue, but combining `panel + non-
resizable + non-movable + frame: false` is the configuration where
the clamp matters most.

References: [electron/electron#14065](https://github.com/electron/electron/issues/14065).

### The fix

Call `window.setMinimumSize(0, 0)` immediately after `new BrowserWindow(...)`
to lift the constraint. After that, `setContentSize` is free to set
whatever the renderer measured. No need to flip `resizable` or pad
the constructor with min/max bounds — `setMinimumSize(0, 0)` is the
one thing that makes setContentSize land.

```ts
const window = new BrowserWindow({
  type: "panel",
  width: 440,
  height: 440,
  resizable: false,          // OK to keep — user UX is unaffected
  movable: false,
  frame: false,
  // ...
});
// ⚠️  REQUIRED if anything will setContentSize() this window later.
window.setMinimumSize(0, 0);
```

### Where this matters today

- `createTrayWindow` in `apps/desktop/src/main/window.ts` — sized by
  the renderer's `pwrsnap:tray:resize` IPC; main listens in
  `apps/desktop/src/main/tray.ts` (`wireTrayResizeChannel`).
- `createFloatOverWindow` in `apps/desktop/src/main/window.ts` — sized
  by the renderer's `float-over:resize` IPC; main listens in
  `apps/desktop/src/main/float-over.ts` (`wireFloatOverResizeChannel`).
- `apps/desktop/e2e/fixtures/electron-app.ts` — Playwright harness
  needs to shrink the library window below its constructor frame for
  size-sensitive specs. Same fix.

### How we keep losing this

We've solved this exact problem before — first in the E2E fixture
(commit `943ff64`), then re-discovered it for the tray + float-over
windows when their content grew past the constructor frame after the
design refresh. The clamp is invisible from the main side
(`getContentSize` reads back the requested value), the renderer's
ResizeObserver isn't broken, and the CSS isn't broken — so the
investigation tends to chase visible symptoms (CSS, observer timing,
overflow rules) before landing on the actual platform behavior. If
you find yourself debugging "popover is stuck at its initial size,"
check for `setMinimumSize(0, 0)` first.

## Tray popover sizing — fixed heights, NOT measure-and-fit

**The tray popover uses a hardcoded `lastSnap`-conditional height.
Do NOT replace it with a ResizeObserver-driven measure-and-fit
implementation without reading the rest of this section.**

Current implementation in `apps/desktop/src/renderer/src/features/tray/TrayMenu.tsx`:

```ts
const TRAY_HEIGHT_WITH_LAST_SNAP = 620;
const TRAY_HEIGHT_EMPTY = 250;
useLayoutEffect(() => {
  const targetHeight =
    lastSnapId === undefined ? TRAY_HEIGHT_EMPTY : TRAY_HEIGHT_WITH_LAST_SNAP;
  // dispatch pwrsnap:tray:resize with { width: 440, height: targetHeight }
}, [lastSnapId]);
```

The two heights cover the two structural shapes the tray takes:

- **`TRAY_HEIGHT_EMPTY = 250`** — header + Quick Capture button + 6-mode grid only.
  Active when `useLibrary` returns no captures (fresh-install / DB just cleared).

- **`TRAY_HEIGHT_WITH_LAST_SNAP = 620`** — empty-state content + last-snap section
  (eyebrow + 120 px preview + Low/Med/High `.fo__copy-btn` row). Active whenever
  `useLibrary` has at least one capture.

### Why fixed heights instead of measure-and-fit

The ResizeObserver-driven approach was tried four ways and hit four
distinct bug surfaces, each masking the next:

1. **Electron NSPanel `setContentSize` clamp.** The OS-level fix
   (`setMinimumSize(0, 0)` after construction — see the previous
   section) is required regardless of measurement strategy, but on
   its own it's not sufficient.

2. **Geist web-font swap measurement oscillation.** During Geist's
   `font-display: swap` cycle, the ResizeObserver fires three times
   in close succession with wildly different heights:
   - Measurement 1: ~468 px (system fallback metrics)
   - Measurement 2: ~637 px (transient mid-swap state where the
     Quick Capture subtext briefly wraps to ~10 lines because font
     metrics are unstable)
   - Measurement 3: ~468 px (back to fallback metrics, even though
     Geist is actually loaded by this point)

   The naive "post the latest measurement" approach lands the popover
   at 468 px → bottom 112 px clipped (preview tail + copy buttons +
   bottom border).

3. **Peak-height sticky-grow.** Adding a `peakHeightRef` so the
   posted height never shrinks past the largest observed value
   helped on first-show, but didn't survive `useLayoutEffect`
   re-runs across `lastSnap` changes (when refetch returns a record
   with the same id, peak resets but measurement 2 doesn't fire).

4. **`document.fonts.ready` deferral.** Even waiting for fonts.ready,
   the post-load measurement was inconsistent — sometimes the
   bounding rect under-reported content extent. Theory: `.ps-tray`
   has `overflow: hidden`, which under specific layout-engine
   conditions causes `getBoundingClientRect()` to return the
   border-box rather than the content-extent.

The tray's content is *structurally fixed* — only two possible
shapes — so hardcoding their heights eliminates the entire
measurement-timing class of bugs. Cost is a small amount of empty
space at the bottom when fonts are still loading or when the
last-snap preview happens to render shorter than its 120 px slot.
That tradeoff is fine for a popover.

### Tuning the constants

Use the **forced-height diagnostic** to measure what the popover
actually needs. Temporarily override the resize handler in
`apps/desktop/src/main/tray.ts` (`wireTrayResizeChannel`):

```ts
const clamped = 800;  // or whatever fixed height you want to test
```

Build, restart the dev session, open the tray. The window will lock
to 800 px regardless of what the renderer posts. Visible content +
empty space at the bottom = your true content height. Pick the new
constant a bit *above* that (~30–40 px headroom for font-metric
variability across Geist load states), commit, revert the override.

### When to revisit

- A new top-level section gets added to the tray (third structural
  shape) — define a third height constant and add a third branch to
  the conditional.
- The design changes the size of an existing section (e.g. preview
  grows from 120 → 160 px) — re-run the forced-height diagnostic
  and bump `TRAY_HEIGHT_WITH_LAST_SNAP` accordingly.
- The popover starts to look noticeably empty at the bottom across
  all states — you can shrink the constant, but verify the worst-
  case font load doesn't clip first.

If you do want to bring back dynamic measurement (because content
becomes genuinely variable — multiple capture types with very
different preview aspect ratios, etc.), be aware you'll be fighting
both Electron and the layout engine. Worth doing only with strong
test coverage of the font-load timing across cold and warm starts.

## Pull Requests

- Conventional Commit-style PR titles: `type(scope): short description`.
- Scopes that match the project area:
  - `desktop` — the Electron app itself (main, preload, renderer).
  - `protocol` — the `@pwrsnap/codex-app-server-protocol` package.
  - `design` — UI work tied to the design system.
  - `release` — packaging, signing, notarization, distribution.
  - `docs` — documentation only.
  - `tests` — test coverage / fixtures / infrastructure.

## Release / Distribution

- Closed-source proprietary. License markings (`UNLICENSED`) are load-bearing.
- macOS-first (Phase 1–7); cross-platform deferred to Phase 8.
- electron-builder config at [apps/desktop/electron-builder.yml](apps/desktop/electron-builder.yml).
  Hardened runtime + notarization wired (notarize off until Apple Developer
  ID is configured).
- Auto-update wires in Phase 3 via `electron-updater`, mirroring PwrAgnt's
  pattern.

## Dependencies and tooling

- Node version pinned in `.nvmrc` (currently `v24.14.1`).
- Package manager: `pnpm@10.33.0` (set in root `package.json`'s
  `packageManager` field).
- Electron + electron-vite versions pinned in `apps/desktop/package.json`,
  matching PwrAgnt for tool consistency.
