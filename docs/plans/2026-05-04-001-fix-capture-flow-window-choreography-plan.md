---
title: Capture-flow window choreography — toast reliability, tray hide, no library jump
type: fix
status: active
date: 2026-05-04
---

# Capture-flow window choreography

Three Phase-1 polish bugs share one root cause: the windows that participate in a capture (tray popover, region selector, screen snapshot, float-over toast, library) are choreographed via post-hoc show/hide calls with implicit timing assumptions, and those assumptions don't hold reliably across:

- **App activation transitions** (we activate the previous app via NSRunningApplication mid-flight)
- **Renderer reload races** (`loadURL` is async; stale `setTimeout`s from the prior toast survive into the new one)
- **macOS compositor flushes** (the tray popover hasn't finished dismissing when we snapshot the screen)

This plan replaces the post-hoc choreography with a **pre-show under-selector** model, an **IPC-driven persistent float-over renderer** (no `loadURL` reload between captures), a **synchronous tray dismiss** before snapshot, and **deferred previous-app activation** so the toast wins the z-order race every time.

## Problem Statement

### Bug 1 — Tray menu visible in capture snapshots

When the user opens the tray popover, clicks **Auto** (or any capture-mode button), the tray popover stays visible in the captured frame. Reproduced consistently. Demonstrated in the user's own screenshot — the tray menu appears in the rendered snapshot the user is dragging against.

**Mechanism:** `apps/desktop/src/main/tray.ts:23` sets `BLUR_DISMISS_DEBOUNCE_MS = 120`. The popover's blur fires when `bus.dispatch("capture:interactive")` runs and the click loses focus. The debounced `hide()` is queued for 120ms later. Meanwhile `pickRegion` (`region-selector.ts:158`) immediately calls `captureAndRegister(targetDisplay.id)` which forks `screencapture -R bounds` — typically completes in 70–120ms. The tray window is **still on screen** when the screencapture pixel-grab fires. The frame contains the tray popover.

The `screencapture` CLI uses a sound-suppressed window-server pixel grab that captures everything actually drawn at that instant — including our own popover.

The user's nominal use case: "use the 5-second-delay mode" if they want to capture themselves. Today's behavior should NOT include the tool's own UI.

**Acceptance:** Click tray → Auto / Region / Window. The captured PNG and the snapshot the selector paints behind itself contain **zero PwrSnap chrome** — no tray popover, no menu items, no border.

### Bug 2 — After-capture toast almost never shows

Float-over should appear bottom-right of the cursor's display after every commit, hold ≥ 5s (cancellable on hover / interaction), and be the primary post-capture surface. In practice: "I almost never see it … I think the E2Es are either not covering with tests or not able to see that it is not appearing on the screen or staying on the screen for more than a microsecond."

**Mechanism (multi-cause stack, ranked by audit-agent confidence):**

1. **Stale exit-animation timer survives `loadURL` reload.** `FloatOver.tsx:177, 196` schedules `setTimeout(() => onDismiss?.(), 220)` when entering the exiting state. This handle is never stored or cleared. When `showFloatOverForCapture` calls `reloadForCapture` for a new capture, the renderer is torn down and a fresh React tree mounts — but the prior tick's `setTimeout` is on the page-level event loop, which `loadURL` does NOT reset until the new document fully parses. The pending `onDismiss` fires ~220ms after the SECOND capture mounts → `dispatch("float-over:dismiss")` → `singleton.hide()`. Toast appears, then ~220ms later disappears, before the user's eye registers it.

2. **`activateApp(previousAppPid)` racing ahead of float-over show.** `region-selector.ts:430-433` runs `void activateApp(previousAppPid)` synchronously inside `hideAllSelectors`. The selector result resolver fires this BEFORE `runInteractiveCapture` (`index.ts:142`) gets a chance to call `showFloatOverForCapture`. NSRunningApplication.activate posts a Cocoa event that completes asynchronously — at the moment `showInactive`/`moveTop` runs, the previous app may be in mid-claim of frontmost-app status, and macOS resolves the window-level conflict in favor of the activating app's key window. Toast briefly visible during `showInactive` then occluded.

3. **`showInactive()` + `moveTop()` at `pop-up-menu` level is not bulletproof when our app yielded focus.** Industry-standard pattern (CleanShot, Shottr, macshot) uses `floating` level (NSWindowLevel 3) and `app.activationPolicy = .accessory` (LSUIElement) so window shows don't trigger app-switch z-order resolution. PwrSnap is currently a `regular` LSApplicationCategoryType app — every show is treated by AppKit as a potential focus event.

4. **Broadcast hits the in-flight float-over webContents.** `capture-handlers.ts:38-43` does `for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EVENT_CHANNELS.capturesChanged, {changedIds})`. The float-over window is in that list. While its renderer is still loading (state: `kind: "loading"`) it receives a `events:captures:changed` event. Side-effects depend on subscribers but it's at minimum extra mid-mount work that could delay the LOADED state's `<FloatOver>` first paint.

**Why E2E doesn't catch this:** The e2e tests under `apps/desktop/e2e/` (per the plan / earlier-session context) exercise `capture:interactive` via the test bridge, but they assert post-capture state via DB queries and command-bus responses — **they don't take a screen-region screenshot at T+200ms and assert the float-over PNG matches a fixture**. The toast could be visible for 1ms or 1000ms and the tests pass identically.

**Acceptance:** After every commit, the float-over is on screen at bottom-right of the cursor's display, opaque, paintable, ≥ 5 seconds (default), pause-on-hover, dismiss-on-explicit-click. Verifiable from a test screenshot taken 100ms after commit.

### Bug 3 — Library window jumps up after capture

The library window (the main `PwrSnap` window) appears on top of the previously-frontmost app after a capture commits. Should NOT happen — the float-over toast is the intended first interaction; the user clicks **Edit** in the toast to open the editor explicitly.

**Mechanism:** Several plausible contributors:

1. **Show side-effects of the float-over re-raise PwrSnap.** `app.dock.show()` is called defensively in `index.ts:264` on `whenReady`. When the float-over `showInactive()` fires, AppKit may treat any window-show as activation-eligible if the app was previously deactivated. The library window, being PwrSnap's only `regular`-policy window, becomes the natural beneficiary.

2. **`activateApp(previousAppPid)` failing silently.** If `previousAppPid` is `null` (the listWindows snapshot hadn't resolved before the user committed — possible on a sub-100ms commit), `hideAllSelectors` skips the activation. PwrSnap stays as the active app; library is the topmost PwrSnap window; library appears front.

3. **The `library:focus` path is reachable from event listeners that fire during capture.** `library-handlers.ts:79-80` does `main.show(); main.focus()` — only invoked from explicit `library:focus` dispatches, but a wayward IPC during the capture flow could fire it.

The user's proposed fix dovetails with the Bug 2 fix: pre-show the float-over UNDER the selector. When the selector hides, the float-over is already painted in the right z-position. No post-hoc show, no race.

**Acceptance:** After a commit, the previously-frontmost app remains frontmost. The library window does not change z-order. The float-over toast is the only PwrSnap surface visible.

## Proposed Solution

Four coordinated changes:

### Solution 1 — Tray-popover-hide before snapshot (Bug 1)

Before invoking `screencapture -R` in `captureScreen`, **synchronously hide the tray window** (if visible) and yield one compositor frame so the pixel-grab doesn't include the popover.

```ts
// main/capture/screen-snapshot.ts (new wrapper)
async function captureAndRegister(displayId: number): Promise<ScreenSnapshot> {
  hideTrayPopover();                              // synchronous orderOut
  await new Promise(r => setTimeout(r, 50));      // compositor flush
  const result = await captureScreen(displayId);
  // ...
}
```

`hideTrayPopover()` lives in `main/tray.ts` as a sibling of `installTray()` — it calls `trayWindow.hide()` directly, bypassing the 120ms blur debounce. The 50ms compositor delay is the macshot-validated value (see Sources). Belt-and-suspenders: even if AppKit synchronously dismisses the popover on click (which it does for `NSStatusItem`-backed popovers), we don't rely on that — explicit hide guarantees correctness across `BrowserWindow`-backed popovers (which we use).

Effort: ~30 LOC. Independent of the rest of the plan; can land first.

### Solution 2 — Persistent float-over renderer + IPC state machine (Bug 2)

Stop using `loadURL` to swap captures into the float-over. The renderer mounts ONCE at app boot (lazy on first capture) and stays alive across every capture. State transitions happen via IPC, not navigation.

**Renderer state machine:**

```
       ┌──────────┐  show:idle    ┌──────────┐  show:loaded(captureId)  ┌──────────┐
       │  HIDDEN  │ ─────────────▶│   IDLE   │ ────────────────────────▶│  LOADED  │
       └──────────┘               │ (placebo)│                          │(countdown)│
            ▲                     └──────────┘                          └──────────┘
            │                          │                                      │
            │                          │ dismiss / cancel                     │ auto-dismiss / user-X
            │                          ▼                                      ▼
            └──────────────────────  HIDDEN  ◀──────────────────────────────────
```

**IDLE** is the "pre-show under selector" state — rendered, positioned, but visually hidden behind the selector. No data; just a placeholder skeleton. Selector commits → main sends `float-over:populate(captureId)` → renderer fetches data, transitions to LOADED, starts countdown. Selector cancels → main sends `float-over:cancel` → renderer transitions HIDDEN before selector hides.

**Channels (all server → renderer broadcast):**

```ts
// packages/shared/src/protocol.ts (or a new ipc.ts entry)
"events:float-over:state": {
  | { kind: "show-idle" }
  | { kind: "show-loaded"; captureId: string }
  | { kind: "cancel" }      // hide WITHOUT exit animation (user never sees)
  | { kind: "dismiss" }     // hide WITH exit animation (user clicked X / auto-dismiss)
}
```

**Renderer effects:**

- `FloatOverForCapture` becomes `FloatOverHost` — listens to `events:float-over:state`, owns the state machine, conditionally renders `<FloatOver>` only when `LOADED`. No more `useEffect` reading `?capture=…` from the URL hash.
- The 220ms exit-animation `setTimeout` gets a ref + cleanup-on-unmount, killing root-cause #1 of Bug 2.
- `library:byId` is fetched in the LOADED branch effect, with proper AbortSignal so a rapid re-capture doesn't render stale data.

**Main effects:**

- `float-over.ts` no longer calls `reloadForCapture`. Singleton is created once, shown via `showInactive` once on first IDLE transition, and stays alive until app quit.
- New helper `setFloatOverState(state)` posts the IPC event AND drives window show/hide.
- New AbortController on the main side so a cancel mid-load aborts the renderer's `library:byId` dispatch (renderer also bails via its own `cancelled` flag, but main-side abort kills the in-flight better-sqlite3 read if it's still pending).

Effort: ~250 LOC. Largely renderer state-machine plus protocol additions.

### Solution 3 — Pre-show float-over under selector (Bugs 2 + 3)

Composes Solution 2. The full capture lifecycle:

```
T=0 ms     User triggers capture (⌘⇧P / tray button / agent)
T=0–10     hideTrayPopover() (Sol. 1) + 50ms compositor wait
T=60–180   captureScreen() — full-display screencapture
T=180      Selector window: setSimpleFullScreen + show — covers display
T=181      setFloatOverState({ kind: "show-idle" }) — float-over orders front at "floating" level
              (selector is at "screen-saver"; float-over is hidden behind selector)
T=…        User drags / pans / cancels / commits
T=user+0   ON COMMIT:
             setFloatOverState({ kind: "show-loaded", captureId }) — populate (still under selector)
             selector.hide() — selector vanishes, float-over revealed at correct position, no flash
             activateApp(previousAppPid) — defer until AFTER float-over is up so it wins z-order
T=user+0   ON CANCEL:
             setFloatOverState({ kind: "cancel" }) — float-over hides synchronously
             setTimeout(50ms) — compositor flushes the float-over disappearance
             selector.hide() — user sees nothing else flicker; selector → previous app
             activateApp(previousAppPid)
```

**Why this kills Bugs 2 + 3:**

- Bug 2: there's no post-capture show race. Float-over is already showing under the selector. Selector hide reveals it instantly. macOS doesn't get a chance to focus-resolve.
- Bug 3: the library is never re-raised because the float-over show happens INSIDE the selector-active window, when PwrSnap is unambiguously the active app (selector is at `screen-saver` level and Cocoa treats us as frontmost). When we deactivate (via `activateApp` after the user commits), the float-over is already established on-screen with `floating` level — it stays on top of the previous app's windows, but the library (level 0) goes back behind the previous app naturally.

**Window levels (REVISED per industry research):**

- Selector: `screen-saver` (1000) — covers menu bar via setSimpleFullScreen ✓ (current)
- Float-over: change from `pop-up-menu` (101) to **`floating` (3)** — matches CleanShot / Shottr / macshot. `pop-up-menu` is documented as "above legitimate menus and feels wrong for persistent panels" and Apple's own guidance discourages levels above `screen-saver` for non-screen-saver windows. `floating` is the right level for a toast.
- Library / Edit: normal (0) — unchanged.

**Tray popover:** unchanged at `popover` vibrancy + screen-saver-equivalent z behavior; only addition is the explicit `hide()` from Solution 1.

Effort: ~150 LOC (mostly main-process choreography + level swap). Depends on Solution 2.

### Solution 4 — Defer `activateApp(previousAppPid)` until float-over is up (Bug 2 belt-and-suspenders)

Even with Solution 3, there's an edge case: a capture taken via `capture:interactive` from an agent (no UI selector — but a snapshot is still taken). For that path, the pre-show-under-selector trick doesn't apply because there's no selector. In that case:

```ts
// main/handlers/capture-handlers.ts
async function persistAndShowFloatOver(...) {
  const record = await persistAndBroadcast(...);
  setFloatOverState({ kind: "show-loaded", captureId: record.id });
  // ONLY now: activate previous app, after the toast is up
  if (previousAppPid !== null) await activateApp(previousAppPid);
  return record;
}
```

For the interactive flow, `activateApp` already runs in `hideAllSelectors`. Solution 3's choreography moves the activation to AFTER `selector.hide()` AND AFTER the float-over is in LOADED state — order-of-operations enforces correctness.

Effort: ~30 LOC. Threading `previousAppPid` from `pickRegion` result up to the handler.

## Technical Approach

### Architecture

#### Process layout (no change)

Same as Phase 1: main / preload / 6 renderer stages. The float-over stage now hosts a more complex state machine but still in the same `#stage=float-over` URL.

#### IPC contract additions

```ts
// packages/shared/src/ipc.ts
export const EVENT_CHANNELS = {
  // ...existing
  floatOverState: "events:float-over:state"  // NEW
} as const;

// packages/shared/src/protocol.ts — no Commands additions; this is event-only
```

#### State machine implementation

Renderer side (`features/float-over/FloatOverHost.tsx` — new, replaces FloatOverForCapture):

```tsx
type State =
  | { kind: "hidden" }                       // post-dismiss, pre-first-show
  | { kind: "idle" }                         // pre-show under selector, no capture yet
  | { kind: "loading"; captureId: string }   // populate fired, library:byId in flight
  | { kind: "loaded"; record: CaptureRecord }
  | { kind: "error"; message: string };

// Subscribes to events:float-over:state on mount
// Renders <FloatOver/> only when state.kind === "loaded"
// IDLE renders an empty <div /> (placeholder for the window's "lit" status)
// LOADING shows a thin shimmer skeleton (NOT a "Loading…" text — under the selector
//   the user never sees it; on a slow library:byId during agent flow, the user still
//   sees "something there" rather than a blink)
```

Main side (`main/float-over.ts` — refactored):

```ts
type FloatOverState =
  | { kind: "hidden" }
  | { kind: "idle" }
  | { kind: "loaded"; captureId: string }
  | { kind: "cancelling" };

let state: FloatOverState = { kind: "hidden" };

function setFloatOverState(next: ServerFloatOverEvent): void {
  // 1. transition state machine
  // 2. emit IPC event
  // 3. drive window show/hide accordingly
}
```

#### Tray-hide helper

```ts
// main/tray.ts (additions)
export function hideTrayPopoverIfVisible(): void {
  if (trayWindow !== null && !trayWindow.isDestroyed() && trayWindow.isVisible()) {
    trayWindow.hide();
  }
  // Cancel any pending blur-debounce so we don't get a double-hide jitter.
  if (pendingDismiss !== null) {
    clearTimeout(pendingDismiss);
    pendingDismiss = null;
  }
}
```

Called from `pickRegion` (line ~159) and from `bus.dispatch("capture:fullScreen")` etc. Any path that initiates a screen snapshot.

#### Selector + float-over choreography

```ts
// main/capture/region-selector.ts (pickRegion)
export async function pickRegion(opts): Promise<SelectorResult> {
  // ...display selection, snapshot capture (after tray hide)...

  // NEW: pre-show float-over under the selector (at "floating" level,
  // selector at "screen-saver" covers it).
  setFloatOverState({ kind: "show-idle" });

  // selector show, mode IPC, etc — unchanged
  enterMenuBarOverlayMode(win);
  win.show();

  // ...await user input...

  return result;
}

// main/handlers/capture-handlers.ts (capture:interactive handler)
const selection = await pickRegion({ mode });
if (!selection.ok) {
  // CANCEL path
  setFloatOverState({ kind: "cancel" });
  await new Promise(r => setTimeout(r, 50));      // compositor flush
  // selector already hidden by hideAllSelectors at this point
  return err({ ... });
}

// COMMIT path
const record = await persistAndBroadcast(...);
setFloatOverState({ kind: "show-loaded", captureId: record.id });
// hideAllSelectors already ran activateApp; the show-loaded above happens
// while we're still the frontmost app conceptually (selector window was
// active until just now). Defer activateApp move per Solution 4.
return ok(record);
```

The order of `hideAllSelectors` calls matters — it currently runs INSIDE the result handler in `region-selector.ts`. For Solution 3, we need the float-over LOADED state to be established BEFORE the selector hides, so the hide reveals an already-painted toast. Refactor:

```ts
// region-selector.ts — refactored result handler
ipcMain.on(SELECTOR_RESULT_CHANNEL, (_event, payload) => {
  if (pendingResolver === null) return;
  const resolver = pendingResolver;
  pendingResolver = null;

  // Build the SelectorResult (same as today)
  const result = buildResult(payload);

  // RESOLVE FIRST — capture handler runs persistence + setFloatOverState({loaded})
  resolver(result);

  // hideAllSelectors moved out of here. Caller (capture-handlers) runs it
  // AFTER setFloatOverState so the selector hide reveals an already-painted toast.
});
```

This is the load-bearing reorder. It changes the lifecycle contract of `pickRegion`: the SELECTOR DOES NOT HIDE UNTIL THE CALLER FINISHES PROCESSING THE RESULT. New helper:

```ts
// region-selector.ts
export function hideSelector(): void {
  hideAllSelectors();
}
```

Caller:

```ts
// capture-handlers.ts
const selection = await pickRegion({ mode });
try {
  if (!selection.ok) {
    setFloatOverState({ kind: "cancel" });
    await new Promise(r => setTimeout(r, 50));
    return err({...});
  }
  const record = await persistAndBroadcast(...);
  setFloatOverState({ kind: "show-loaded", captureId: record.id });
  return ok(record);
} finally {
  hideSelector();             // selector goes away last — no flash on either path
  if (selection.ok) {
    // (Solution 4) defer prev-app activate to after the toast is established
    if (previousAppPid !== null) await activateApp(previousAppPid);
  }
}
```

The `previousAppPid` field needs to be added to `SelectorResult` (currently captured inside `region-selector.ts` and consumed only there). Threading it through is a small protocol change.

### Database schema

No schema change. Pure window-management refactor.

### Implementation Phases

#### Phase 1: Tray hide before snapshot (independent, lands first)

**Goal:** Tray popover never appears in capture snapshots, regardless of the rest of this plan landing.

Tasks:
- [ ] Add `hideTrayPopoverIfVisible()` export in `main/tray.ts` — synchronous `hide()` + clear pending blur debounce.
- [ ] Call from `region-selector.ts:pickRegion()` immediately before `captureAndRegister(displayId)`.
- [ ] Add `await new Promise(r => setTimeout(r, 50))` after the hide for compositor flush.
- [ ] Same call sites in any future `capture:fullScreen` / `capture:window` interactive paths (currently stubbed but threading the call now is cheap).
- [ ] E2E test (Playwright): trigger capture from tray Auto button, assert the saved capture PNG does not contain the tray popover. Pixel-compare a known patch in the captured PNG that should be desktop-only against a fixture; allow ±5% tolerance for compositor variance.

Verification: Manual. Take a capture from the tray Auto button. The captured PNG must not show any PwrSnap chrome. Repeat from Region and Window buttons.

Effort: 0.5 day.

#### Phase 2: Persistent float-over renderer + IPC state machine

**Goal:** Eliminate the `loadURL` reload pattern. The float-over is alive once and lit/unlit via IPC. Stale exit-animation timers can no longer fire across captures.

Tasks:
- [ ] **Add `events:float-over:state` event channel** to `packages/shared/src/ipc.ts`. Payload type added to `packages/shared/src/protocol.ts` (or a new `events.ts` if we want event payloads separate from request/response Commands).
- [ ] **Refactor `main/float-over.ts`:**
  - [ ] Replace `showFloatOverForCapture(captureId)` with `setFloatOverState(event)`. Internal state machine drives `showInactive() / hide()` based on transitions.
  - [ ] Drop `reloadForCapture()` entirely. Float-over loads once at first IDLE.
  - [ ] First `setFloatOverState({ kind: "show-idle" })` call lazily creates the singleton (preserves boot-time invariant — no float-over window unless capture flow runs).
  - [ ] `setFloatOverState({ kind: "cancel" })` calls `singleton.hide()` synchronously, NO exit animation, NO IPC to renderer's exit-fader.
  - [ ] `setFloatOverState({ kind: "show-loaded" })` posts IPC; renderer transitions LOADED + starts countdown.
- [ ] **Refactor renderer:**
  - [ ] Rename `FloatOverForCapture.tsx` → `FloatOverHost.tsx`. Owns the state reducer; renders `<FloatOver/>` only on LOADED.
  - [ ] Subscribe to `events:float-over:state` via `pwrsnapApi.on(...)`.
  - [ ] Drop the `?capture=…` hash parser — captureId now comes via IPC.
  - [ ] **Track and clear the 220ms exit-animation timer** in `FloatOver.tsx`:
    ```ts
    const exitTimerRef = useRef<number | null>(null);
    const dismissNow = () => {
      setExiting(true);
      exitTimerRef.current = window.setTimeout(() => onDismiss?.(), 220);
    };
    useEffect(() => () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    }, []);
    ```
  - [ ] `FloatOver` unmount on state transition to HIDDEN/IDLE; exit timer is cleaned up.
- [ ] **Update `App.tsx` stage router** to mount `<FloatOverHost/>` for `#stage=float-over` (the URL-hash router stays — only the inner data-fetch mechanism changes).
- [ ] **Wire ⌘1/⌘2/⌘3** off the renderer's persistent keydown listener. Listener stays mounted across state transitions; no remount-induced gaps.
- [ ] **Acceptance:** rapid double-capture (⌘⇧P → commit → ⌘⇧P → commit within 1s) shows the toast for the SECOND capture for the full ≥5s, not for 220ms. No stale-timer flash.

Effort: 1.5 days.

#### Phase 3: Pre-show under selector + lifecycle reorder

**Goal:** Float-over reliably shown after every commit. No focus jump. No library re-raise. Builds on Phase 2's persistent renderer.

Tasks:
- [ ] **Refactor `region-selector.ts`:**
  - [ ] Add `hideSelector()` export — what `hideAllSelectors` does today, but called explicitly by the consumer rather than from inside the result handler.
  - [ ] Result handler resolves the promise and STOPS — does not call `hideAllSelectors` itself. Comment marks the contract change clearly.
  - [ ] `pickRegion` calls `setFloatOverState({ kind: "show-idle" })` BEFORE `win.show()` for the selector. The float-over is at `floating` level; the selector at `screen-saver` covers it. User never sees the empty toast.
- [ ] **Refactor `capture-handlers.ts:capture:interactive`:**
  - [ ] On result, branch:
    - **OK:** `await persistAndBroadcast`, `setFloatOverState({ kind: "show-loaded", captureId })`, then `hideSelector()` in finally. Order-of-operations: load BEFORE hide so the reveal is instant.
    - **CANCEL:** `setFloatOverState({ kind: "cancel" })`, sleep 50ms, then `hideSelector()`. User sees nothing flicker.
  - [ ] Move `activateApp(previousAppPid)` from `hideAllSelectors` to here — runs AFTER `hideSelector` returns AND AFTER the float-over is established on screen. Thread `previousAppPid` through `SelectorResult`.
- [ ] **Headless `capture:region` path** (agents, no selector): no change — the selector flow doesn't apply. The float-over still shows post-capture via `setFloatOverState({ kind: "show-loaded" })` directly. No "pre-show" because there's no selector to hide behind.
- [ ] **Change float-over level from `pop-up-menu` → `floating`** in `main/window.ts:createFloatOverWindow`. Matches industry-standard NSWindowLevel 3 for persistent toasts.
- [ ] **Acceptance:** the full capture flow (tray Auto → drag → commit) ends with the float-over visible AND the previously-frontmost app still frontmost. The library window's z-position is identical before and after the capture. Verified by inspection of `tools.frontmostApplication()` (NSWorkspace) before and after, and a screenshot showing the toast.

Effort: 1 day.

#### Phase 4: E2E visibility tests

**Goal:** Future regressions of Bug 2 are caught before they ship. The current e2e suite is data-only; add visual.

Tasks:
- [ ] **Add `e2e/specs/float-over-visibility.spec.ts`** (new spec file). Pattern:
  ```ts
  test("float-over toast visible after capture", async ({ electronApp, page }) => {
    await electronApp.evaluate(({ globalThis }) =>
      globalThis.__PWRSNAP_TEST__.dispatch("capture:region", {
        rect: { x: 100, y: 100, w: 200, h: 200 },
        displayId: 1
      })
    );
    // Wait 100ms (within budget)
    await page.waitForTimeout(100);

    // Take a screenshot of the float-over window's content frame
    const floatOverWin = await electronApp.firstWindow({
      // Match by stage hash — but we need a way to grab it. Use win.url().
      // Alternative: assert visibility via main-side: getAllWindows.find(w => stage hash) → isVisible.
    });
    expect(await floatOverWin.isVisible()).toBe(true);

    // Wait 4s, assert STILL visible (countdown is 5s default).
    await page.waitForTimeout(4000);
    expect(await floatOverWin.isVisible()).toBe(true);

    // Wait 2s more (total 6.1s) — countdown done, exiting animation fired, hidden.
    await page.waitForTimeout(2000);
    expect(await floatOverWin.isVisible()).toBe(false);
  });
  ```
- [ ] **Add a "rapid double-capture" spec** that asserts the second toast lives ≥ 4s after firing both captures within 500ms — directly catches Bug 2 root-cause #1.
- [ ] **Add a "library z-order" assertion** — read NSWorkspace frontmost-app via the test bridge before and after a capture; assert it's unchanged.
- [ ] **Add a "tray-in-snapshot" spec** that captures from the tray Auto button and asserts the captured PNG's bottom-right corner doesn't have a popover-shaped patch. Pixel-compare or image-diff against a desktop-only fixture.

Effort: 0.5 day.

#### Phase 5: Optional follow-ups

Not required for this plan but worth tracking:

- [ ] **App activation policy.** Switching PwrSnap to `LSUIElement: YES` (no dock icon by default; `app.dock.show()` only when a Library/Edit window opens) would eliminate the entire class of "PwrSnap activates inadvertently" bugs. Industry standard for menubar apps. Defer to a separate plan because it changes the user-visible surface (Mission Control behavior, dock icon presence) and deserves a focused decision.
- [ ] **Unify the screen-snapshot lifecycle.** Currently the snapshot is taken in `pickRegion` and released by capture-handlers OR hideAllSelectors. With Phase 3's lifecycle reorder, the ownership transfer becomes more explicit and could be modeled as a context-manager-ish helper. Improvement, not required.

## Alternative Approaches Considered

### A1 — Surgical fixes only (no pre-show)

Fix Bug 2 by:
1. Tracking + clearing the 220ms exit timer (root cause #1)
2. Deferring `activateApp(previousAppPid)` until AFTER `showFloatOverForCapture` (root cause #2)
3. Switching float-over level to `screen-saver` (above-everything, beats activation race)

Pros: ~80 LOC change, no architectural shift, ships in half a day.

Cons:
- Doesn't fix Bug 3 (library jump) cleanly — still depends on activation timing.
- Doesn't address the renderer reload cost — every capture re-mounts React, reparses CSS, re-establishes IPC subscriptions. Latency not user-visible at one capture but accumulates over a session.
- `screen-saver` level for the toast is industry-anti-pattern (Apple discourages; conflicts with the selector itself when both are up).

**Rejected** because the user explicitly designed the pre-show architecture and it solves all three bugs simultaneously with a defensible architectural footprint.

### A2 — App activation policy switch (LSUIElement)

Switch PwrSnap to `LSUIElement: YES` so the app doesn't have a dock icon by default. Window shows don't trigger app activation. macshot, CleanShot, Shottr all do this.

Pros: eliminates the entire focus-flash class of bugs.

Cons:
- User-visible: no dock icon means no Cmd+Tab presence, no Mission Control surface, different "where is this app" behavior. Library window now needs an explicit "show in dock" toggle.
- Tray-only-mode is the natural state — the founder would need to opt INTO the dock-icon behavior.
- Bigger user-facing change than the current bug warrants.

**Deferred** to Phase 5 / a separate plan. We can land Solutions 1–4 without changing activation policy and revisit if the focus-flash class re-emerges.

### A3 — Screen-saver level for float-over

Bump float-over to `setAlwaysOnTop(true, "screen-saver")` so it ALWAYS wins z-order regardless of app activation.

Pros: dead simple. One-line change.

Cons:
- Conflicts with the selector at the same level — they'd race for top z.
- Apple guidelines: only screensavers should use that level. Other apps using it get a "feels wrong" UX (covers actual screensavers, system passwords prompts, etc.).
- Overkill — `floating` level + correct activation order achieves the same end.

**Rejected.**

### A4 — Lift NSPanel-style accessory window via a Swift helper

Build a Swift helper that renders the toast as an `NSPanel` with `.nonactivatingPanel` style mask. Native AppKit pattern; doesn't activate the owning app on order-front.

Pros: bulletproof. macOS-native.

Cons: third native helper (after window-list, future RecordKit). Adds Swift+Objective-C maintenance. The web tooling we have (Electron + React) already handles 95% of the case. The remaining 5% is solvable in pure JS via Solutions 1–4.

**Rejected.**

## System-Wide Impact

### Interaction Graph

#### Existing post-capture flow (broken):

```
runInteractiveCapture (index.ts:122)
└── bus.dispatch("capture:interactive")
    └── handler in capture-handlers.ts
        └── pickRegion (region-selector.ts:158)
            ├── captureAndRegister                  # screen snapshot
            ├── win.show() / enterMenuBarOverlayMode # selector visible
            ├── (await user input)
            └── result handler:
                ├── pendingResolver(result)         # back to handler ↑
                └── hideAllSelectors()
                    └── activateApp(previousAppPid) # ⚠️ races with float-over show
        ├── persistAndBroadcast                     # capture row, render warmup
        │   └── webContents.send capturesChanged    # broadcasts to all windows
        └── (return record)
    (back to runInteractiveCapture)
└── showFloatOverForCapture(record.id)
    ├── reloadForCapture                            # ⚠️ async; in-flight setTimeout(220) survives
    ├── anchorBottomRight
    ├── showInactive                                # ⚠️ pop-up-menu level, app already deactivating
    └── moveTop                                     # raises within level only
```

#### Proposed flow (fixed):

```
runInteractiveCapture
└── bus.dispatch("capture:interactive")
    └── handler:
        └── pickRegion
            ├── hideTrayPopoverIfVisible            # NEW (Solution 1)
            ├── (50ms compositor wait)
            ├── captureAndRegister                  # screen snapshot CLEAN
            ├── setFloatOverState({show-idle})      # NEW: pre-show under selector
            ├── win.show() / enterMenuBarOverlayMode
            ├── (await user input)
            └── result handler:
                └── pendingResolver(result)         # NO hideAllSelectors here
        ├── try:
        │   ├── if commit:
        │   │   ├── persistAndBroadcast
        │   │   └── setFloatOverState({show-loaded, captureId})  # populate, countdown starts
        │   └── if cancel:
        │       ├── setFloatOverState({cancel})     # synchronous hide
        │       └── (50ms compositor wait)
        └── finally:
            ├── hideSelector()                      # selector vanishes — float-over revealed
            └── if previousAppPid: activateApp()    # NEW: deferred to AFTER toast shown
```

### Error & Failure Propagation

- **Tray hide fails (window destroyed mid-flight):** `hideTrayPopoverIfVisible` is null-safe; no-op on destroyed window. The 50ms compositor wait still fires; capture proceeds. No regression.
- **Pre-show IPC fires but renderer not yet listening:** First-launch race. The renderer mounts at `app.whenReady`'s `createMainWindow` for the float-over singleton. Float-over isn't created until first `setFloatOverState({show-idle})`, which happens INSIDE `pickRegion`. The window is created lazily; `webContents.once('did-finish-load', ...)` queues the IPC if the renderer isn't ready. We can buffer the latest state and re-send on `dom-ready` — small additive logic in `setFloatOverState`.
- **Cancel hide → selector hide race:** the 50ms compositor wait is the buffer. If macOS's compositor is overloaded (test runner, heavy GPU usage), 50ms might not be enough. Bump to 100ms only if validated necessary; longer is user-visible delay.
- **`activateApp` after toast established:** if the previous app has quit (race: user kills it during the selector being up), `activateApp` no-ops gracefully. The toast stays up; PwrSnap stays the active app; library doesn't auto-raise because we never call `library.show()`.
- **Float-over already in LOADED state when new capture starts:** the prior toast is mid-countdown. Pre-show fires `setFloatOverState({show-idle})` again. Main reducer detects state→state; for `LOADED → IDLE` it transitions immediately and clears the prior captureId. Renderer unmounts `<FloatOver/>`, the 220ms exit timer is cleaned (Phase 2 ref-tracking), no stale fire.

### State Lifecycle Risks

- **Pre-shown idle float-over orphaned:** if the main process crashes between `setFloatOverState({show-idle})` and `pickRegion` returning, the float-over remains on screen until app restart. Mitigation: `app.on("before-quit", () => setFloatOverState({cancel}))` — reuses the cancel path.
- **Multiple displays, selector on different display than cursor at commit time:** the float-over's bottom-right anchor uses `screen.getCursorScreenPoint()` at show-idle time, BEFORE the user commits. If they drag the cursor to display 2 then commit, the toast stays on display 1 (where it was pre-shown). For Phase 1 this is acceptable. Phase 2 of THIS plan can revisit if the founder finds it annoying.
- **Snapshot release vs cancel:** Solution 1's tray-hide doesn't change snapshot lifecycle. Solution 3's reorder means `releaseSnapshot` (in capture-handlers) still runs in finally, regardless of cancel/commit, after `hideSelector`. No leak.
- **Headless `capture:region` (agent path) doesn't hit pre-show:** the agent skips `pickRegion`. setFloatOverState is called directly post-persist. The float-over still appears. Tested by an agent-flow e2e spec.

### API Surface Parity

- The command-bus surface gains nothing new. `capture:interactive` semantics unchanged from the caller's perspective (still returns `Result<CaptureRecord>`).
- The IPC event surface gains `events:float-over:state`. Renderer-only consumer (the float-over). No tests need updating outside the float-over.
- The `pickRegion` internal lifecycle changes: previously self-contained (it hid itself); now requires the caller to call `hideSelector()`. This is documented in a new comment block at the top of `region-selector.ts` and enforced by removing `hideAllSelectors()` from the result handler. Two callers today (capture-handlers and the e2e bridge — if any); both updated.

### Integration Test Scenarios

1. **Fast-fingered double capture.** ⌘⇧P → commit → ⌘⇧P → commit, both within 800ms. Assert: float-over for capture #2 visible for ≥ 4s, NOT 220ms. Catches Phase 2 root-cause #1.
2. **Tray Auto → cancel via Esc.** Assert: tray popover hidden BEFORE snapshot (no popover in snapshot file); snapshot taken; float-over pre-shown under selector; user presses Esc; selector hides; user observes nothing happen (toast was hidden first; selector hide reveals desktop). NSWorkspace.frontmostApplication unchanged across the flow.
3. **Tray Auto → commit.** Same as #2 but commit. Assert: snapshot clean; float-over LOADED with the captureId; ≥ 4s visibility; NSWorkspace.frontmostApplication is the previously-frontmost (NOT PwrSnap).
4. **Headless `capture:region` (agent flow).** Bus dispatch with `{rect, displayId}`. No selector. Assert: capture row inserted, float-over LOADED, ≥ 4s visible. Pre-show path correctly skipped.
5. **Float-over hover during countdown.** Trigger capture, observe toast, mouseEnter the float-over window region (test bridge synthesizes mouseEnter). Wait 5.5s. Assert: still visible. mouseLeave. Wait 5.5s. Assert: hidden.
6. **Library z-order invariant.** Pre-capture: NSWorkspace.frontmost = "Slack". ⌘⇧P → commit. Post-capture: NSWorkspace.frontmost = "Slack". Library window's z-index in PwrSnap.getAllWindows() identical to pre-capture.
7. **PwrSnap-only capture (capturing self).** User opens tray, clicks "Timed (5s)" — wait, that mode isn't implemented yet; replace with: user runs `screencapture -T 5` externally; PwrSnap not involved. Out of scope — this plan is about ensuring tray ISN'T in the capture, not about how to capture PwrSnap intentionally.

## Acceptance Criteria

### Functional Requirements

- [ ] After clicking tray → Auto / Region / Window, the resulting captured PNG contains zero PwrSnap UI (tray popover, menu items, selector chrome, float-over).
- [ ] After every successful commit (⌘⇧P or tray button), the float-over toast is visible at bottom-right of the cursor's display for ≥ 5 seconds (default countdown), with no flicker, no flash, no occlusion by other PwrSnap windows.
- [ ] After every successful commit, the previously-frontmost app remains frontmost. The Library window does not change z-position, does not unminimize, does not steal focus.
- [ ] On Esc / cancel, no float-over flash. The user's view returns to the previously-frontmost app cleanly.
- [ ] Hovering the float-over pauses the countdown; leaving resumes it. Clicking inside cancels auto-dismiss until explicit user action.
- [ ] ⌘1 / ⌘2 / ⌘3 inside the float-over copy the rendered PNG at low / med / high preset to the clipboard. ⌘ Edit (or the Edit button) opens the editor — float-over stays put.
- [ ] Headless `capture:region` (agent path) shows the float-over for the same duration with no flash.

### Non-Functional Requirements

- [ ] **Latency:** ⌘⇧P → selector visible: same budget as today (< 200ms cold, < 80ms warm). The added tray-hide + 50ms wait apply only to the tray-button path (where the tray is open); ⌘⇧P from another app never hits the tray-hide branch.
- [ ] **Float-over show latency post-commit:** instantaneous (≤ 16ms) from selector-hide. The toast is already painted; the reveal is one compositor frame.
- [ ] **No regression in capture latency:** the snapshot capture itself (`screencapture -R bounds`) unchanged. Tray-button path adds 50ms compositor wait — acceptable for a button click.
- [ ] **Memory:** the persistent float-over renderer keeps a React tree alive across captures. Sub-MB. Negligible.

### Quality Gates

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` 122/122 (current count) plus new specs pass.
- [ ] `pnpm test:e2e` (Playwright suite) green, including the new visibility specs.
- [ ] Manual smoke on real macOS — Sonoma 14, Sequoia 15. Single + multi-display. Tray + ⌘⇧P + agent-flow. All three buttons (Auto / Region / Window).

## Success Metrics

- **Before/after capture frame contains tray UI:** before = "always when triggered from tray"; after = "0 of 100 captures from tray contain PwrSnap chrome".
- **Float-over visibility duration p50:** before = "1ms (or invisible)"; after = "5000ms ± 50ms (countdown duration ± animation tolerance)".
- **Library z-order invariant violations:** before = "every capture from a non-PwrSnap-frontmost app"; after = "0 violations across the integration test suite".
- **E2E spec count for visual reliability:** before = 0 specs that visually assert toast presence; after = ≥ 4 specs (toast visible, double-capture survival, hover-pause, library z-order).

## Dependencies & Prerequisites

- No new npm dependencies. All work uses existing Electron APIs + sharp.
- No new native binaries.
- No schema migrations.
- Playwright already wired (per Phase 1 e2e harness). New specs add to existing suite.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 50ms compositor wait insufficient on heavily-loaded systems | Low | Med | Validate on stress-test (concurrent video render). If marginal, bump to 80ms. Beyond that, pivot to a frame-callback (`requestAnimationFrame` × 3) instead of `setTimeout`. |
| `setFloatOverState({show-idle})` IPC arrives before renderer mounts | Med | Low | Buffer last-state in main; re-emit on `dom-ready`. Also: pre-warm float-over renderer at boot (lazy create on whenReady, not on first capture) — adds <1MB resident memory. |
| `floating` level too low — gets covered by another app's `floating`-level windows (e.g. floating utility palettes) | Low | Med | Industry standard at this level; collisions are rare. If observed, bump to a custom level above `floating` but below `pop-up-menu` (NSWindowLevel 50, no Cocoa name) via direct setLevel. Defer until observed. |
| Pre-show under selector causes a 1-frame flash on slow machines (selector takes 16+ms to paint, float-over visible during that gap) | Low | Low | Order: float-over `showInactive` AFTER selector `show`. Selector at screen-saver covers float-over instantly. If still observed, add an explicit `process.nextTick`-deferred float-over show. |
| Library window IS supposed to come up in some capture flows (e.g. the user's first capture, where they want to see the result) | Low | Low | Out of scope for this plan. Library shows via explicit `library:focus` only. If a "first-capture wizard" lands later, that surface gets its own raise call. |
| Headless `capture:region` agent path bypasses pre-show; behavior asymmetric | Med | Low | Documented and tested. Agents don't need pre-show; they just want the toast to appear post-capture, which it does. |
| Activation deferral leaves PwrSnap as frontmost briefly (between selector hide and `activateApp` returning) | Med | Low | The ~10ms window where PwrSnap is technically frontmost is invisible to the user — no PwrSnap window is at non-floating level (selector just hid; float-over is at floating). The dock icon flickering is the only visible effect, and it's well below noticeable. |

## Resource Requirements

- Solo founder + Claude. ~3 days of focused work to land all four phases.
- Phase 1 lands first (independent, half-day) — immediate user benefit.
- Phases 2–4 land together as a unit; Phase 4 (e2e specs) is enforced before Phase 3 ships to prevent regression.

## Future Considerations

- **Codex integration.** Phase 4 of the buildout plan adds Codex AI suggestions to the float-over (auto-annotate, blur, tag). The IDLE → LOADED state machine lands cleanly because Codex can stream into the LOADED state via additional events (`events:float-over:codex` for incremental updates). Pre-show puts the toast on screen before Codex even sees the image — natural latency hiding for the AI fan-out.
- **Persistent thumbnails.** CleanShot-style "pin a screenshot to the desktop" would extend the LOADED state with a `pinned` substate that disables auto-dismiss and stays on screen indefinitely. Trivial extension to the state machine.
- **Multi-display float-overs.** Today's anchor uses cursor's display at pre-show time. A future enhancement could re-anchor on commit if the cursor moved displays during selection. Defer until requested.
- **Sizzle composer post-capture.** Phase 6 of the buildout plan adds the sizzle reel composer. The float-over could grow a "Add to reel" button when a reel is open. Trivial UI addition; no architectural impact.

## Documentation Plan

- Update `docs/architecture/overview.md` (when it lands) with the float-over state machine and pre-show choreography. Reference this plan as origin.
- Add a new `docs/solutions/2026-05-04-tray-not-in-snapshot.md` after Phase 1 lands — small note about the 50ms compositor wait and why explicit hide is needed even though `NSStatusItem` should auto-dismiss. Saves the next dev hours of head-scratching.
- Comment the `region-selector.ts` lifecycle reorder thoroughly. The "result resolver no longer hides the selector" change is non-obvious; future devs need a comment block explaining why.

## Sources & References

### Internal References

- [apps/desktop/src/main/tray.ts](../../apps/desktop/src/main/tray.ts) — `BLUR_DISMISS_DEBOUNCE_MS = 120`; tray window lifecycle. `hideTrayPopoverIfVisible` lands here.
- [apps/desktop/src/main/capture/region-selector.ts](../../apps/desktop/src/main/capture/region-selector.ts) — `pickRegion` lifecycle; `hideAllSelectors` extraction; `activateApp` deferral.
- [apps/desktop/src/main/capture/screen-snapshot.ts](../../apps/desktop/src/main/capture/screen-snapshot.ts) — snapshot capture; tray-hide call site.
- [apps/desktop/src/main/float-over.ts](../../apps/desktop/src/main/float-over.ts) — singleton lifecycle; `setFloatOverState` rewrite; lazy creation.
- [apps/desktop/src/main/window.ts:160](../../apps/desktop/src/main/window.ts) — float-over window creation; `setAlwaysOnTop` level change `pop-up-menu` → `floating`.
- [apps/desktop/src/main/handlers/capture-handlers.ts](../../apps/desktop/src/main/handlers/capture-handlers.ts) — `capture:interactive` lifecycle reorder; `hideSelector()` call site; `activateApp` deferred call.
- [apps/desktop/src/main/index.ts:122](../../apps/desktop/src/main/index.ts) — `runInteractiveCapture` no longer calls `showFloatOverForCapture`; capture-handlers owns the toast lifecycle now.
- [apps/desktop/src/renderer/src/features/float-over/FloatOver.tsx:177,196](../../apps/desktop/src/renderer/src/features/float-over/FloatOver.tsx) — exit timer ref + cleanup.
- [apps/desktop/src/renderer/src/features/float-over/FloatOverForCapture.tsx](../../apps/desktop/src/renderer/src/features/float-over/FloatOverForCapture.tsx) — renamed → `FloatOverHost.tsx`; state-machine reducer; `events:float-over:state` subscription.
- [packages/shared/src/ipc.ts](../../packages/shared/src/ipc.ts) — `EVENT_CHANNELS.floatOverState` constant.
- [packages/shared/src/protocol.ts](../../packages/shared/src/protocol.ts) — `FloatOverEvent` payload type (event-only, not a Command).
- [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md) — Phase 1 framing; the float-over singleton + state-machine pattern was specified there but only IDLE → SHOWING → COPYING was sketched; this plan formalizes IDLE as "pre-show under selector" and adds the IPC event channel.

### External References

- [macshot CLAUDE.md (sw33tLie/macshot)](https://github.com/sw33tLie/macshot/blob/main/CLAUDE.md) — primary reference for the macOS-native pattern: post-show + `orderFrontRegardless` + `previousApp.activate(.activateIgnoringOtherApps)`. PwrSnap diverges via PRE-show-under-selector for the focus-flash fix; both designs prevent the user-visible flicker, with PwrSnap's variant additionally insulating against renderer-mount races by keeping the renderer always-mounted.
- [Electron BrowserWindow docs — setAlwaysOnTop levels](https://www.electronjs.org/docs/latest/api/browser-window) — `floating` is the documented "above other windows" level; `pop-up-menu` is "above floating, used for popup menus". Apple discourages levels above `screen-saver`.
- [Apple NSWindow.orderFront](https://developer.apple.com/documentation/appkit/nswindow/1419660-orderout) and [orderFrontRegardless](https://developer.apple.com/documentation/appkit/nswindow/1419660-orderfrontregardless) — native AppKit primitives. `BrowserWindow.showInactive()` is the Electron analogue of orderFront.
- [CleanShot X auto-close preferences](https://cleanshot.com/features) — 5s default toast countdown; configurable.
- [Shottr FAQ — pinned screenshots](https://shottr.cc/kb/faq) — `floating` level for persistent panels.
- [Electron #7866 — screen-saver level on macOS](https://github.com/electron/electron/issues/7866) — discussion of `screen-saver` vs `pop-up-menu` semantics on Sonoma+.

### Related Work

- The Phase 1 buildout plan (linked above) was the architectural baseline. This plan refines a load-bearing detail (float-over choreography) without changing the macro structure.
- The agent-native parity invariant from Phase 7 of the buildout plan continues to hold: the float-over IPC event is not a Command (no agent calls it), but every UI action exposed by the float-over (copy, edit, dismiss) goes through the existing command bus and is reachable via the headless RPC namespace when Phase 7 lands.
