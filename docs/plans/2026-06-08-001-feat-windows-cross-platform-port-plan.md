---
title: "feat: Windows cross-platform port (Phase 8a)"
type: feat
status: in-progress
date: 2026-06-08
target_repo: PwrSnap (this repo)
supersedes_section: "docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md §Phase 8 (the 'deferred' stub)"
---

# Windows Cross-Platform Port — Plan & Status

## Summary

PwrSnap shipped macOS-first; the buildout plan parked all cross-platform work in
a two-line **Phase 8** stub ("deferred — re-plan after macOS feature parity").
That stub is now stale: a working **Windows GUI port** has landed across two
merged PRs, and the core capture loop is functional on Windows. This doc
promotes the Windows port to its own tracked workstream with a real status
checklist, records the architecture decisions, and enumerates what remains
before Windows is a shippable target.

Linux remains fully deferred. This plan covers **Windows only** (call it
Phase 8a); Linux is Phase 8b and unplanned.

**Verification posture:** unit + E2E run on `windows-latest` in CI; interactive
behavior is verified over RDP on a semi-durable EC2 Windows dev box (the SSM
session-0 environment cannot run GUI E2E). macOS-only specs self-skip via
`test.skip(!isMac)`; Windows-relevant specs are un-skipped or platform-tuned.

Hard-won implementation gotchas from this port live in
[docs/solutions/2026-06-08-windows-gui-port-gotchas.md](../solutions/2026-06-08-windows-gui-port-gotchas.md)
— read that before touching the tray, float-over, or region-selector windowing
on Windows.

---

## Problem Frame

macOS leans on primitives Windows/Linux don't have:

- `type: 'panel'` (NSPanel non-activating) for the tray, float-over, and region
  selector — keeps `show()`/`focus()` from activating the app + cascading focus.
- `vibrancy` / `visualEffectState` for the tray's popover material.
- `setSimpleFullScreen` to cover the menu bar; `setVisibleOnAllWorkspaces` for
  Spaces; `setAlwaysOnTop(_, 'floating' | 'screen-saver')` window levels.
- `/usr/sbin/screencapture` CLI for screen grabs.
- Swift helpers (window-list, recorder, Quick Look extensions) via
  `build-native.mjs`.

The port replaces each with a Windows-native equivalent (or a deliberate
deferral), without regressing macOS. The guiding rule: **branch on
`process.platform` at the window-factory / capture / packaging seams; keep the
macOS path byte-for-byte unchanged.**

---

## Architecture Decisions

| macOS primitive | Windows replacement |
|---|---|
| `type: 'panel'` (NSPanel) | frameless `transparent` + `alwaysOnTop` + `showInactive()` window |
| `vibrancy` popover material | `transparent: true`; renderer paints the rounded surface itself |
| `setSimpleFullScreen` (cover menu bar) | `setFullScreen(true)` to cover the taskbar (`Shell_TrayWnd` is itself topmost) |
| `setAlwaysOnTop(_, level)` window tiers | plain `setAlwaysOnTop(true)` → `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` |
| float-over opacity-park (`setOpacity(0)` off-screen) | **real `hide()`/`showInactive()`** — `setOpacity` breaks `transparent:true` compositing on Windows |
| `screencapture` CLI | Electron `desktopCapturer` (full display) + `sharp` crop |
| Swift `window-list` helper | C++ `EnumWindows` helper (`window-list.exe`, built with `cl.exe`) |
| `recorder` / Quick Look extensions | Video recording uses Windows FFmpeg `gdigrab` backend; Quick Look extensions remain macOS-only |
| DMG / notarization | NSIS installer via electron-builder `win` target |

Cross-cutting:

- **One write entrypoint, one command bus** — no Windows-specific IPC channels;
  everything routes through the existing `command-bus.ts`.
- **Native helper gating** — `build-native.mjs` runs its C++/`cl.exe` branch
  under `process.platform === "win32"` and returns; the darwin Swift path is
  untouched. Non-darwin/non-win32 platforms skip.
- **Packaging resources** — electron-builder **concatenates** root-level
  `extraResources` with per-platform `mac.extraResources`/`win.extraResources`
  (verified in `getFileMatchers`), so cross-platform payloads (licenses, tray
  icons) stay top-level and platform-only payloads (Swift helpers / ffmpeg vs
  `window-list.exe`) live under their platform key.

---

## Status

### ✅ Landed

