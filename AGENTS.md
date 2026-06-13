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
- **Never suggest wiping the user's database** (even on a dev machine). The
  pwrsnap.db at `~/Library/Application Support/PwrSnap/pwrsnap.db` contains
  real captures the user cares about. If a migration / schema bug bricks
  startup, the fix is in code — make the migration self-heal, detect drift,
  add a repair pass — NOT to tell the user `rm pwrsnap.db*`. Same rule for
  any other persisted state: captures dir, cache dir, settings.json, secrets.
  Suggesting "blow it away" is a non-starter.
- To reproduce the Linux GitHub Actions Desktop E2E job locally, prefer
  `pnpm test:desktop-e2e:docker` from the repo root (or pass
  `--test '<pattern>' --iterations 30` for flake hunting). This runs the
  Linux/xvfb subset on Docker's native Linux platform; macOS-only clipboard,
  tray, menu-bar, screen-capture, and AppKit windowing specs are expected to be
  skipped. Add `--platform linux/amd64` only when investigating
  architecture-specific GHA parity.

## Agent Instruction Files

- Keep a sibling `CLAUDE.md` symlink next to every `AGENTS.md`, pointing at
  that `AGENTS.md`, so Codex and Claude read the same local guidance.
- Project root: `CLAUDE.md → AGENTS.md` (this file).

## Brand and Identity

- Product name is **PwrSnap** — one word, two capitals (`Pwr` + `Snap`),
  rendered as `Pwr` in primary text + `Snap` in the brand accent. Never insert
  whitespace between the halves; never lowercase the second capital.
- Company is **PwrDrvr LLC**. License is **MIT** (see [LICENSE](LICENSE)) —
  every `package.json` in the workspace declares `"license": "MIT"`; the
  policy gate [scripts/check-package-license-policy.mjs](scripts/check-package-license-policy.mjs)
  fails the build if any package drifts.
- Visual language follows the design system in `design/` — pure-black
  surfaces (`#000000`), tangerine accent (`#ff8a1f`), Geist + Geist Mono.
  PwrAgent is the system of record for PwrDrvr brand tokens; PwrSnap mirrors
  its `:root` palette in [design/ds/colors_and_type.css](design/ds/colors_and_type.css)
  and [apps/desktop/src/renderer/src/styles/tokens.css](apps/desktop/src/renderer/src/styles/tokens.css).

## Dependency licensing — what we ship and what we even look at

PwrSnap is **MIT** licensed. The
[scripts/check-package-license-policy.mjs](scripts/check-package-license-policy.mjs)
gate covers what we **ship**; this section covers what we even **look at**.

### Hard rule: do not read source for restrictively-licensed projects

If a project's license is source-available-but-not-open-source — anything
with commercial-use restrictions, no-derivatives clauses, no-competition
clauses, employee-count or revenue tiers, the Business Source License (BSL)
until it converts, the Server Side Public License (SSPL), the Commons
Clause, or any custom license that isn't on the always-allowed list below
— do **not**:

- Add it as a runtime or build dependency.
- Clone, browse, or open its source repository.
- Reference its public API shape, file layout, schema, or implementation
  patterns from prior knowledge.
- Translate its docs/examples into PwrSnap code.

This protects PwrSnap from contamination claims. Even line-of-sight to
restricted source can create derivative-work exposure when we later ship a
feature in the same domain. If you've previously read a now-banned
project's source, **don't write PwrSnap code in the same domain from
memory** — note the conflict and ask before proceeding.

### Currently banned (do-not-look list)

