# Editor border-outline flake: a draw racing `settings:read` drops the whole style block

**Date:** 2026-08-31
**Symptom:** `editor-border-outline.spec.ts` › "Auto samples a WHITE
background into a black border" failed roughly once per ten local runs
on a busy macOS desktop (observed 2026-08-29, branch
`claude/nice-hofstadter-436476`), passing on immediate retry. The
failing run's error output was not captured at the time.
**Fixed in:** the commit series landing this doc (`settledToolStyles`).

## Root cause

The edit toolbar is fully interactive before the window's
`settings:read` IPC resolves. `useEditorToolState` reads tool styles
from `useSettings()`, which starts `null` on every hook mount. For
Library Focus the relevant instance is the LIFTED one created at the
Library window root (`Library.tsx` — it mounts once per window, at
app start, and is passed down through Stage → Editor/EditToolbar), so
the race window opens once per window launch — NOT on every Focus
entry; standalone editor windows open their own window per mount.
While styles were null, `selectActiveStyle` degraded to a pointer
placeholder. Its comment claimed "the editor's toolbar is disabled
until settings resolve" — **no such disable exists**; a `data-tool`
button click and a canvas drag both work in that window.

A drawing-tool commit then read `effectiveToolState.activeStyle` from
its render closure:

```ts
const arrowStyleSrc =
  effectiveToolState.activeStyle.tool === "arrow"   // "pointer" while loading!
    ? effectiveToolState.activeStyle.style
    : null;
```