**Build & toolchain — [PR #215](https://github.com/pwrdrvr/PwrSnap/pull/215)** (merged 2026-06-07)
- [x] `pnpm install` / `build` / `typecheck` / `lint` / unit suite green on Windows
- [x] better-sqlite3 + sharp native modules resolve under the Electron ABI on win32
- [x] `.gitattributes` LF enforcement so shebang'd `.mjs` don't break on CRLF checkout
- [x] CI: **Windows (lint + build + test)** job on `windows-latest`

**GUI port — [PR #218](https://github.com/pwrdrvr/PwrSnap/pull/218)** (merged 2026-06-08; folded in #220 installer + #221 window picker)
- [x] **Tray icon** — colored `tray-icon.png` (+@2x/@3x) from brand assets; `resolveTrayIconPath()` picks colored on win, template on mac; `setTemplateImage` darwin-gated
- [x] **Tray window** — frameless transparent alwaysOnTop; positioned above the bottom-right taskbar (`positionTrayWindow`)
- [x] **Float-over toast** — real `hide()`/`showInactive()` park (no `setOpacity`); topmost re-asserted from `hideAllSelectors` after the fullscreen selector hides; `CalculateNativeWinOcclusion` disabled so the occluded-then-revealed transparent toast actually paints
- [x] **Capture / region selector** — `desktopCapturer` + `sharp` crop; native fullscreen covers the taskbar; selector flags darwin-gated (no NSPanel/Spaces)
- [x] **Window picker (snap-to-window)** — [#221] C++ `EnumWindows` helper → `window-list.exe`, compiled via a generated `.bat` to dodge `cmd` quote-stripping
- [x] **NSIS installer** — [#220] electron-builder `win` target + `package-win.mjs`; gated behind the `build-preview` label in CI; installs + launches
- [x] **Codex CLI discovery on Windows** — `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` + Program Files; `codex.exe` PATH candidate first
- [x] CI: **Windows Desktop E2E** job; **Build preview installer (Windows)** + **Build preview DMG** artifacts; macOS DMG build verified intact after the electron-builder restructure
- [x] **Windows release wiring** - `.pwrsnap` Explorer association, Authenticode-gated `package-win.mjs --release/--publish`, tagged-release `windows-signing` job, `electron-updater` NSIS feed publishing, and optional bundled `PwrSnapFFmpeg.exe` injection are wired. Windows video recording uses the same selected-region flow backed by FFmpeg `gdigrab` + `h264_mf`; imported/existing video export and sizzle paths use the same vetted binary.

### 🔜 Remaining before Windows is shippable

- [ ] **Provision Windows signing environment** - create the protected `windows-signing` GitHub Environment and set `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` for an Authenticode certificate belonging to PwrDrvr LLC. EV is preferred for SmartScreen reputation, but the repo wiring accepts any valid Authenticode cert.
- [ ] **Provision vetted Windows FFmpeg binary input** - set `WINDOWS_FFMPEG_URL` + `WINDOWS_FFMPEG_SHA256` in `windows-signing`. The URL must point at a legally-vetted LGPL `ffmpeg.exe`; the packager refuses to publish without it.
- [ ] **First signed Windows release smoke** - publish a prerelease tag, install the signed NSIS artifact on a clean Windows VM, verify `.pwrsnap` double-click, still capture, clipboard copy, and one update from prerelease to prerelease.
- [ ] **Capture-trigger debounce** — observed one snap firing the capture pipeline 3× in ~600ms on Windows (global-shortcut key-repeat / double-bound trigger). Harmless today (only one persists) but wasteful and race-prone.
- [ ] **Window picker doesn't highlight the Library window** — cosmetic; the picker works but the own-window highlight is missing.

### 🎨 Polish / parity (non-blocking)

- [ ] **Platform-aware shortcut glyphs** — `⌘`/`⌥`/`⇧` labels should render as `Ctrl`/`Alt`/`Shift` on Windows across `TrayMenu`, the float-over, and the Library.
- [ ] **Custom window chrome** — currently native Windows title-bar chrome; optional `titleBarStyle: 'hidden'` + `titleBarOverlay` to match the macOS frameless look.
- [ ] **DXGI duplication noise over RDP** — `desktopCapturer` logs a DXGI failure then falls back to GDI; harmless, but noisy in logs.

### ⏸️ Known external limitations (not our bugs)

- RDP clipboard: pasting a PwrSnap image *out of* an RDP session into a host-side
  app can fail — an RDP clipboard-redirection limitation, not a capture bug.

### ❌ Out of scope here

- **Linux** (Phase 8b) — still fully deferred; `desktopCapturer` is portable but
  Wayland/X11 capture, tray, and global-shortcut behavior need their own pass.
- **macOS-only features on Windows** - Quick Look thumbnail/preview extensions,
  the ScreenCaptureKit recorder implementation, and presenter-cam segmentation.
  Video capture now has a Windows FFmpeg backend; a future Windows Graphics
  Capture native helper can replace it without changing the renderer flow.

---

## Risks & Watch-Items

- **Window compositing on Windows is fragile under `transparent: true`.** Any new
  transparent popover must use real `hide()`/`showInactive()` (never
  `setOpacity`) and must account for occlusion when shown behind a fullscreen
  window. See the solutions doc.
- **Don't regress macOS.** Every change is `process.platform`-branched at the
  window/capture/packaging seam. The full unit suite + macOS E2E + the macOS DMG
  build must stay green on every Windows-port PR.
- **CI must run on the integration branch.** `pull_request` branch filters read
  from the PR head's workflow file — stacked Windows PRs need their base branch
  added to the trigger list or they get no CI.

---

## Alternative Approaches Considered

### Big-bang single PR for the whole port (rejected)
The port touches windowing, capture, native helpers, packaging, and CI. A single
PR would be unreviewable and would couple unrelated risk. Chosen instead: an
integration branch (`windows-gui-port`) that sub-PRs (installer, window picker)
merge into, with that one branch merging to main — so `main` never accidentally
absorbs half-finished work.

### Port the macOS opacity-park to Windows (rejected — it's the bug)
The float-over's macOS off-screen opacity-park (`setOpacity(0)`) was reused on
Windows first and produced a blank-but-present toast: `setOpacity` drives
whole-window layered alpha that is mutually exclusive with `transparent:true`'s
per-pixel alpha. Real `hide()`/`showInactive()` is the Windows park.

### Native screen capture via `Windows.Graphics.Capture` (deferred)
The buildout plan floated a UWP `Windows.Graphics.Capture` analogue to
`screencapture`. `desktopCapturer` + `sharp` crop is cross-platform, needs no
native code, and is fast enough for stills. Revisit only if a perf or
multi-monitor-fidelity need appears (and it's the natural home for Windows video
capture when that lands).
