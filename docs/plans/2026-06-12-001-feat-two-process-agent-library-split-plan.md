# Two-Process Split: Capture Agent + Library App

- **Date:** 2026-06-12
- **Status:** Accepted — Phase 1 in progress
- **Scope:** `apps/desktop` process architecture (macOS-first; Windows stays
  single-process until revisited)
- **Related:**
  - [2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md)
    §"Single command-bus + multi-transport" and §"Phase 7" — this plan adds a
    third bus transport (the process bridge) consistent with that design.
  - [2026-05-04-001-fix-capture-flow-window-choreography-plan.md](2026-05-04-001-fix-capture-flow-window-choreography-plan.md)
    — the first round of fighting this problem in-process.
  - PR #234 (`fix/capture-snapshot-side-effects`) — the latest round. Its
    fixes (selector `showInactive`, no `activateApp` after image capture, no
    dock recovery in the capture flow) remain correct *inside the agent
    process* and should land independently of this plan.

## Problem

PwrSnap is one Electron process that is simultaneously:

1. A **regular macOS app** — Library / Settings / Sizzle windows, Dock icon,
   ⌘-Tab entry, menu bar.
2. A **background overlay agent** — tray popover, global hotkeys, capture
   selector overlays, float-over toast, recording HUD. These must appear over
   everything, never activate the app, and never steal focus.

On macOS, **activation policy, Dock presence, app activation, and the
key-window cascade are per-process** AppKit concepts. Mixing both roles in one
process means every overlay maneuver risks side effects on the normal windows,
and vice versa. The codebase carries an archaeology of compensations:

- `reclaimDockIconIfLibraryAlive()` ([window.ts:303](../../apps/desktop/src/main/window.ts))
  — exists because `activateApp(otherPid)` + our persistent floating panels
  cause AppKit to demote PwrSnap to Accessory, stripping the Dock icon and
  orphaning the Library window.
- The guarded `focus` handler on the Library window — added because
  unconditional `app.dock.show()` on the macOS focus-event cascade hammered
  `setActivationPolicy` and produced a 10× traffic-light flash.
- `focus-sink.ts` — an invisible 1×1 floating panel whose only job is to
  absorb Cocoa's next-key-window walk so hiding the tray popover doesn't
  auto-raise the Library.
- The `did-resign-active` dock reclaim, `keepPwrSnapChrome` plumbing in the
  capture flow, and the dock show/hide pair tied to Library open/close
  ([window.ts:364-412](../../apps/desktop/src/main/window.ts)) — every
  policy flip is a Dock-flash opportunity.