With `arrowStyleSrc === null` the commit skips the **entire** style
block: no `outline` field (so a Border: Auto arrow renders the legacy
white halo — on the spec's white background, exactly the failure), no
`endStyle` / `thickness`, and `color: "auto"` bypasses
`resolveToolColor` so the stem persists the unresolved slot. The
deterministic replay's received value was:

```
[["white", "var(--accent, #ff8a1f)"]]   // expected [["black", "#ff8a1f"]]
```

Nothing re-samples an unmoved row, so the failure is permanent for
that arrow — the 15s `expect.poll` cannot converge. The same skip
exists (existed) in the shape, highlight, and text commits.

The window is one local IPC round-trip (~5–20 ms idle), and the spec
reaches its first draw ~1.5 s after the window's settings read
dispatches — which is why
the flake needed a *busy* machine and never reproduced organically in
this investigation: 0/300 across an idle desktop run (60), a desktop
run under 12 CPU spinners (90), the Tart macOS VM serial + 4-worker
runs (120), and Docker/xvfb (30).

## The fix (two layers)

**1. `activeStyle` never lies.** Factory tool-style defaults were
hoisted into `@pwrsnap/shared` (`defaultEditorToolStyles()` — now also
the source for main's `defaultSettings()` and the editor's
selection→style projection fallbacks, which used to be hand-inlined
drift-prone copies), and the hook's merged styles fall back to them
while `settings:read` is in flight. There is no pointer-placeholder
`activeStyle` anymore: every consumer — draft previews, the blur
memos, `shapeKind` capture at pointerdown, `onAnnotationPlaced` —
sees real (default) styles from the first frame. A future call site
that forgets the settle-await commits factory defaults, not a
style-less corrupted row.

**2. Commits await the user's settings.** The hook exposes
`settledToolStyles(): Promise<EditorToolStyles>` — resolves with the
live merged styles as soon as settings land (immediately when
loaded), bounded at 3 s (`TOOL_STYLES_SETTLE_WAIT_MS`), after which
it resolves factory defaults, warns once, and LATCHES so later
commits against a wedged `settings:read` don't re-park 3 s each. One
shared deferred + one timer per unsettled window, both torn down when
settings land. The arrow / shape / highlight / blur / text commits in
`Editor.tsx` await it — and they capture their draft fields and
`setDraft(null)` BEFORE the first await, so a parked commit can't
wipe a second in-flight gesture's draft, and a re-entrant
`commitText` (Enter then blur) hits the null-draft guard instead of
persisting a duplicate.

Behavior in the common case is unchanged (settings are loaded; the
promise resolves in a microtask); in the race window the commit waits
milliseconds and persists the styles the user actually configured.

## Deterministic replay + fault injection

`settings:read` honors **`PWRSNAP_E2E_SETTINGS_READ_DELAY_MS`** (only
under `PWRSNAP_E2E=1`; the E2E launch fixture strips it from
inherited shell env so it is opt-in per launch) — it holds EVERY
settings read open so a spec can land a draw inside the race window.
The pin is `editor-border-outline.spec.ts` › "a draw racing settings
load still gets the user's configured border": it seeds a settings
file with the arrow Border set to WHITE and asserts the committed
halo is white — the awaited USER value. Every regression path lands
elsewhere: without the settle-await the commit stamps factory
defaults, which sample the white background into a BLACK halo; a full
revert to the pre-fix style-drop renders the unresolved
`var(--accent, #ff8a1f)` stem. Timing corridor: the knob's countdown
starts at the LIBRARY WINDOW's `settings:read` (launch), so the
2500 ms delay sits above launch→draw (~1.5 s locally) and below the
3 s settle bound (past which the commit deliberately degrades to
defaults — black — failing the pin loudly). On a runner too slow to
land the draw inside the hold the pin passes without exercising the
race; the spec annotates the measured launch→draw time so that
vacuity is visible in reports. The original single-method pin was
verified red on the pre-fix build.

The knob generalizes: any "renderer surface is interactive before
settings resolve" hypothesis can now be tested deterministically
instead of by loading the machine and praying.

## Disproven hypotheses (measured, worth keeping)

- **Stale-closure draft at pointerup via input-queue drain.** Theory:
  a main-thread stall queues the pointermoves + pointerup; they drain
  back-to-back with no React render between (input tasks outrank the
  scheduler's MessageChannel task), so `onPointerUp` sees the
  pointerdown-era draft (`to === from`) and skips the commit as a
  sub-`MIN_DRAG_LENGTH` click. **Cannot happen under Playwright:** a
  busy-loop injected inside the first drag pointermove showed every
  subsequent `Input.dispatchMouseEvent` ack *waits for the renderer
  main thread* — post-stall moves carried post-stall `timeStamp`s and
  a React commit (MutationObserver) landed between every pair of
  moves. CDP-paced input cannot pile up behind a stall. (Real-device
  input still can; if a user-reported "my arrow didn't draw during a
  hitch" ever shows up, this mechanism is where to look first.)
- **Stale `canvas.boundingBox()` vs the entrance animation.** The
  `psl-focus-in` scale settles ~150 ms after the toolbar becomes
  visible and moves the rect by ~1% (probe: x drifts 22.2→17.5 px,
  w 1035.6→1045.0 px). Draw fractions of 0.2–0.8 stay deep inside the
  canvas under any point of that drift; it cannot change what a draw
  commits (it can shift *where* by ~1%, which these assertions don't
  read). The class from
  [2026-08-28-text-outline-stale-canvas-scale.md](2026-08-28-text-outline-stale-canvas-scale.md)
  is real but not this bug.
- **Sampler/CORS chain failure.** The commit `await`s
  `ensureOutlineSampler` and the pwrsnap-capture protocol always
  serves `access-control-allow-origin: *`; a load failure null-caches
  but is retried by the next `ensure`. No nondeterminism found, and
  the sampler was never even reached in the failing path (the style
  block skip happens first).

## Adjacent findings

- `git stash` discipline aside: Playwright wipes `test-results/` at
  run start, so a failing run's artifacts are destroyed by the passing
  retry. When a flake matters, re-run with `--trace retain-on-failure`
  *before* the retry habit kicks in.
- The stale `selectActiveStyle` comment (toolbar-disabled claim) is
  corrected in the same series; commit-time persistence and render-time
  preview now have explicitly different rules for reading activeStyle.
