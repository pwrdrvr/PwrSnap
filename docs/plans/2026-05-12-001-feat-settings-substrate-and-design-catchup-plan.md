---
title: Settings substrate + design-handoff catch-up
type: feat
status: completed
date: 2026-05-12
pr: https://github.com/pwrdrvr/PwrSnap/pull/20
---

# Settings substrate + design-handoff catch-up

## Overview

The design team shipped a refreshed handoff bundle (now extracted to
[design/](../../design/)). Two surfaces moved:

1. **Tray header rework.** The right-side `IDLE · LOCAL` status pill is gone.
   In its place: a Library button + a Settings button + a thin separator +
   a compact `IDLE` pill. See [design/src/TrayMenu.jsx](../../design/src/TrayMenu.jsx)
   and the new `.ps-tray__hdr-*` rules in
   [design/src/library.css](../../design/src/library.css).
2. **New Settings surface — net-new screen.** Full sidebar nav with four
   category groups (General / Capture / Library / Advanced) and three
   fully-built pages in the design (Output, Hotkeys, AI Providers). See
   [design/PwrSnap Settings.html](../../design/PwrSnap Settings.html),
   [design/src/Settings.jsx](../../design/src/Settings.jsx), and
   [design/src/settings.css](../../design/src/settings.css).

Design tokens are unchanged — `design/ds/colors_and_type.css` is
byte-identical to the prior handoff and to PwrSnap's renderer
`tokens.css`. No token work in this plan.

This plan ships the **substrate** — a real Settings window backed by a
real settings service and IPC — wired to enough screens to be useful
today (Hotkeys read-only + AI Providers + About + Experimental) and to
catch the implementation up with the design without committing to the
full screen catalog yet. The remaining sidebar items get honest
"Coming soon" placeholders.

## Problem Statement / Motivation

PwrSnap has no Settings UI today. The codex-discovery code was lifted
from PwrAgnt in Phase 0.5 (`apps/desktop/src/main/settings/codex-discovery.ts`)
but is only consumed by `codex-app-server/stdio-transport.ts` — there is
no surface for the user to see which Codex binaries were detected, pin
one, or supply a Grok API key. The Phase 1 hotkeys are registered but
invisible to the user. The new file-format experiment slated for Phase
3 has no home to land in.

The design team's refresh anticipated all of this and produced the
specific window we need. We should match it visually, but keep scope
honest: ship the four pages that map to existing code today, leave the
rest of the sidebar as labeled placeholders so the design isn't a lie,
and write the persistence layer well so adding more pages later costs
the next person nothing.

The tray-header rework is a no-brainer companion: it's where users will
discover the Settings window from, and it's a four-file change that
should ride along.

## Proposed Solution

Six independent slices, each landable as a single PR with tests:

| Slice | What lands | Risk |
|---|---|---|
| A | Tray header chrome (Library + Settings buttons + IDLE pill) | Tiny — visual only, no service changes |
| B | Settings BrowserWindow + Stage routing + empty shell (sidebar renders, pages are stubs) | Low — copies the Library window pattern |
| C | Settings service + secret store + persistence + IPC handlers + `events:settings:changed` | Medium — new persistent state; touches the bus |
| D | Hotkeys page (read-only) + About page + Experimental page | Low — pure renderer |
| E | AI Providers page wired to codex-discovery + Grok keychain | Low/Medium — the user-visible payoff slice |
| F | `docs/solutions/` capture, buildout plan + `CLAUDE.md` updates | None — docs |

Each slice depends only on the slices above it. Slice A can ship before
B (the Settings button can no-op or open a placeholder window for one
release). Slice E depends on C. D and E can ship in either order once C
lands.

## Technical Approach

### Shared assumptions (apply to every slice)

- **No design-token changes.** `apps/desktop/src/renderer/src/styles/tokens.css`
  already matches `design/ds/colors_and_type.css` exactly (modulo the
  `@fontsource` swap noted in the file). Do not touch it.
- **No shared package.** Per the buildout plan §"Decision 4" and
  PwrSnap CLAUDE.md, settings/secret-store/discovery code is mirrored
  from PwrAgnt by copy with attribution comments, never extracted to a
  shared package.
- **Reuse existing scaffolding.** Window construction reuses
  `baseWebPreferences`, `rendererTarget`, `loadRenderer` in
  [apps/desktop/src/main/window.ts](../../apps/desktop/src/main/window.ts).
  The renderer stays single-entry — App.tsx branches on
  `window.location.hash#stage=settings`.