| Project | License | Why |
|---|---|---|
| **Remotion** (`remotion`, `@remotion/*`) | Remotion License (source-available, commercial-use restricted) | Initial Phase 6 sizzle-reel plan referenced it; retracted on license review. Do not browse [github.com/remotion-dev/remotion](https://github.com/remotion-dev/remotion), do not `npm install` it, do not copy patterns from its docs into PwrSnap. Phase 6 composition engine is now an open research item — see plan §"Phase 6". |

Extend this table whenever a new candidate hits the same problem class.

### Always-allowed licenses

MIT, BSD (2-clause / 3-clause), Apache-2.0, MPL-2.0, ISC, 0BSD, Unlicense,
CC0. Anything else: **pause and confirm with the user** before reading the
project's source or adding the dep.

## Codex App Server is the AI brain

**All AI features in PwrSnap go through the user's installed Codex CLI / Codex
Desktop instance over stdio JSON-RPC.** This is the schtick — annotation,
description generation, tag suggestion, smart filenames, sensitive-data
review, voice describe, sizzle-reel composition. No direct OpenAI / Anthropic
/ xAI calls in `apps/desktop`.

### Protocol package

TypeScript types for the protocol are consumed from the published
**[`@pwrdrvr/codex-app-server-protocol`](https://www.npmjs.com/package/@pwrdrvr/codex-app-server-protocol)**
package (pinned to an exact version in
[apps/desktop/package.json](apps/desktop/package.json) — currently `0.133.0`).
The package version tracks the Codex CLI release it was generated from, so the
pinned number tells you which Codex protocol surface PwrSnap is built against.
Import the v2 surface via `@pwrdrvr/codex-app-server-protocol/v2`.

The package is **generator output** maintained in its own repository
([github.com/pwrdrvr/codex-app-server-protocol](https://github.com/pwrdrvr/codex-app-server-protocol)),
not in this tree — do not vendor it back in or hand-edit its types. PwrAgent
consumes the same package, so the two stay version-aligned.

To move PwrSnap to a newer Codex protocol surface: publish a new
`@pwrdrvr/codex-app-server-protocol` version from that repo (matching the
target Codex CLI version), then bump the exact pin in
`apps/desktop/package.json`. Bump whenever Codex Desktop autoupdates or a new
protocol surface lands that PwrSnap wants to consume.

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

## Bundle format v2 — the only bundle format (v1 fully removed)

The v2 layer-tree bundle format (multi-source canvas, layer tree,
contextual effects, private-UTI clipboard) is **the only format**.
`persistCaptureFromTempV2` is the single write entrypoint in
[capture-handlers.ts](apps/desktop/src/main/handlers/capture-handlers.ts);
the [coordinator.ts](apps/desktop/src/main/render/coordinator.ts) read
path is v2-only and **throws** for any non-v2 record.

The entire v1 path — the v1→v2 doctor (lazy/eager/reconcile), the v1
linear compositor (`compose()` in `compose.ts`), `overlays-repo.ts`,
the `overlays:*` IPC verbs, the renderer's v1 model arm + doctor
banners, `legacy-bundle-migration.ts`, the v1 bundle read handle, the
v1 manifest/overlays zod schemas (`bundle-manifest-schema.ts`), and the
`overlays` SQLite table (migration `0020_drop_overlays_table.sql`) —
has been deleted. `compose.ts` survives only as a holder for the v2
SVG rasterize helpers (`arrowSvgForV2` etc.) that `compose-tree.ts`
imports; the v2 compositor is `composeV2` in `compose-tree.ts`.

Notes for anyone touching this area:

- **`bundle_format_version` still exists as a column** and reads of it
  are fine, but it is always `2` for image captures. **Videos carry a
  vestigial `bundle_format_version = 1`** (they have no layer-tree
  bundle and render via the `pwrsnap-capture://` protocol, not the
  compositor) — so a `WHERE bundle_format_version = 1` count is NOT a
  "v1 captures remain" signal. Nothing reads the flag for videos.
- A pre-v2 `.pwrsnap` opened from Finder now fails to parse — v1 is
  unsupported, by design.
- `Overlay` / `OverlayRow` (in `overlay-schemas.ts`) are **kept** — v2
  `VectorLayer.shape` is an `Overlay`, and the editor's draw→layer
  adapter (`overlayToLayer.ts`) still uses them. Don't confuse these
  with the deleted v1 *bundle* schemas.

See
[docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md](docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md)
§"Shipping Status" for the rollout history.

## Bake render cache — orphans are tolerated, not swept

Content-addressed cache; `BAKE_PIPELINE_VERSION` is in the hash, so a
bump orphans existing files. We do NOT auto-sweep — see
[docs/solutions/2026-05-28-bake-render-cache-orphans.md](docs/solutions/2026-05-28-bake-render-cache-orphans.md)
for rationale, when-to-bump rules, and the adjacent-code map.

## Startup profiling harness — `PWRSNAP_STARTUP_PROFILE=1`

Env-gated, kept wired in production builds. Captures main + renderer
CPU profiles, heap snapshots, and a ms-relative startup-marks timeline
(window-show source, paint lifecycle, per-command timings). Profiling
runs are passive observers: global hotkeys, boot GC, and filename
maintenance are skipped — a profiling instance on a cloned userData
that grabs ⌘⇧C steals real captures into the throwaway clone DB
(capture bundles live in `~/Documents/PwrSnap`, OUTSIDE userData).
Run recipe, findings from the 2026-06 black-window investigation, and
the clone-safety checklist:
[docs/solutions/2026-06-12-library-startup-black-window-profiling.md](docs/solutions/2026-06-12-library-startup-black-window-profiling.md).

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
  sizzle-composer preview player runs in a sandboxed renderer; render
  orchestration runs in a Node child process. Lifecycle test enforces.
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

## Tray + float-over popover sizing — outer `inline-block` measurer

**Both popovers (the tray and the post-capture float-over) size
themselves dynamically by measuring an `inline-block` wrapper that
sits OUTSIDE the styled container, then telling main to
`setContentSize` the BrowserWindow to match. The two surfaces use
identical machinery on purpose — fixes flow naturally between them.
Do NOT revert to hardcoded heights, and do NOT measure the styled
container itself.**

Implementations:

- Tray: [TrayMenu.tsx](apps/desktop/src/renderer/src/features/tray/TrayMenu.tsx)
  → dispatches `pwrsnap:tray:resize`. Main listens in
  [tray.ts](apps/desktop/src/main/tray.ts) (`wireTrayResizeChannel`),
  clamped to `[TRAY_HEIGHT_MIN=200, TRAY_HEIGHT_MAX=880]`.

- Float-over: [FloatOverHost.tsx](apps/desktop/src/renderer/src/features/float-over/FloatOverHost.tsx)
  → dispatches `float-over:resize`. Main listens in
  [float-over.ts](apps/desktop/src/main/float-over.ts) (`wireFloatOverResizeChannel`).
  Posts the measured wrapper height directly. Do not add transparent
  shadow padding to the measured height — BrowserWindow hit testing
  uses the full rectangular content bounds, so invisible padding below
  the toast blocks clicks on the Dock / windows underneath. The float-
  over uses the same native `hasShadow: true` approach as the tray for
  shadow outside the renderer's measured content.

The shape of the renderer code is the same in both:

```tsx
const containerRef = useRef<HTMLDivElement | null>(null);
useLayoutEffect(() => {
  const el = containerRef.current;
  if (el === null) return;
  let posted = -1;
  const post = (): void => {
    const rect = el.getBoundingClientRect();
    const target = Math.ceil(rect.height);
    if (target === posted) return;
    posted = target;
    // dispatch the resize event...
  };
  post();
  const ro = new ResizeObserver(post);
  ro.observe(el);
  return () => ro.disconnect();
}, []);

return (
  <div ref={containerRef} style={{ display: "inline-block", width: "100%" }}>
    <div className="ps-tray">{/* or .fo */}…</div>
  </div>
);
```

### Why the wrapper, and why `inline-block`

The styled containers (`.ps-tray`, `.fo`) carry `overflow: hidden`
to keep painting tucked inside their `border-radius`. So does
`body`. Inside that nested `overflow: hidden` chain, Chromium
returns the *clipped* extent for both `getBoundingClientRect`
and `scrollHeight` on the styled element — measure either, post
it, and the ResizeObserver reads back the same clipped value next
tick. Silent feedback loop; the popover gets stuck at whatever
short size we first posted (often a fallback-font measurement
taken before Geist swapped in).

An `inline-block` wrapper sitting OUTSIDE that chain is content-
sized in both axes by layout. Parent `overflow: hidden` only
affects painting, never layout, so the wrapper retains its natural
height even when its rendered pixels are clipped. `gBCR` on it
returns the unconstrained content height regardless of how main
is currently sizing the window. No font-ready re-measure, no
image-load handlers, no child-coordinate tricks — the wrapper is
out of the loop.

### Why we don't bother with extra escape hatches

The float-over has shipped with this exact code for a while. It
works without:
- `document.fonts.ready` hooks (the ResizeObserver naturally
  catches the swap reflow because the inline-block wrapper grows
  when Geist takes over)
- `<img>` `load` listeners (preview wrappers pin their box; no
  reflow on decode)
- Re-running on dependency change (the observer follows whatever
  the body renders)

Keeping the tray's code minimal and identical to the float-over's
is part of the load-bearing design — they should drift together if
they drift at all.

### Tuning + diagnostics

The **forced-height diagnostic** still works: temporarily replace
the resize handler in [tray.ts](apps/desktop/src/main/tray.ts)
(`wireTrayResizeChannel`):

```ts
const clamped = 800;  // pin to whatever you want to test
```

Useful when you suspect the renderer's measurement is wrong
(diagnose by ruling out the IPC path) or to see the worst-case
content extent across structural shapes.

If a future content change pushes either popover near its ceiling,
bump the ceiling in main rather than fighting the measurement. The
tray anchors top-down from the menubar; the float-over anchors
bottom-right. Neither pushes off-screen as it grows — Electron
clamps to workArea.

### Three prior wrong answers, for reference

- **Fixed heights** (`TRAY_HEIGHT_EMPTY=250`,
  `TRAY_HEIGHT_WITH_LAST_SNAP=620`). Tuned on one machine, mis-fit
  elsewhere. There's no constant that's right on every font/DPI
  configuration.

- **`getBoundingClientRect().height` directly on `.ps-tray`.**
  Stuck at fallback-font heights even after Geist loaded — feedback
  loop through `.ps-tray { overflow: hidden }`.

- **`scrollHeight` on `.ps-tray`.** Same feedback loop, deeper.
  Worked on machines where the popover never started clipped (so
  the loop never engaged); failed on the original tuning machine
  where it did.

All three encode the same lesson: as long as we measure the styled
container, we're fighting browser-implementation quirks of
`overflow: hidden`. Measure an `inline-block` wrapper outside the
clipping chain and the entire class of bug disappears.

### When to revisit

- A new top-level section gets added or content becomes genuinely
  variable — the dynamic measurement should handle it for free, but
  verify with the forced-height diagnostic that your worst-case
  content fits under the main-side ceiling.
- The styled container loses `overflow: hidden` — at that point
  measuring it directly would also work, but there's no reason to
  switch off the wrapper pattern; it's strictly more robust and
  keeps the tray and float-over symmetrical.

## Settings substrate — every setting + secret goes through one place

**All user-configurable state lives in `DesktopSettingsService` +
`DesktopSecretStore` and travels over the command bus. Don't open a
new IPC channel, don't write a sibling JSON file, don't keep a
plaintext secret on disk.**

Implementation:
[apps/desktop/src/main/settings/desktop-settings-service.ts](apps/desktop/src/main/settings/desktop-settings-service.ts) +
[apps/desktop/src/main/settings/desktop-secret-store.ts](apps/desktop/src/main/settings/desktop-secret-store.ts) +
[apps/desktop/src/main/handlers/settings-handlers.ts](apps/desktop/src/main/handlers/settings-handlers.ts).
Architecture notes:
[docs/solutions/2026-05-12-settings-substrate.md](docs/solutions/2026-05-12-settings-substrate.md).

Rules:

- **Single schema in shared.** `Settings` and `SettingsPatch` live in
  [packages/shared/src/protocol.ts](packages/shared/src/protocol.ts).
  Renderer + main both import from `@pwrsnap/shared`. **Never
  re-declare** a Settings shape elsewhere.
- **Adding a field is a one-line change.** Extend the right nested
  object (`codex.*`, `ai.*`, `hotkeys.*`, `experimental.*`, etc.), give
  it a default in `defaultSettings()`, fill it from older files in
  `parseV1`. **Don't bump `schemaVersion` for additive changes** —
  bump only when the on-disk shape changes incompatibly. The legacy-
  shape catalog in the service exists for that case; it must remain
  ordered newest-first and corruption must quarantine to
  `pwrsnap-settings.corrupt-<iso>.json` (never silently swallow).
- **Atomic write.** Service writes through `writeFile(tmp) → rename`.
  Never `fs.writeFile` to the final path directly — a crash mid-write
  corrupts the file. Same rule for `pwrsnap-secrets.bin`.
- **Serialized writes.** `DesktopSettingsService.write()` awaits an
  internal promise chain so two concurrent renderer patches don't
  interleave reads. Use the same pattern in `DesktopSecretStore`. The
  queue uses `.catch(() => undefined).then(task)` so a rejected write
  doesn't run the next task on the rejection branch.
- **Broadcast on every write.** Every successful settings or secret
  write emits `events:settings:changed` with payload
  `{ settings, secrets: Record<DesktopSettingsSecretName, SecretStatus> }`
  to every BrowserWindow. The renderer hook reads once on mount, then
  waits for broadcasts — no polling.
- **`undefined` ≠ `null` ≠ `""`.** `SettingsPatch` is a deep-Partial.
  `undefined` / missing key = leave alone. Explicit value (including
  `false`, `0`, `""`, `null` where the type allows) = write.
  `exactOptionalPropertyTypes` enforces.
- **All secrets via `safeStorage`.** Plaintext never crosses the IPC
  boundary. The renderer only ever sees `SecretStatus = { configured,
  lastSetAt }`. `DesktopSecretStore.getValue()` is the only plaintext
  accessor and is main-only — **never register it on the bus.** If
  `safeStorage.isEncryptionAvailable() === false`, the store throws
  `SecretUnavailableError`; the handler returns `Result.err` with
  `kind: "settings", code: "secret_unavailable"`. **Never fall back to
  plaintext.** A unit test grep-asserts the plaintext never appears in
  `pwrsnap-secrets.bin`.
- **Validate at the bus boundary.** Per-verb validators in
  [apps/desktop/src/main/handlers/settings-validators.ts](apps/desktop/src/main/handlers/settings-validators.ts)
  reject unknown secret names, oversize values (>64KB), unknown
  `SettingsPage`, `null` over non-nullable string fields, etc. Add a
  validator when you add a verb.
- **Renderer reads via context, not the hook directly.** `useSettings`
  is called once at the `SettingsApp` root and provided via
  `SettingsContext`. Pages use `useSettingsContext()`. One subscriber,
  one initial fetch per window.
- **Late resolutions are dropped.** `patch / refreshCodex /
  replaceSecret / clearSecret` each carry a monotonic `seq` ref —
  a stale dispatch's resolution doesn't clobber a newer call's state.
  Mirror the pattern if you add a new mutating callback.
- **Window-to-renderer navigation goes through a typed event channel,
  never `executeJavaScript`.** Use `EVENT_CHANNELS.settingsNavigate`
  (or add a new channel) — string interpolation into renderer JS is a
  sandbox crack.
- **Codex discovery cache invalidates on `codex.*` writes.** The 30s
  in-memory snapshot cache must be cleared inside the write task when
  `patch.codex !== undefined`. Without this, the "Using" badge lies
  for up to 30s after pinning a path.

What this substrate is **not for**: ephemeral renderer state (sidebar
expanded/collapsed, last-selected capture id), per-capture metadata
(belongs in SQLite + overlays), workspace-scoped caches (belongs in a
per-workspace cache table). When in doubt: if the value should
survive a relaunch *and* a renderer can change it, it belongs in
Settings. If a renderer reads it once and discards on close, it
doesn't.

## Pull Requests

- Conventional Commit-style PR titles: `type(scope): short description`.
- Scopes that match the project area:
  - `desktop` — the Electron app itself (main, preload, renderer).
  - `protocol` — the Codex App Server protocol package dependency.
  - `design` — UI work tied to the design system.
  - `release` — packaging, signing, notarization, distribution.
  - `docs` — documentation only.
  - `tests` — test coverage / fixtures / infrastructure.

## Release / Distribution

- MIT licensed (see [LICENSE](LICENSE)). Every workspace `package.json`
  declares `"license": "MIT"`; the policy gate
  [scripts/check-package-license-policy.mjs](scripts/check-package-license-policy.mjs)
  fails the build if any package drifts.
- `THIRD_PARTY_LICENSES` is load-bearing release metadata. Do not hand-edit it
  except through `pnpm licenses:generate`, and do not remove the shipped
  notices/changelog resources from packaged builds. See
  [docs/third-party-license-notices.md](docs/third-party-license-notices.md).
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

## Node / native module ABI hygiene

Always enter the repo with nvm before installing dependencies:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm install
```

The root `preinstall` script checks that `node` exactly matches `.nvmrc` and,
on local machines with `~/.nvm`, that the active Node binary is coming from
nvm. Do not bypass this check. Native modules are sensitive to the Node/Electron
ABI they were built against; installing with the wrong Node can leave
`better-sqlite3.node` built for the wrong `NODE_MODULE_VERSION` and Electron
will fail at runtime with a message like:

```text
was compiled against a different Node.js version using NODE_MODULE_VERSION ...
```

If that happens, switch to the pinned nvm Node and rebuild Electron native
dependencies from the repo root:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm rebuild:electron-native
```

## better-sqlite3 + Electron native binding repair

PwrSnap uses `better-sqlite3`, which ships a native `.node` binary. The
system Node ABI and Electron ABI can diverge, especially after switching
worktrees, updating Electron, or running `pnpm install` under a different Node
version. The usual symptom during `pnpm --filter @pwrsnap/desktop dev` is:

```text
better_sqlite3.node was compiled against a different Node.js version
NODE_MODULE_VERSION <old>. This version of Node.js requires NODE_MODULE_VERSION <new>.
```

Do not chase this as a database bug. Repair the native sidecar from the repo
root:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm install
pnpm rebuild:electron-native
```

The script keeps two binaries on purpose:

- `better-sqlite3/build/Release/better_sqlite3.node` stays compiled for system
  Node so unit tests and scripts can `require("better-sqlite3")`.
- `better-sqlite3/electron-native/better_sqlite3.node` is compiled/downloaded
  for Electron and is what the app loads at runtime.

For release/package work, the Electron sidecar must be built for the target
architecture, not necessarily the host architecture. The script honors
`npm_config_arch` / `npm_config_target_arch` before falling back to
`process.arch`, and `apps/desktop/src/main/persistence/native-binding.ts`
ignores the sidecar unless its metadata matches the running Electron version,
`better-sqlite3` version, and `process.arch`.

Do not "fix" the ABI mismatch by copying the Electron binary over
`build/Release`, because that breaks Node-based tests with the inverse
`NODE_MODULE_VERSION` mismatch.