User-visible symptoms (pre-#234): Library disappears/reappears on
⌘⇧C, the Dock icon flashes, and Esc-cancel can leave the Library hidden.
PR #234 fixes the proximate causes, but the structural coupling that keeps
regenerating this bug class remains.

## Decision

Split the desktop app into **two processes launched from one app bundle**:

| | **Agent process** | **Library process** |
|---|---|---|
| Launch | Default role; started at login (future), by Finder/Dock relaunch, or directly | Spawned on demand by the agent (tray "Open Library", post-capture "open", Dock relaunch, `.pwrsnap` open) |
| Activation policy | **Accessory, always** (bundle ships `LSUIElement: true`; agent never touches dock/policy APIs) | Promotes to **Regular** once at boot (`app.dock.show()`); never hides |
| Dock / ⌘-Tab | Never present | Present exactly while the process runs |
| Windows | Tray popover, capture selectors, float-over toast, recording HUD, text-bake pool (as needed) | Library, Settings, Sizzle, app-document windows (editor lives in the Library window) |
| Lifetime | Resident for the app session; owns single-instance lock, auto-update, quit | Once spawned, stays resident across window closes like any macOS document app (Dock icon persists; Dock-click / tray "Open Library" re-show instantly). ⌘Q quits it; the agent respawns on the next intent |
| Owns | Capture pipeline + persist, global hotkeys, enrichment pipelines, clipboard events, settings + secrets substrate | Library/editor/render-heavy UI, exports |

What this buys, structurally rather than by discipline:

- The agent **cannot** flash the Dock icon or hide the Library — it has no
  Dock presence and no Library window in its `[NSApp orderedWindows]`.
- Selector overlays and popovers are non-activating panels in an Accessory
  process: showing/hiding them cannot raise, hide, or restore normal windows.
- There is **no focus to restore** after capture — the agent never activates,
  so `activateApp(previousAppPid)` and its policy-demotion side effects are
  deleted, not worked around.
- The Library behaves like any other document app: Dock icon while the
  process runs, close-the-window keeps it resident for instant re-open, ⌘Q
  actually quits. "Library is in the Dock always (while open)" becomes the
  default behavior instead of a balancing act.
- Crash isolation: a render/editor crash can't take down capture, and vice
  versa.
- "Start at login" (wanted soon) launches the agent only — no window flash,
  smaller resident footprint than today (the Library renderer no longer idles
  in memory when closed).
- `focus-sink.ts`, `reclaimDockIconIfLibraryAlive`, the `did-resign-active`
  reclaim, the dock-guarded focus handler, and `keepPwrSnapChrome` are all
  **deleted** at the end of this plan.

## Alternatives considered

1. **Stay single-process, stop flipping policy (always Regular).** Removes
   the flash points but keeps the Dock icon visible with no windows open
   (menubar-app violation), keeps the Library in the agent's window list
   (focus cascade, auto-raise class of bugs), and keeps app-activation
   coupling. Rejected: removes ~half the symptoms, none of the structure.
2. **Two separate app bundles (helper app).** Same AppKit benefits, but
   doubles signing/notarization/update surface and requires
   `SMLoginItemSetEnabled` helper plumbing for login items. Rejected: the
   one-bundle/two-roles shape gets identical runtime behavior with one
   artifact to ship.
3. **Keep whack-a-moling in-process.** PR #234 is the third round
   (choreography plan was the first). Each fix is real, but the bug class
   regenerates because the invariant is unenforceable in one process.

## Architecture

Numbered decisions; each phase below references these.

### D1. Roles from one binary

`apps/desktop/src/main/process-role.ts` parses `--pwrsnap-role=<role>` from
`process.argv` (set by the supervisor when spawning the library) with roles
`combined | agent | library`. **`combined` is today's single-process behavior
and remains the default** until Phase 4 flips macOS to `agent`. Windows stays
`combined` (no Dock/activation-policy problem there; revisit with the Windows
port plan if login-footprint wants it).

### D2. Supervision

The agent spawns the library with Node's `child_process.spawn`:

- Packaged: `spawn(process.execPath, ["--pwrsnap-role=library", ...], { stdio: ["ignore", "inherit", "inherit", "ipc"] })`
- Dev: `spawn(process.execPath, [app.getAppPath(), "--pwrsnap-role=library", ...])`
  (electron-vite dev: the child inherits `ELECTRON_RENDERER_URL` so its
  renderers hit the same dev server).

The supervisor (`library-process-supervisor.ts`, agent-side) exposes
`ensureLibraryProcess()` (idempotent; spawns or returns the live child),
forwards "show library / open capture / open settings page" intents over the
bridge, and kills the child on agent quit. Ensure-on-demand IS the restart
policy: once spawned, the library stays resident across window closes
(standard macOS close-window-keep-running semantics — re-open via Dock click
or tray is instant); if the user ⌘Q's it, the next intent respawns it. Only
window verbs spawn — data verbs answer locally in the agent (D4), so a tray
thumbnail or capture broadcast never resurrects the process.

**User launch opens the Library.** At agent boot, a user-initiated launch
(Finder/Dock double-click, `pnpm dev`) immediately dispatches
`library:focus` — opening the app lands the user in the Library exactly like
launching any other app. Login-item launches (D10, future) pass a flag to
skip this and boot tray-only. The spawned child is never activated by Launch
Services, so its window-verb handlers call `app.focus({ steal: true })`
(library role only) after showing a window — without that, the window orders
in BEHIND the user's frontmost app and the launch reads as "nothing
happened". The library process never receives intents except through the
bridge, so it boots windowless and lets the triggering verb create exactly
the window the user asked for (`settings:open` with the Library closed opens
only Settings).

### D3. Single-instance lock

Only the **agent** role requests `requestSingleInstanceLock`. The library
child never does (it is supervised, not user-launched). A second user launch
(Finder/Dock) starts an agent-role process that loses the lock, forwards its
argv, and quits; the running agent's `second-instance` handler ensures the
library is visible — same UX as today.

### D4. Process bridge = third command-bus transport

A typed JSON message protocol over the parent↔child Node IPC channel
(`process.send` / `child.send`) — private to the process pair, no localhost
port, no auth surface. This is a **transport over the existing command bus**,
exactly like ipcMain today and HTTP RPC in Phase 7 of the buildout plan:

- `process-bridge/protocol.ts` — message envelope (`hello | request |
  response | event`) with a `pwrsnapBridge: 1` discriminator and type guards.
  Responses carry the standard `Result<T, PwrSnapError>` (cause stripped —
  it does not survive serialization).
- `process-bridge/channel.ts` — `BridgeChannel` abstraction wrapping
  `process` / `ChildProcess`, plus an in-memory pair for unit tests. If we
  ever revisit two bundles, only this file changes (socket instead of pipe).
- `process-bridge/endpoint.ts` — symmetric endpoint: dispatch a command on
  the peer (`dispatchRemote`), serve incoming requests via injected local
  dispatch (`bus.dispatch` with `principal: "bridge"`), relay events
  (`emitEvent` / `onRemoteEvent`), fail pending requests with
  `code: "bridge_closed"` when the channel drops.

**Routing:** each role registers its owned domains locally and registers
*proxy handlers* (forward over the bridge) for the peer's domains. One
registry, one dispatch path, per process — renderers keep calling
`pwrsnapApi.dispatch(...)` with zero changes; the preload/IPC layer is
untouched.

Ownership of command domains:

| Agent | Library | Both (register locally in each) |
|---|---|---|
| `capture:*`, `recording:*`, `clipboard:*`, `float-over:*`, `permissions:*` | `library:focus` / `library:openInLibrary` / `library:export` (window verbs), `editor:*`, `layers:*`, `render:*`, `bundle:*`, `video:*`, `sizzle:*`, `cart:*`, `storage:*`, chat surfaces (`codex:libraryChat:*`, `codex:sizzleChat:*`) | **`library:*` data verbs** (list/byId/search/delete/tags/…) — the agent's tray + float-over read and mutate captures locally against the shared WAL DB; a tray thumbnail must never resurrect the library process |
| `settings:*` (substrate), `codex:*`, `acp:*`, `app:update:*` | `settings:open`, `app:openDocumentWindow` | `app:version`, `system:listDisplays`, `app:readDocument`, `app:openExternal` |

Events (`events:captures:changed`, `events:settings:changed`, float-over
state, enrichment progress) relay across the bridge with an origin guard
(no echo loops): emit locally to this process's windows, forward once to the
peer, peer emits to its windows.

### D5. Window ownership

Per the table in the Decision section. The **focus-sink is not ported** — the
agent process has no Library window for Cocoa's key-window walk to land on,
which is the entire reason focus-sink exists. The recording HUD, selectors,
tray, and float-over keep their current `panel` / level configuration,
unchanged, in the agent.

### D6. Database — shared SQLite, agent migrates

Both processes open the same DB (already WAL mode, [db.ts](../../apps/desktop/src/main/persistence/db.ts)).
Rules:

- The **agent opens and migrates before spawning the library**. The library
  opens with `openDatabase({ migrations: "verify" })`: it never migrates;
  unapplied migrations (version skew after an update) fail closed with a
  relaunch prompt.
- `PRAGMA busy_timeout = 5000` is already set on every open (db.ts) —
  required for multi-process WAL; keep it.
- Write traffic is naturally partitioned: capture/recording inserts +
  enrichment updates (agent); library CRUD, editor saves, exports (library).
  WAL handles the rare collision; `busy_timeout` absorbs it.

### D7. Render pipeline — both sides render, cache is the contract

The float-over needs previews with the library closed; the library does the
heavy lifting. Both roles keep the render module. The content-addressed bake
cache is the coordination point: **all cache writes must be tmp + rename
atomic** (audit in Phase 3). A duplicate render across processes is wasted
work, not corruption. Orphan policy unchanged
([2026-05-28 bake cache solution doc](../solutions/2026-05-28-bake-render-cache-orphans.md)).

### D8. Settings + secrets substrate lives in the agent

One writer, as the substrate rules already demand. `DesktopSettingsService` +
`DesktopSecretStore` instantiate **only in the agent** (it's the
always-running process; tray toggles and hotkey rebinds need it without the
library). The library registers proxy handlers for `settings:*` — reads and
writes cross the bridge (settings payloads are small). The
`events:settings:changed` broadcast relays per D4, so the renderer contract
(read once, then listen) is unchanged. Plaintext secrets may cross the
parent↔child pipe (private OS pipe, never a socket) when a library-side
consumer needs one, but — as today — **never** reach a renderer.

### D9. Protocols, open-file, deep links

Each process registers `pwrsnap-capture://` (and friends) for its own
renderers — registration is per-process and the underlying files are shared.
Apple Events (`open-file` for `.pwrsnap`, URL schemes) land on the
first-registered process for the bundle — the agent; it forwards to the
library over the bridge (ensure-running, then dispatch). Phase 3 verifies the
routing empirically; fallback is handling the event in whichever process
receives it and forwarding.

### D10. Packaging, login item, auto-update

- `electron-builder.yml` `extendInfo` gains `LSUIElement: true` (Phase 4,
  with the default flip — shipping it earlier would strip the Dock icon from
  the combined app).
- `app.setLoginItemSettings({ openAtLogin })` (new Settings → General toggle,
  Phase 4) launches the bundle → agent role → no windows, no Dock, no flash.
- `electron-updater` runs in the agent (always resident). On update restart,
  the agent quits the library child first.

### D11. E2E strategy

- `combined` role keeps the entire existing Playwright suite green through
  Phases 1–3 (the harness changes nothing).
- Split-mode lane (Phase 3): Playwright `_electron.launch`es the agent; the
  supervisor spawns the library child with `--remote-debugging-port=0`; the
  harness attaches to the child via `chromium.connectOverCDP` and drives both
  sides. New specs assert the headline invariants:
  - picker open + Esc-cancel: library window visibility/bounds/focus and the
    frontmost app are bit-identical before/after; no Dock change events.
  - capture with library closed: float-over appears, library process never
    spawns.
  - "open in library" from float-over: library process spawns, window
    appears, agent's activation state untouched.

## Phases

Each phase lands independently with CI green.

### Phase 1 — role + bridge plumbing (inert) ← this PR

- `process-role.ts` (D1) — parse + tests.
- `process-bridge/` protocol, channel, endpoint (D4) — fully unit-tested
  against the in-memory channel pair (request/response correlation, unknown
  command, event relay + origin guard, channel-close failure, malformed
  message tolerance, non-serializable `cause` stripping).
- `CommandPrincipal` gains `"bridge"`.
- **No behavior change**: nothing constructs a bridge at runtime yet;
  default role is `combined`.

### Phase 2 — boot split behind `PWRSNAP_PROCESS_SPLIT=1` (dev flag)

- Role-guard `bootstrapApp()` ([index.ts](../../apps/desktop/src/main/index.ts))
  in place: each boot step gains an explicit role condition, so `combined`
  runs the exact pre-split sequence by construction (every guard is a no-op
  there) and the diff stays reviewable. Physically factoring into `boot/`
  modules is deferred until split mode stabilizes (Phase 3+) — one
  implementation, assembled by role, either way.
- Supervisor (D2), lock semantics (D3), command-ownership routing + bus
  remote-forwarder fallback (D4), window ownership split (D5), DB open
  order + verify mode (D6), settings registration split (D8), per-process
  protocol registration (D9).
- Forwarding is by ownership table (`process-split/command-routing.ts`);
  the bus consults it only when no local handler exists, so local
  registration always wins.
- Flag is dev-only; default behavior still `combined` everywhere.

### Phase 3 — parity + hardening

Pulled forward into the Phase 2 PR during dev-flag smoke testing:
enrichment/budget/updater event relays, library data-verb locality (a tray
thumbnail never spawns the library), resident-library lifecycle, user-launch
opens the Library, spawn-trigger logging, agent-safe open-file fallback.

Done in the Phase 3 pass on the same PR:

- **Crash/restart supervision:** the library quits itself when the parent
  pipe drops with no visible windows, and on last-window-close when the
  bridge is dead — an agent hard-crash no longer leaves a zombie library
  beside the next launch's fresh agent.
- **Cross-process cancellation:** the bridge carries `cancel` frames;
  `library:delete` mirrors `bus.cancel` to the peer so an agent-side
  enrichment for a deleted capture aborts.
- **Main-side relayed-event hook** (`onRelayedRendererEvent`): the
  library's menu tracks live developer-mode flips broadcast by the
  agent-side settings service.
- **Render-cache write atomicity audit (D7): PASSED, no changes** —
  compose-tree.ts already writes `<path>.tmp-<pid>` then renames, so
  concurrent cross-process renders can't collide or tear.
- Login-item launches boot tray-only (PR #237's `--launched-at-login`
  argv contract; converge on its `wasLaunchedAtLogin()` post-merge).

Remaining (tracked, not gating the experimental-setting ship):

- **E2E split lane + invariant specs (D11)** — Playwright launches the
  agent, attaches to the supervised library child via CDP. Darwin-only by
  nature; runs locally and on any future macOS CI runner.
- open-file / deep-link routing verified empirically with a packaged
  build (D9).
- Drag-out + clipboard flow audit from both sides (forwarded
  `capture:prepareDrag` / `clipboard:copy` latency watch).

### Phase 4 — ship split as an opt-in experimental setting (default OFF)

**Revised from "env-flag flip" to a user-visible opt-in:** the split ships as
`experimental.processSplit`, **default OFF**, surfaced as Settings → General →
"Two-process mode" (macOS only, relaunch to apply). Regular users get the
single-process (`combined`) app; the author dogfoods the split by flipping the
toggle on, and we widen the audience as it soaks. Boot resolves the role from
a synchronous settings-file peek (missing/unreadable file → OFF, matching
`defaultSettings()`); `PWRSNAP_PROCESS_SPLIT=1/0` remains the dev/debug
override and E2E still forces `combined` unless the split lane opts in via
`PWRSNAP_E2E_SPLIT=1`.

A later flip of the shipped default to ON (then the Phase 5 deletion) happens
once the split has soaked with no regressions.

### Phase 5 — delete the single-process kludges (after soak + default-ON)

Once the experimental setting has soaked with no regressions and the default
has flipped to ON:

- Remove `combined` mode on macOS (the setting and the fallback path are
  deleted together; Windows/Linux keep single-process).
- Delete: `focus-sink.ts`, `reclaimDockIconIfLibraryAlive`,
  `did-resign-active` reclaim, dock-guarded focus handler, Library
  close→`app.dock.hide()`, `keepPwrSnapChrome`, `activateApp` restore path,
  and their tests.
- Packaging: `LSUIElement: true` (agent never flashes a Dock icon at
  launch; the library promotes itself to Regular), updater quit ordering
  (D10).

## Risks & mitigations

- **Memory:** two Electron processes ≈ +100–150 MB while the library runs.
  The library stays resident after its first open (instant re-open beats
  the savings of quitting — first smoke test confirmed respawn-on-demand
  reads as churn), so steady-state matches today's combined footprint;
  users who want it gone ⌘Q it, and login-item boots never spawn it.
- **"Open Library" latency:** cold spawn ~1–2 s, paid only on the first
  open per agent session (the process stays resident afterward).
- **Playwright cross-process harness** is the most novel test work (CDP
  attach). Contained to Phase 3; combined mode keeps coverage meanwhile.
- **SQLite contention:** WAL + `busy_timeout` + naturally partitioned
  writers. Audit any long write transactions in Phase 3.
- **Apple Event routing** with two same-bundle processes needs empirical
  verification (Phase 3); both-sides-handle-and-forward is the fallback.
- **Drift between combined and split boot paths** during Phases 2–3: role
  guards live inline in the one `bootstrapApp()` sequence — there is one
  implementation, assembled by role, not two copies. The guards are the
  to-delete list for Phase 4.

## Out of scope

- Windows/Linux process split (revisit after the Windows port plan).
- HTTP RPC / MCP transports (buildout plan Phase 7 — unchanged by this).
- Any bundle-format, schema, or renderer-surface changes.