- **All IPC through the command bus.** No new `ipcMain.handle` calls —
  register handlers on `command-bus.ts` with the existing
  `Result<Res, PwrSnapError>` envelope.

### Slice A — Tray header chrome

**Files**

- `apps/desktop/src/renderer/src/features/tray/TrayMenu.tsx` — at the
  current `ps-tray__status` site (line 285), replace the `IDLE · LOCAL`
  block with the design's `.ps-tray__hdr-actions` block: Library
  icon-button, Settings icon-button, `.ps-tray__hdr-sep`, then a
  compact `.ps-tray__status` rendering just `IDLE`. Leave the existing
  brand-mark / hero icon usage untouched — no logo change.
- `apps/desktop/src/renderer/src/styles/app.css` — port the
  `.ps-tray__hdr-actions/-btn/-sep` rules verbatim from
  [design/src/library.css](../../design/src/library.css) lines 149–172.

**Behavior**

- Library button → `await dispatch("library:open", {})` (verb already
  exists — see preload `library:open`).
- Settings button → `await dispatch("settings:open", {})`. **For Slice
  A this verb is allowed to be a stub** that registers in
  `apps/desktop/src/main/handlers/settings-handlers.ts` and either
  no-ops or opens a placeholder window. Slice B fills it in.
- Hover/active states from `.ps-tray__hdr-btn` rules — color shifts to
  `--accent-bright` on hover.

**Tests**

- Renderer unit: assert the two icon-buttons render and dispatch the
  right command names when clicked. Use the existing pattern from
  `apps/desktop/src/renderer/src/features/tray/__tests__/` (or create
  the dir).
- E2E (`apps/desktop/e2e/tray-sizing.spec.ts` already exercises tray
  measurement — verify the new chrome doesn't break the wrapper-measure
  pipeline. Tray height ceiling stays `880`.)

### Slice B — Settings BrowserWindow + Stage routing + empty shell

**Files**

- `apps/desktop/src/main/window.ts`:
  - Extend the `rendererTarget` `Stage` union with `"settings"`.
  - Add `createSettingsWindow(): BrowserWindow` after `createMainWindow`,
    modeled on the library window (lines 90–168): singleton via module
    ref, `titleBarStyle: "hiddenInset"`, `trafficLightPosition: { x: 20,
    y: 18 }`, `backgroundColor: "#0a0908"`, `webPreferences:
    baseWebPreferences`, initial frame ~960×620 (matches the design's
    composition). Resizable is fine; do NOT call `setMinimumSize(0, 0)`
    unless we later wire dynamic content sizing.
  - Export a `findSettingsWindow()` helper alongside
    `findMainLibraryWindow()`.
- `apps/desktop/src/main/handlers/settings-handlers.ts` (new):
  - Register `bus.register("settings:open", ...)` — if window exists,
    focus it; otherwise `createSettingsWindow()`.
  - Wire this into `index.ts` at the existing handler-registration site
    (around line 295) next to the other `register*Handlers()` calls.
- `apps/desktop/src/main/index.ts`: bind a global shortcut `CmdOrCtrl+,`
  to `dispatch("settings:open", ...)`.
- `apps/desktop/src/renderer/src/App.tsx`: add `"settings"` to the Stage
  union (line 7) and add a `case "settings": return <SettingsApp />;`
  in the stage switch.
- `apps/desktop/src/renderer/src/features/settings/SettingsApp.tsx`
  (new): the shell — `<TitleBar />`, `<Sidebar />`, `<main>` with an
  active-page switch. Port the design's structure 1:1. The sidebar
  category catalog lives in `settings-categories.ts` so both Sidebar
  and routing read from the same array.
- `apps/desktop/src/renderer/src/features/settings/SettingsTitleBar.tsx`,
  `Sidebar.tsx`, `ComingSoon.tsx`, `settings-categories.ts` — small
  per-component files. Match design class names (`.pss__*`) so the
  ported CSS drops in cleanly.
- `apps/desktop/src/renderer/src/styles/settings.css` (new): port
  [design/src/settings.css](../../design/src/settings.css) verbatim
  except for any color literals (use tokens). Loaded by `SettingsApp`.

**Behavior**

