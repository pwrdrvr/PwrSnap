---
title: Windows GUI port — transparent windows, topmost-while-fullscreen, occlusion, packaging
type: solution
date: 2026-06-08
area: desktop
tags: [windows, win32, cross-platform, float-over, tray, region-selector, transparent-window, setOpacity, alwaysOnTop, occlusion, electron-builder, build-native, e2e, rdp]
---

# Windows GUI port — gotchas

Captured during the Windows GUI port
([PR #218](https://github.com/pwrdrvr/PwrSnap/pull/218); build/test base
[#215](https://github.com/pwrdrvr/PwrSnap/pull/215)). These bit us hard and are
non-obvious — most cost multiple RDP round-trips to diagnose because the symptom
and the cause were in different layers. Read this before touching the tray,
float-over, or region-selector windowing on Windows.

Plan/status: [docs/plans/2026-06-08-001-feat-windows-cross-platform-port-plan.md](../plans/2026-06-08-001-feat-windows-cross-platform-port-plan.md).
macOS window choreography this builds on:
[docs/plans/2026-05-04-001-fix-capture-flow-window-choreography-plan.md](../plans/2026-05-04-001-fix-capture-flow-window-choreography-plan.md).

Key files:

- `apps/desktop/src/main/float-over.ts` — `parkOffScreen` / `restoreOnScreen` /
  `reassertFloatOverTopmost`.
- `apps/desktop/src/main/capture/region-selector.ts` —
  `enterMenuBarOverlayMode` / `leaveMenuBarOverlayMode` / `hideAllSelectors`.
- `apps/desktop/src/main/window.ts` — `createTrayWindow` / `createFloatOverWindow`.
- `apps/desktop/src/main/index.ts` — pre-`whenReady` command-line switches.
- `apps/desktop/scripts/build-native.mjs` — native helper build (Swift vs C++).
- `apps/desktop/electron-builder.yml` — per-platform packaging.

---

## 1. `setOpacity()` on a `transparent: true` window renders it BLANK (the big one)

**Symptom.** The float-over toast was `visible: true`, `alwaysOnTop: true`,
`opacity: 1`, on-screen at the right bounds, alive for its full ~29s lifetime —
and painted **nothing**. Present in every API sense, zero pixels.

**Cause.** The macOS float-over hides itself with an off-screen *opacity-park*
(`setOpacity(0)` + move to `-20000,-20000`) to avoid AppKit's key-window
cascade. On Windows, `transparent: true` paints via **per-pixel alpha**
(`UpdateLayeredWindow`), while `setOpacity()` switches the window to
**whole-window alpha** (`SetLayeredWindowAttributes`). The two are mutually
exclusive. After one `setOpacity(0) → setOpacity(1)` round-trip the per-pixel
compositing is dead and the window can't draw its content. (The pre-existing
code comment "setOpacity(1) doesn't reliably re-surface" was this bug, half-seen.)

**Tell-tale.** The tray window is *also* `transparent: true` and paints fine —
because it uses a plain `hide()`/`show()` cycle and never calls `setOpacity`.
That contrast is the diagnostic: same window flags, only the float-over touched
opacity.

**Fix.** On Windows, never call `setOpacity` on a transparent window. Park with a
real `window.hide()`; restore with `window.showInactive()` + `setAlwaysOnTop(true)`.
macOS/Linux keep the opacity-park (NSPanel key-window-cascade concern is real
there; on Windows it isn't). See `parkOffScreen` / `restoreOnScreen` in
`float-over.ts`, both branched on `process.platform === "win32"`.

> Rule of thumb: on Windows it's `transparent` **xor** `setOpacity` — pick one
> per window, never both.

---

## 2. `setAlwaysOnTop(true)` won't stick while another window is native-fullscreen

**Symptom.** At `show-loaded`, `setAlwaysOnTop(true)` returned, but
`isAlwaysOnTop()` read `false` and the toast sat under the Library. At
`show-idle` (moments earlier) the same call stuck (`true`).

**Cause.** The region selector goes native-fullscreen (to cover the taskbar) and
sits at screen-saver always-on-top. Windows fullscreen exclusivity rejects
making *another* window topmost while the fullscreen window is up. `show-idle`
worked only because the selector wasn't shown yet.

**Fix.** Re-assert topmost **after the selector is gone**, from
`hideAllSelectors` in `region-selector.ts` (the reliable "selector hidden"
point), with short-timer retries (0 / 120 / 400 ms) to cover
`setFullScreen(false)`'s async exit. `reassertFloatOverTopmost()` in
`float-over.ts` is a no-op unless the toast is in the loaded state.

**Two sub-traps inside this one:**

- **Don't `moveTop()` on Windows.** `moveTop()` is `SetWindowPos(HWND_TOP)`,
  which **clears** `WS_EX_TOPMOST` — calling it right after `setAlwaysOnTop(true)`
  drops the window back below the topmost band. macOS uses `moveTop()` (floating
  level); Windows must rely on `setAlwaysOnTop(true)` alone.
- **`leave-full-screen` does NOT fire on Windows**, and `isFullScreen()` stays
  `false` even after `setFullScreen(true)` succeeds (the window *does* grow to
  the full display — taskbar covered — but the state flag and events don't
  follow). So you can't hang the re-raise off the fullscreen event; use the
  hide path. Verified via diagnostics in `enterMenuBarOverlayMode`.

---

## 3. Occluded transparent windows don't repaint over RDP — disable `CalculateNativeWinOcclusion`

**Symptom.** Even after #1 and #2 were fixed, a transparent window first shown
*behind* the fullscreen selector could come up blank when later raised.

**Cause.** Chromium's native window-occlusion tracker marks a fully-covered
window occluded and stops compositing it. Over RDP / remote sessions the
"you're visible again" signal doesn't reliably land when the window is raised,
so it never produces frames.

**Fix.** `app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")`
on win32, before `app.whenReady()` (in `index.ts`). Belt-and-suspenders: a
`webContents.invalidate()` in the reassert nudges a fresh frame. Refs:
electron/electron#25368, #35192.

---

## 4. Region selector must go native-fullscreen to cover the taskbar (the "two taskbars" bug)

**Symptom.** The frozen-screen overlay showed the real taskbar on top of the
screenshot's taskbar — "two taskbars."

**Cause.** The Windows taskbar (`Shell_TrayWnd`) is itself a topmost window, so a
plain always-on-top overlay renders *below* it.

**Fix.** `setFullScreen(true)` on the selector (win32 branch of
`enterMenuBarOverlayMode`); `setFullScreen(false)` on hide. This is the Windows
analogue of macOS `setSimpleFullScreen` covering the menu bar. Note the
`isFullScreen()`-stays-false quirk from #2 — gate the leave call defensively but
don't depend on the state flag. (A one-off `0xC0000005` once coincided with a
tray right-click, not with this; it did not reproduce.)

---

## 5. macOS → Windows window-primitive mapping

When constructing a BrowserWindow that's macOS-tuned, branch these:

- `type: 'panel'` → omit on Windows (`...(process.platform === "darwin" ? { type: "panel" } : {})`).
- `vibrancy` / `visualEffectState` → omit; use `transparent: true` and let the
  renderer paint the surface.
- `setVisibleOnAllWorkspaces`, `setSimpleFullScreen`,
  `setAlwaysOnTop(_, 'floating'|'screen-saver')` → darwin-gated; Windows uses
  plain `setAlwaysOnTop(true)` and (for the selector) `setFullScreen`.
- `fullscreenable` must be `true` on win32 for the selector (it's `false` on
  mac, which uses simple-fullscreen).
- Still required everywhere: `window.setMinimumSize(0, 0)` after construction for
  any window that `setContentSize`s itself later (see the CLAUDE.md note).

See `createTrayWindow` / `createFloatOverWindow` in `window.ts`.

---

## 6. `build-native.mjs` — gate the Windows branch, leave the Swift path untouched

The script builds Swift helpers (window-list, recorder, Quick Look extensions)
on macOS and a C++ `window-list.exe` (via `cl.exe`) on Windows. The win32 branch
runs first and `return`s; a `process.platform !== "darwin"` guard skips other
platforms; the darwin Swift path below is unchanged. **Verify the darwin path
still runs end-to-end** after any edit (`pnpm build:native` on a Mac) — the
macOS DMG depends on it.

---

## 7. electron-builder per-platform `extraResources` MERGE, not replace

Adding `mac.extraResources` / `win.extraResources` does **not** drop the
top-level `extraResources`. `getFileMatchers` (app-builder-lib) calls
`addPatterns(config[name])` then `addPatterns(customBuildOptions[name])` — the
two arrays **concatenate**. So:

- Cross-platform payloads (THIRD_PARTY_LICENSES, CHANGELOG, tray icons) stay
  top-level.
- macOS-only payloads (Swift helpers, ffmpeg, `.appex`) live under `mac:`.
- Windows-only payloads (`window-list.exe`) live under `win:`.

This is why the macOS DMG kept all its resources after the restructure. If you
ever see resources go missing per-platform, this merge semantics is the first
thing to check.

---

## 8. E2E: park behavior is platform-specific — assert accordingly

`float-over-visibility.spec.ts › cancel hides the float-over synchronously`
asserted `opacity === 0` after cancel — the macOS/Linux opacity-park signature.
On Windows the park is a real `hide()`, so `opacity` stays `1` and
`isVisible()` goes `false`. Branch the assertion on `process.platform`:
win32 → `visible === false`; mac/linux → `opacity === 0`. General lesson: any
E2E that asserts on the float-over's hidden state must know which park model the
platform uses.

---

## Meta: how to debug this class of bug efficiently

The float-over investigation took several RDP round-trips because the symptom
("toast not showing") had three independent causes stacked (z-order → topmost →
paint). What shortened it:

1. **Log the window's own view of itself** (`isVisible`, `isAlwaysOnTop`,
   `getOpacity`, `getBounds`) at each state transition — it revealed the window
   *thought* it was visible+topmost, which reframed the problem from "z-order"
   to "paint."
2. **Compare against a working sibling** — the tray is the same transparent
   window class and worked, which isolated the one differing call (`setOpacity`).
3. **Strip the diagnostics once fixed** — the per-show dumps were committed
   temporarily and removed in a follow-up; keep the load-bearing comments, drop
   the noise.
