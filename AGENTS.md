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

## Tray popover sizing — measure with `scrollHeight`, NOT `getBoundingClientRect`

**The tray popover sizes itself dynamically. The renderer measures
the content's natural height and main `setContentSize`s the
BrowserWindow to match. Do NOT revert to hardcoded heights — fixed
heights work on the machine you tuned them on and silently mis-fit
elsewhere (different font fallback metrics, OS font preferences,
display scaling), as we discovered the hard way.**

Implementation in `apps/desktop/src/renderer/src/features/tray/TrayMenu.tsx`
inside `TrayMenu`'s `useLayoutEffect`. The renderer dispatches
`pwrsnap:tray:resize` events; the resize handler in
`apps/desktop/src/main/tray.ts` (`wireTrayResizeChannel`) calls
`setContentSize` and re-anchors the window. Main clamps the
posted value to `[TRAY_HEIGHT_MIN=200, TRAY_HEIGHT_MAX=880]` so a
renderer-side measurement bug can't shrink to nothing or grow
off-screen.

### Why `scrollHeight`, specifically

The earlier measure-and-fit attempt used
`getBoundingClientRect().height` and got stuck at fallback-font
heights even after Geist loaded. Root cause: `.ps-tray` carries
`overflow: hidden` (load-bearing — keeps the rounded corners crisp
against the transparent BrowserWindow). With `overflow: hidden`,
the element's border-box tracks whatever main has most recently
sized the window to — *not* the natural content extent — so the
ResizeObserver was effectively measuring its own previous output.
Silent feedback loop. `scrollHeight` is unaffected by `overflow`
because it always reports the intrinsic content extent of the
element's children.

### The other gotchas the implementation handles

1. **Electron NSPanel `setContentSize` clamp.** Required for ANY
   strategy, fixed or dynamic. See the previous section
   (`setMinimumSize(0, 0)`).

2. **Geist web-font swap reflow.** Geist loads with `font-display:
   swap`, so the popover paints first with system-fallback metrics
   and reflows when Geist arrives. We re-measure inside a double
   `requestAnimationFrame` after `document.fonts.ready` to land on
   the post-swap layout.

3. **`overflow: hidden` border-box trap.** Solved by `scrollHeight`
   — see above.

4. **Image-load reflow.** The last-snap preview lives inside a
   fixed `height: 120px` box, so image decode shouldn't change the
   measured height — but we listen for `load` on any non-complete
   `<img>` inside `.ps-tray` anyway, as cheap insurance against a
   future preview that doesn't pin its height.

5. **Idempotent posting.** A `posted` cursor short-circuits no-op
   IPC traffic, so the steady-state cost is one resize on first
   paint + one after fonts ready (if they differ) + zero from the
   observer.

### Tuning + diagnostics

The **forced-height diagnostic** still works: temporarily replace
the resize handler in `apps/desktop/src/main/tray.ts`
(`wireTrayResizeChannel`):

```ts
const clamped = 800;  // pin to whatever you want to test
```

Useful when you suspect the renderer's measurement is wrong
(diagnose by ruling out the IPC path) or when you want to see the
worst-case content extent.

If a future content change pushes the popover near `TRAY_HEIGHT_MAX`
(880 px), bump the ceiling in `tray.ts` rather than fighting the
measurement. The popover anchors top-down from the menubar tray
icon, so growing taller doesn't push off-screen — Electron clamps
to workArea automatically.

### When to revisit

- A new top-level section gets added or content becomes genuinely
  variable (e.g. multi-snap preview list) — the dynamic measurement
  should handle it for free, but verify with the forced-height
  diagnostic that your worst-case content fits under
  `TRAY_HEIGHT_MAX`.
- A future `.ps-tray` style change drops `overflow: hidden` — at
  that point `getBoundingClientRect().height` would also work, but
  there's no reason to switch off `scrollHeight`; it's strictly
  more robust.

### Why we don't trust fixed heights anymore

We tried fixed heights (`TRAY_HEIGHT_EMPTY = 250`,
`TRAY_HEIGHT_WITH_LAST_SNAP = 620`) on the dev machine where they
were measured. They survived for a few weeks, then on a different
machine — different DPI, different font fallback metrics — the
populated height landed visibly taller than the actual content,
leaving an empty band at the bottom of the popover. There's no
constant that's right on every machine because the constant isn't
capturing what we actually want (content extent under the real
loaded font); it's capturing what we measured once on one
configuration. Fixing the underlying measurement is the durable
answer.

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