- `settings:open` is idempotent — second call focuses, doesn't dup.
- Sidebar items mark themselves active via the URL hash
  (`#stage=settings&page=hotkeys`). All non-implemented items route to
  `<ComingSoon />`.
- ⌘W closes; ⌘, no-ops (already focused). ⌘1…⌘N jumps between sidebar
  items if cheap to add.

**Tests**

- Main: dispatch `settings:open`, assert exactly one settings window
  exists. Dispatch again — assert still one. Close it, dispatch — assert
  one new window.
- Renderer unit: SettingsApp renders the entire category list from
  `settings-categories.ts`; ComingSoon shows the page name.
- E2E: open via `__PWRSNAP_TEST__.dispatch("settings:open", {})`, assert
  window title contains "Settings", screenshot the sidebar.

### Slice C — Settings service + secret store + persistence + IPC

This is the structural slice. **Mirror PwrAgnt's patterns; write fresh
code.** Reference files (do NOT lift verbatim):

- `~/github/PwrAgnt/apps/desktop/src/main/settings/desktop-settings-service.ts`
  (1147 LOC — too big to lift; mirror the shape).
- `~/github/PwrAgnt/apps/desktop/src/main/settings/desktop-secret-store.ts`
  (safeStorage-backed binary sidecar).
- `~/github/PwrAgnt/docs/config-file-evolution.md` — the **legacy-shape
  catalog + path-based-edit philosophy**. Adopt this from day one even
  though the schema is small today.
- `~/github/PwrAgnt/apps/desktop/src/main/ipc/settings.ts` — handler
  shapes (NOT ipcMain wiring; we register on the bus).

**Files**

- `apps/desktop/src/main/settings/desktop-settings-service.ts` (new):
  - `read(): Promise<Settings>` — load `userData/pwrsnap-settings.json`,
    apply lazy migration through an ordered shape catalog (newest
    first), default sane values for missing fields. On corruption,
    rename to `.corrupt-<ts>.json` and return defaults. Atomic write
    via `writeFile → rename` from `node:fs/promises`.
  - `write(patch: Partial<Settings>): Promise<Settings>` — read,
    deep-merge patch (with `undefined` meaning "untouched", per the
    plan's `exactOptionalPropertyTypes` discipline), validate, write.
    Emits `events:settings:changed` to every renderer on success.
  - `getCodexDiscoverySnapshot(force?: boolean): Promise<DesktopCodexDiscoverySnapshot>`
    — wraps `discoverCodexCommands` with a 30-second cache; `force`
    bypasses the cache (used by the renderer's Refresh button).
- `apps/desktop/src/main/settings/desktop-secret-store.ts` (new):
  - `safeStorage`-encrypted blob persisted to
    `userData/pwrsnap-secrets.bin`. Single JSON object inside the
    encrypted blob, keyed by `DesktopSettingsSecretName` (typed union).
  - API: `getStatus(name)` → `{ configured, lastSetAt }`,
    `replace(name, value)`, `clear(name)`.
  - Never returns plaintext to renderers. Spawning Codex / Grok client
    pulls the plaintext value in main only, behind an internal
    accessor. Slice E doesn't need plaintext yet — masked status is
    enough.
- `packages/shared/src/protocol.ts`:
  - Extend `Settings` and `SettingsPatch` (currently 3 fields at lines
    65–80) to the shape below. Hoist `DesktopCodexDiscoverySnapshot` +
    `DesktopCodexDiscoveryCandidate` + `DesktopCodexCandidateSource`
    from `apps/desktop/src/main/settings/codex-discovery.ts` into a new
    file `packages/shared/src/codex-discovery.ts` and re-export from
    `index.ts`. The desktop module re-imports them and keeps its
    runtime types in sync.
  - Add new command entries: `settings:refreshCodexDiscovery`,
    `settings:replaceSecret`, `settings:clearSecret`,
    `settings:secretStatus`.

```ts
// packages/shared/src/protocol.ts (sketch — adapt to existing shape)
export type DesktopSettingsSecretName = "grokApiKey";

export type SecretStatus = {
  configured: boolean;
  lastSetAt: string | null;  // ISO-8601, never the value
};

export type Settings = {
  // Existing:
  codex: {
    mode: "auto" | "pinned";
    pinnedPath: string;          // empty string = no pin
    profile: string;             // CODEX_HOME; "" = default
  };
  ai: {
    enabled: boolean;            // Phase 4 kill switch
    consentAcceptedAt: string | null;
  };
  hotkeys: {
    // Phase 1 ships fixed hotkeys; this is read-only display today.
    // Persisted so a future "Edit" gesture has a home.
    quickCapture: string | null;  // null = unset
    region: string | null;
    window: string | null;
  };
  experimental: {
    v2FileFormat: boolean;
  };
  // Versioning header — survives downgrades via the legacy-shape catalog.
  schemaVersion: 1;
};

export type SettingsPatch = {
  codex?: Partial<Settings["codex"]>;
  ai?: Partial<Settings["ai"]>;
  hotkeys?: Partial<Settings["hotkeys"]>;
  experimental?: Partial<Settings["experimental"]>;
};
```

- `apps/desktop/src/main/handlers/settings-handlers.ts` (extend from
  Slice B): register the four new bus verbs above + `settings:read`
  and `settings:write` (currently declared but unhandled).
- `apps/desktop/src/preload/index.ts`: no change. Renderer goes through
  the generic `dispatch` and subscribes to `events:settings:changed` via
  `pwrsnapApi.on`. The channel name is already in
  `packages/shared/src/ipc.ts`.

**Behavior**

- First-launch reads return `defaultSettings()` and write a fresh
  `pwrsnap-settings.json` on the first `write`.
- A schema-version mismatch reads through the legacy catalog (one entry
  today, growing later) and rewrites in the new shape on the next
  `write` only — never on read.
- `events:settings:changed` payload is the full new `Settings`. Cheap
  for our size; renderers replace local state on receipt.

**Tests**

- Unit (vitest) for service: defaults, patch merging, corruption →
  quarantine + defaults, atomic write under simulated crash (write to
  tmpfile, kill process, no half-written `settings.json`).
- Unit for secret store: replace → get-status reflects, clear →
  get-status reflects, encrypted-at-rest assertion (read the bin file,
  confirm it doesn't contain the plaintext value).
- Integration through bus: dispatch `settings:write` from a fake
  renderer ctx, assert `events:settings:changed` fired, dispatch
  `settings:read` from a second ctx, assert payload equals the write.
- Lazy migration: drop a hand-crafted v0 JSON file in fixture
  `userData`, dispatch `settings:read`, assert the new shape with
  defaults filled.

### Slice D — Hotkeys (read-only) + About + Experimental

**Files**

- `apps/desktop/src/renderer/src/features/settings/pages/HotkeysPage.tsx`
  — port [design/src/Settings.jsx](../../design/src/Settings.jsx)
  `HotkeysPage` (lines 403–476) verbatim, swap the hard-coded
  bindings for values read from `settings.hotkeys`. Phase 1 hotkeys
  are still registered in code and immutable here — the page is
  display-only, with a footer that reads "Editing comes in a later
  release" instead of "Reset to defaults".
- `apps/desktop/src/renderer/src/features/settings/pages/AboutPage.tsx`
  — version pulled from a new bus verb `app:version` (or expose via
  preload init payload). License stamp `UNLICENSED · © 2026 PwrDrvr
  LLC`. Links: product website (if set), `docs/` repo URL.
- `apps/desktop/src/renderer/src/features/settings/pages/ExperimentalPage.tsx`
  — single switch row "Enable v2 capture file format (PwrSnap1)", bound to
  `settings.experimental.v2FileFormat`. Persists across reload. The
  feature it enables doesn't exist yet — the row says so in its
  subtitle ("Build coming in a later release. Toggle persists so you
  can opt in early.").
- `apps/desktop/src/renderer/src/features/settings/useSettings.ts` —
  small hook: subscribe to `events:settings:changed`, hold the
  snapshot in state, expose `({ settings, patch })`. Mirror PwrAgnt's
  `useDesktopSettings.ts` (162 LOC reference) but trimmed.

**Tests**

- HotkeysPage renders each registered hotkey.
- AboutPage shows the right version (mock `app:version`).
- ExperimentalPage toggle round-trips through the bus (write → event →
  read).

### Slice E — AI Providers page (the headliner)

**Files**

- `apps/desktop/src/renderer/src/features/settings/pages/AIProvidersPage.tsx`
  — port [design/src/Settings.jsx](../../design/src/Settings.jsx)
  `AIProvidersPage` (lines 477–710). Sections to ship today:
  - **Job routing card** — port the visual but mark the rows as
    "preview" until Phase 4 lands. No persistence backing.
  - **Codex card** — fully live: segmented control (Auto / Specified
    Path), candidate table from
    `dispatch("settings:refreshCodexDiscovery", {force: false})`, per-
    row Use button (writes `codex.mode = "pinned"` + `codex.pinnedPath
    = path`), auth profile row (default `~/.codex` for now, no multi-
    profile UI yet), Test button (Slice E ships the visual; the
    actual test call lands in Phase 4).
  - **Grok card** — masked status row + Replace + Clear, both wired to
    `settings:replaceSecret` / `settings:clearSecret`. Replace opens a
    small inline `<input type="password">` confirmed by Enter.
- `apps/desktop/src/renderer/src/features/settings/components/`:
  - `SegmentedControl.tsx` (port `.pss__seg/.pss__seg-btn` shape)
  - `OptionRow.tsx` (port `.pss__opt/.pss__opt-icon/.pss__opt-text` —
    used for candidate rows and auth profile)
  - `Card.tsx`, `Row.tsx`, `Kbd.tsx`, `Switch.tsx` — generic settings
    primitives, identical to design's helpers.
- Replace the four `pages/ComingSoon.tsx` references for Notifications
  / Startup / Annotate / Storage / etc. with the same `<ComingSoon />`
  shell from Slice B. The sidebar still lists them — they just say
  "We haven't built this screen yet."

**Behavior**

- On page mount: `settings:refreshCodexDiscovery` with `force: false`
  (cache hit ok). Manual Refresh button in the section header sets
  `force: true`.
- Pinning a path writes both `mode: "pinned"` and `pinnedPath: path`.
  Switching the segmented control back to Auto Discovery writes `mode:
  "auto"` and keeps the pinnedPath value (so the user doesn't lose it
  on toggle). The "Using" badge follows the effective resolution from
  `resolveCodexCommand`, not the persisted mode — same logic
  `codex-app-server/stdio-transport.ts` already uses.

**Tests**

- Renderer: AIProvidersPage renders the candidate list from a mocked
  snapshot. Clicking Use writes the right patch.
- Renderer: Grok Replace dispatches `settings:replaceSecret` with the
  right name + value; Clear dispatches `settings:clearSecret`. Masked
  field never receives the plaintext value back from main.
- E2E: full round-trip — open Settings via dispatch, navigate to AI
  Providers, screenshot the candidate table, pin a path, close
  Settings, reopen, assert the pinned row shows "Using".

### Slice F — Solutions doc + plan + CLAUDE.md updates

- `docs/solutions/2026-05-12-settings-substrate.md` (new): capture the
  atomic-write scheme, the safeStorage layout, the IPC verb list, the
  `events:settings:changed` discipline, and the legacy-shape catalog
  pattern adopted from PwrAgnt. This will be the first file in
  `docs/solutions/` — directory needs to be created.
- `docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md`
  (edit): in Phase 1 (where the broader Settings screen was originally
  scoped), add a back-pointer to this plan and mark the Settings
  substrate landed early. In Phase 4 (Codex App Server), confirm the
  AI Providers page from this plan is the visual home for the
  binary-selection UI.
- `CLAUDE.md` (edit): if Settings introduces a new convention worth
  load-bearing — e.g., "settings patches must distinguish `undefined`
  from `null` per `exactOptionalPropertyTypes`" — add a short block.
  Otherwise leave it alone.

## Alternative Approaches Considered

- **Lift PwrAgnt's settings substrate wholesale (1147 LOC service +
  rest)**. Rejected per buildout plan §"Decision 4": the PwrAgnt
  service couples worktrees, gh/git discovery, messaging contacts, and
  TOML editing — none of which PwrSnap needs today. Lifting would drag
  in dead surface and force us to either delete it (noisy diff against
  upstream) or maintain unused code. Mirror the patterns, write fresh.
- **TOML for the settings file** (PwrAgnt's choice). Rejected for v1:
  PwrSnap's settings shape is small JSON, users won't hand-edit, and
  JSON is one less dependency. Revisit if a future feature wants
  human-editable config (e.g., per-tag routing rules in Phase 4).
- **electron-store**. Rejected: it's a dep, and we already have the
  atomic-write + migration discipline figured out in PwrAgnt. Roll
  our own with the legacy-catalog pattern from PwrAgnt's
  `config-file-evolution.md`.
- **Multi-page Vite renderer (separate `settings.html` entry)**.
  Rejected: existing windows all branch on the `#stage=` hash and load
  the single `renderer/index.html`. Settings follows the pattern;
  changing the Vite config to a multi-entry setup is unnecessary
  churn.
- **Land the design's Output page in this plan.** Rejected per the
  user's explicit scope note. Output requires storage-destination
  plumbing that's a Phase 2/3 conversation. The sidebar entry stays as
  `<ComingSoon />` until that lands.

## System-Wide Impact

### Interaction graph

- Tray `Settings` click → preload `dispatch("settings:open")` → bus
  `settings-handlers.ts:settingsOpen` → `createSettingsWindow()` or
  `findSettingsWindow().focus()`.
- Settings save: renderer `dispatch("settings:write", patch)` → bus →
  `desktop-settings-service.write` → atomic write → emit
  `events:settings:changed` to every BrowserWindow → renderer
  `useSettings` hook updates → React re-renders affected pages.
- Codex discovery refresh: renderer page-mount → `dispatch("settings:
  refreshCodexDiscovery", {force})` → bus → service-cached or fresh
  `discoverCodexCommands` → returned snapshot rendered into the
  candidate table.
- AI consent / first-AI-use flow (Phase 4) reads
  `settings.ai.consentAcceptedAt`. Slice C lands the field; Slice E
  doesn't gate on it yet (no AI calls).

### Error & failure propagation

- File-write failure → service returns `err({ kind: "settings", code:
  "write_failed", message, cause })`. Renderer hook shows an inline
  toast; doesn't crash the page.
- Corruption on read → service quarantines the file to
  `pwrsnap-settings.corrupt-<ts>.json`, logs at `error`, returns
  defaults. User loses prior config but the app starts. Diagnostic
  link in Settings → About surfaces the path.
- safeStorage unavailable (CI / first launch before keychain) →
  `replaceSecret` returns `err({ kind: "settings", code:
  "secret_unavailable" })`. Renderer surfaces "Keychain unavailable;
  reopen Settings later".

### State lifecycle risks

- A renderer in flight when the service file is rewritten by a
  concurrent process (e.g., a CLI tool) will see the next
  `events:settings:changed`. The atomic-rename guarantees readers see
  either the old or new file, never a partial. No file lock — write
  collisions between PwrSnap instances are a non-goal (single-instance
  enforced elsewhere).
- The Codex discovery cache is per-main-process and dies with the app.
  No persistence; restart re-discovers. Intentional.

### API surface parity

- Renderer dispatch (preload's `pwrsnapApi.dispatch`) is the only
  surface affected. HTTP RPC (Phase 7) and MCP (later) inherit the
  same handlers via the bus — no extra work to expose Settings to
  those transports.

### Integration test scenarios

1. Open Settings, pin a Codex path, restart the app — pinned path
   survives, AI Providers shows the same "Using" badge after restart.
2. Drop a corrupted `pwrsnap-settings.json` in `userData`, launch —
   app starts, Settings opens cleanly with defaults, quarantine file
   exists.
3. Set a Grok key, force-quit, launch — the masked status row says
   "Set · keychain" and `pwrsnap-secrets.bin` exists.
4. Open Settings in two simultaneous BrowserWindows (test bridge),
   write from one — the second sees `events:settings:changed` and
   re-renders within the next tick.
5. Click "Use" on a Codex candidate; Codex App Server spawns — assert
   `stdio-transport.ts` actually invokes the pinned path on the next
   call (Phase 4 integration; gate this test behind a feature flag if
   Phase 4 isn't ready yet).

## Acceptance Criteria

### Functional

- [ ] Tray's right side renders: Library icon-button + Settings
  icon-button + thin separator + compact `IDLE` pill. Hover lifts each
  button per `.ps-tray__hdr-btn:hover`.
- [ ] Clicking the tray's Library button opens/focuses the Library
  window. Clicking Settings opens/focuses the Settings window.
- [ ] `⌘,` opens/focuses Settings from any focused PwrSnap window.
- [ ] Settings window matches the design's sidebar groups and item
  order. Active row glows copper. Group titles are eyebrow style.
- [ ] Hotkeys page renders all current Phase 1 hotkeys with the
  registered key combos.
- [ ] About page shows the running app version, `UNLICENSED · © 2026
  PwrDrvr LLC`, and a link to the website (or repo URL placeholder).
- [ ] Experimental page has one switch row that persists through
  reload via `settings.experimental.v2FileFormat`.
- [ ] AI Providers page lists every Codex candidate from discovery
  with source + version badges; the resolved one shows "Using".
- [ ] Pinning a Codex candidate writes `codex.mode = "pinned"` +
  `codex.pinnedPath`. Reloading Settings preserves the choice.
- [ ] Switching back to Auto Discovery writes `codex.mode = "auto"`
  without clearing the pinned path.
- [ ] Replacing the Grok API key writes via `safeStorage`; the masked
  status row shows "Set · keychain · lastSetAt". Clear wipes it; row
  shows "Not set".
- [ ] Every non-implemented sidebar item renders `<ComingSoon />` with
  the right eyebrow + title from the design.

### Non-functional

- [ ] All Settings IPC verbs return `Result<Res, PwrSnapError>` — no
  thrown exceptions across processes.
- [ ] `pwrsnap-settings.json` writes are atomic (write-tmp + rename).
- [ ] `pwrsnap-secrets.bin` never contains plaintext. Verified by a
  unit test that greps the on-disk bytes for the test secret.
- [ ] No new `ipcMain.handle` calls. All routing through `command-bus`.
- [ ] Settings BrowserWindow is `contextIsolation: true, sandbox:
  true, nodeIntegration: false`. Verified by the existing lifecycle
  test (or a new one mirroring `apps/desktop/src/main/__tests__/window-list.test.ts`).

### Quality gates

- [ ] Vitest unit coverage on service + secret store + every page
  component.
- [ ] One Playwright spec per page (Settings → category → screenshot,
  basic interaction).
- [ ] All Slice A–F PRs pass `pnpm lint` + `pnpm typecheck` + `pnpm
  test` + `pnpm --filter @pwrsnap/desktop test:e2e`.

## Success Metrics

- Settings catches up the implementation with the design's net-new
  Settings surface, on the four pages we have backing code for, with
  honest placeholders for the rest. Definition-of-done: "I can pin a
  Codex binary in the UI, restart, and see it pinned" closes the loop.
- No regression in tray sizing (`apps/desktop/e2e/tray-sizing.spec.ts`
  remains green).
- New `docs/solutions/` directory created; first entry captures the
  Settings substrate so the next person doesn't reinvent it.

## Dependencies & Prerequisites

- `apps/desktop/src/main/settings/codex-discovery.ts` (already lifted
  in Phase 0.5). Continues to be the discovery engine; this plan only
  adds a thin command handler on top.
- Electron `safeStorage` (already available; first use is here).
- No new pnpm deps.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `safeStorage` returns "unavailable" on a fresh dev profile | Medium | Replace fails for Grok key | Surface the inline error; do NOT silently fall back to plaintext (per PwrAgnt's permission-mode learning — security-relevant fallbacks must be explicit). |
| Renderer + main settings types drift | Medium | Type errors at the IPC boundary | Hoist all settings + discovery types into `@pwrsnap/shared`. Single source of truth. |
| Settings schema needs to grow before Slice C ships | High over time | Risky migrations | Adopt PwrAgnt's legacy-shape catalog pattern on day one — even with only one shape today, the reader is structured to accept v0/v1/vN. |
| Codex discovery is slow on first call | Low | Spinner on AI Providers mount | Service-side 30s cache; page-mount call uses `force: false`; refresh button uses `force: true`. |
| Settings window auto-sizing surprises (tray/float-over CLAUDE.md rule) | Low | Window stuck at min size | Settings is a normal resizable window; no `setContentSize` usage planned. If we later add it, call `setMinimumSize(0, 0)` per the existing CLAUDE.md block. |
| Tray header chrome breaks the wrapper-measure pipeline | Low | Tray height stuck | The CLAUDE.md tray-popover-sizing block covers exactly this; `tray-sizing.spec.ts` will catch a regression. |

## Resource Requirements

- One engineer, ~3–5 working days end-to-end. Slices A and B are sub-
  day; C is the big one (1.5 days incl. tests); D + E are ~half-day
  each given the design is finished JSX/CSS.
- No infra changes. No new third-party services.

## Future Considerations

- Settings hot-keys editing (Phase 2/3): when this lands, the Hotkeys
  page swaps display-only mode for editable rows. `settings.hotkeys.*`
  is already the right shape.
- Per-tag routing → Storage page: when Phase 4 ships tag-based upload
  destinations, the Storage placeholder becomes the home.
- Multi-profile Codex (`CODEX_HOME` per profile, the way PwrAgnt does
  it): the auth-profile row is positioned for it; extend
  `settings.codex.profile` from `string` to a discriminated profile
  union when that need is real.
- Phase 4 AI Providers: the Job-routing card in the design is the
  permanent home for model routing (Codex caption, OpenAI embedding,
  OCR provider). Today's slice renders the visual but doesn't
  persist; flip the rows to live on the Phase 4 PR.
- `docs/solutions/` becomes a real directory after Slice F. Future
  Settings learnings (e.g., the next migration shape, a safeStorage
  edge case) land here.

## Documentation Plan

- `docs/solutions/2026-05-12-settings-substrate.md` — new. Captures
  what was built and the patterns adopted. Index entry: "Settings
  substrate · IPC + safeStorage + atomic JSON + legacy-shape catalog".
- `docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md` —
  edit. Phase 1 (Settings screen) gets a back-pointer; Phase 4 (Codex
  App Server) confirms AI Providers as the binary-selection home.
- `CLAUDE.md` — likely no change. Re-evaluate after Slice C lands; if
  the `exactOptionalPropertyTypes` discipline shows up in PR review as
  a recurring trap, add a block.

## Sources & References

### Internal references

- [design/PwrSnap Settings.html](../../design/PwrSnap Settings.html) ·
  [design/src/Settings.jsx](../../design/src/Settings.jsx) ·
  [design/src/settings.css](../../design/src/settings.css) — Settings
  surface design.
- [design/src/TrayMenu.jsx](../../design/src/TrayMenu.jsx) ·
  [design/src/library.css](../../design/src/library.css) — tray
  header rework.
- [apps/desktop/src/main/window.ts](../../apps/desktop/src/main/window.ts):90
  — library window pattern to mirror for Settings.
- [apps/desktop/src/main/command-bus.ts](../../apps/desktop/src/main/command-bus.ts):52
  — handler registration shape.
- [apps/desktop/src/main/settings/codex-discovery.ts](../../apps/desktop/src/main/settings/codex-discovery.ts):212
  — `discoverCodexCommands` (Phase 0.5 lift).
- [apps/desktop/src/preload/index.ts](../../apps/desktop/src/preload/index.ts):103
  — preload `dispatch` shape.
- [apps/desktop/src/renderer/src/App.tsx](../../apps/desktop/src/renderer/src/App.tsx):7
  — Stage union to extend.
- [packages/shared/src/protocol.ts](../../packages/shared/src/protocol.ts):65
  — Settings types to extend.
- [packages/shared/src/ipc.ts](../../packages/shared/src/ipc.ts):11 —
  `events:settings:changed` channel (already reserved).
- [apps/desktop/e2e/fixtures/electron-app.ts](../../apps/desktop/e2e/fixtures/electron-app.ts)
  — E2E harness; `__PWRSNAP_TEST__` bridge.

### External (pattern references — do not lift)

- `~/github/PwrAgnt/apps/desktop/src/main/settings/desktop-settings-service.ts`
- `~/github/PwrAgnt/apps/desktop/src/main/settings/desktop-secret-store.ts`
- `~/github/PwrAgnt/apps/desktop/src/main/ipc/settings.ts`
- `~/github/PwrAgnt/apps/desktop/src/renderer/src/features/settings/ModelsSettings.tsx`
- `~/github/PwrAgnt/apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx`
- `~/github/PwrAgnt/apps/desktop/src/renderer/src/features/settings/useDesktopSettings.ts`
- `~/github/PwrAgnt/docs/config-file-evolution.md` — legacy-shape
  catalog + path-based-edit philosophy.
- `~/github/PwrAgnt/docs/solutions/2026-05-07-codex-permission-mode-state-machine.md`
  — security-relevant fallback discipline; informs Slice E's "no
  silent plaintext fallback".

### Conventions

- [CLAUDE.md](../../CLAUDE.md) — `setMinimumSize(0, 0)` rule (not
  triggered by Settings unless we add dynamic content sizing later);
  inline-block wrapper measurer (same caveat); channel naming
  conventions; PR title conventions.
