# Agent rules: Capture, TCC and clipboard

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Never block the main thread on a TCC-gated path

**No synchronous filesystem read of anything under `getCapturesRoot()`,
`getChatsRoot()`, or `getDurableCapturesRoots()` in the main process —
not at startup, not on window open, not on a hot path.** Those roots
default to `~/Documents/PwrSnap`, and macOS gates `~/Documents` behind
the "Allow Documents access" consent prompt. `open()` / `opendir()` under
it **park without bound** while that prompt is pending for the running
binary's TCC identity (a fresh worktree's Electron, a new packaged
build) and return `EPERM` once denied. A `readdirSync` there on the main
thread froze the whole app at startup — beachball, "Application Not
Responding", ~0% CPU, main thread in `readdirSync → opendir →
open$NOCANCEL` — because the event loop, the IPC dispatcher, and the
AppKit run loop share that thread and there is no UI left to answer the
prompt from. `PWRSNAP_E2E=1` **together with** `PWRSNAP_USER_DATA`
hides the whole class (that pair rebases `documents` into userData;
neither does it alone — see the `isE2E` branch in
[index.ts](../../apps/desktop/src/main/index.ts)), so E2E green proves nothing
here. A local launch that sets only `PWRSNAP_E2E=1` still reads the real
`~/Documents/PwrSnap` and can still hit the hang.

- Use `node:fs/promises` and let the caller `await` — or, when the read
  is a nicety rather than the source of truth, bound the wait and
  proceed without it (the template is `ChatThreadStore.ensureImported()`
  + `LEGACY_IMPORT_WAIT_MS` in
  [chat-thread-store.ts](../../apps/desktop/src/main/ai/chat-thread-store.ts)).
- **The threadpool is small — budget it.** A pending prompt parks the
  libuv threadpool thread that took the async call, and the default pool
  is **4 threads** shared by all of `fs/promises`, `dns.lookup`, `zlib`,
  and `crypto.pbkdf2`. One parked read is fine: the window paints, menus
  work, the dialog can be answered, everything drains. Four is not — it
  starves every other async fs call in main and turns a diagnosable
  beachball into an app that paints and silently completes nothing. So a
  gated read must be shared per root, not issued once per object that
  happens to want it (see `legacyImportFor()` and the module-level
  `legacyImports` map, which exist for exactly this reason).
- **Bound once, not per call.** Memoize the *bounded* promise, not the
  raw one. Re-arming the deadline per call makes waits additive — one
  "New chat" chaining four gated calls paid 4 × the bound.
- Work that lands after the bound elapses must not clobber what the
  caller did in the meantime. The legacy import skips threads deleted
  while it was reading; anything similar needs the same guard.
- Metadata calls (`stat` / `access` / `existsSync`) don't open the file
  and have not been observed to prompt, but don't add new sync ones under
  these roots either.
- Finding the next one:
  `grep -rn -E "readdirSync|readFileSync|openSync|opendirSync" apps/desktop/src/main --include='*.ts' | grep -v __tests__`
  then check each path argument against the roots above. Most hits are
  userData / app resources and fine.

History + the `sample` recipe:
[docs/solutions/2026-06-12-macos-tcc-captures-folder-denials.md](../../docs/solutions/2026-06-12-macos-tcc-captures-folder-denials.md)
§"Addendum (2026-08-22)". Pinned by
[chat-thread-store-documents-access.test.ts](../../apps/desktop/src/main/ai/__tests__/chat-thread-store-documents-access.test.ts).

## Clipboard bytes are read only for a paste or copy the user started

**Only a command the user started to paste or copy may read a clipboard
flavor's bytes. Everything else may list types and nothing more: menu
enablement, focus or activation handlers, change listeners, polling.**
Owners: [pasteboard-types.ts](../../apps/desktop/src/main/clipboard/pasteboard-types.ts)
(the one types-only listing) and
[paste-menu-hint.ts](../../apps/desktop/src/main/clipboard/paste-menu-hint.ts).
Pinned by
[paste-menu-hint.test.ts](../../apps/desktop/src/main/clipboard/__tests__/paste-menu-hint.test.ts),
which traps every Electron clipboard method.

- **Why.** A clipboard item from another device (Universal Clipboard) or a
  remote-desktop client is promised data. macOS lists its types and fetches
  a flavor's bytes, across the network, only when an app asks for them. The
  File → New → Paste from Clipboard probe read bytes on every menu open, and
  pulled images and files the user never pasted.
- **Electron 44's `clipboard.read()` and `clipboard.has()` are not
  types-only.** Measured on macOS 26, they fetch `public.url` and
  `public.url-name` (Electron probes for a bookmark with Chromium's
  `ReadURL`) and the W3C custom-format map. On Windows that probe is
  `GetClipboardData(CFSTR_INETURLW)`, which renders a delay-rendered format.
  So macOS lists types through AppKit (`NSPasteboard.types`, the
  pasteboard helper's `--list-types`), measured to fetch nothing. Windows and
  Linux have no measured types-only listing, so the paste item is always
  enabled there and nothing is probed.
- **A types-only hint is generous by design.** A web URL or a file URL to a
  non-image file leaves the item enabled; `capture:pasteFromClipboard`
  validates and reports "no image".
- **The E2E bridge's readers (`__PWRSNAP_TEST__`) exist only under
  `PWRSNAP_E2E`.** A copy's own readback (`writeMacFileToClipboard`) runs
  inside the user's copy, against the item PwrSnap just wrote.

Measurements and the promised-data probe recipe:
[docs/solutions/2026-10-12-clipboard-types-only-paste-menu.md](../../docs/solutions/2026-10-12-clipboard-types-only-paste-menu.md).

## A screen grab must prove it is the display it claims to be

**Nothing may treat `desktopCapturer` pixels as a given display without
first checking their shape against that display's bounds, and the
region selector may not be shown on a Wayland session with more than one
display.**
Owners: [grab-geometry.ts](../../apps/desktop/src/main/capture/grab-geometry.ts)
and [linux-session.ts](../../apps/desktop/src/main/capture/linux-session.ts).
Pinned by their unit tests plus the two production-wiring tests —
[screencapture-grab-geometry.test.ts](../../apps/desktop/src/main/capture/__tests__/screencapture-grab-geometry.test.ts)
and [capture-handlers-wayland-refusal.test.ts](../../apps/desktop/src/main/handlers/__tests__/capture-handlers-wayland-refusal.test.ts).

macOS is exempt by construction: `screencapture -R <bounds>` is TOLD the
rect. Everywhere else the grab comes from `getSources`, which returns a
LIST, and the only authoritative key — `display_id` — is documented as
"an empty string if not available".

- **The silent branch is `single_source`, not the warned fallback.** When
  `display_id` is empty and there is exactly one source,
  `captureDisplayNativeImage` takes it deliberately and logs nothing. On
  an xdg-desktop-portal session that lone source is whatever the user
  picked in the portal's own dialog. Triage that greps for
  `no source matched display_id` will therefore find **nothing** on the
  configuration that is actually broken.
- **A wrong-shaped grab used to be stretched, not reported.** The selector
  renderer paints the snapshot with `object-fit: fill`, and
  `cropScreenSnapshot` maps the user's rect through `display.scaleFactor`
  — which describes the display and knows nothing about the grab. So a
  mismatch produced a misaligned picker and a file of pixels the user
  never saw. `checkGrabMatchesDisplay` now refuses it.
- **The check is aspect ratio, and that is on purpose.** `thumbnailSize`
  is a MAXIMUM and Chromium preserves aspect scaling into it, so a healthy
  grab matches the display's shape whatever size it arrives at — a size
  check would reject good grabs. It is necessary, not sufficient: two 16:9
  monitors are indistinguishable this way, **and on a single-display
  machine it cannot separate a right portal answer from a wrong one at
  all** — the measured Ubuntu grab came back 0% off. Treat it as a
  backstop for the multi-source cases, never as proof the grab is right.
  Do not widen `GRAB_ASPECT_TOLERANCE` to make something pass; 1% is
  already ~14× the worst pixel-rounding drift.
- **The Ubuntu misalignment was OURS, and the fix is
  `setFullScreen(true)`.** `enterMenuBarOverlayMode` returned early for
  every platform that was neither win32 nor darwin, so the Linux selector
  never entered fullscreen, and a bare window does not own the screen
  under GNOME. Measured on Ubuntu 24 / GNOME with the probe's occlusion
  table:

  ```
  bare                     32 rows at the top / 67 columns at the left
  fullscreen-after-show     0 / 0
  fullscreen-before-show    0 / 0
  ```

  32 rows is the top bar, 67 columns is the dock, and under `bare` the
  opaque test field starts at `72,34`. That count cannot say whether the
  chrome was drawn OVER the window or the window was MOVED off it, and the
  first write-up guessed "covered, nothing moved". Measured since, on
  mutter 46 with a 32px top / 67px left strut: mutter **moves** a
  monitor-sized toplevel into the work area. Its 100px top-left marker
  landed whole at `67,32` and only 33 columns of the top-right one
  survived at the screen edge, on the native Wayland and the X11 backends
  alike. So the frozen snapshot was painted offset by the work-area
  insets, beside the live bar and dock: the duplicated, offset desktop
  that was reported. Windows had the identical bug ("two taskbars") and
  already had the identical fix. **Both orderings cover**, so
  `enterMenuBarOverlayMode(win)` may stay ahead of `win.show()` (measured
  on the Ubuntu machine and again on mutter 46). `fullscreenable` must be
  true there too, or the call is a silent no-op. Pinned by
  [selector-overlay-fullscreen.test.ts](../../apps/desktop/src/main/capture/__tests__/selector-overlay-fullscreen.test.ts).
- **On Linux the selector must be resizable, or X11 mutter ignores the
  fullscreen.** A non-resizable window carries min == max size hints, and
  mutter drops `_NET_WM_STATE_FULLSCREEN` for it unless they equal the
  monitor, which stops being true once mutter has squeezed the window into
  the work area. Measured with `createSelectorWindow`'s own options, on
  mutter 46 as an Xorg WM and under XWayland: `resizable: false` stays at
  `67,32 1853x1048` while **`isFullScreen()` reports `true`**, and
  `resizable: true` covers `0,0 1920x1080`. A native Wayland client goes
  fullscreen either way, which is why the Ubuntu run passed without it,
  but a GNOME Xorg session is exactly where the Wayland refusal notice
  sends multi-display users. Windows keeps `resizable: false`. Pinned by
  the same test.
- **On a native Wayland client, geometry readbacks are echoes, and a probe
  that trusts them will send you the wrong way.** `getBounds()`,
  `getContentBounds()` and the renderer's own `screenX/screenY` all
  agreed the overlay was perfectly placed, and the probe duly reported
  "the bare window was already correct on this machine — look elsewhere
  before changing placement." That sentence cost three wrong hypotheses,
  and "the window sat at exactly 0,0" came from the same echoes: on
  mutter 46 all three read `0,0` for a window whose pixels were at
  `67,32`. They report what was REQUESTED; they cannot see where the
  compositor put the window, and they cannot see what is painted over it.
  Only pixels tell. **And do not resolve it by eye**, which failed twice
  here. The translucent simulation (step 5) is unanswerable that way by
  construction: at 55% opacity the live desktop shows through BY DESIGN,
  so "covered by the shell" and "showing through my own translucency"
  look identical. Step 6 answers it as an integer: paint an OPAQUE
  full-display field of known colours, grab the screen, and count the
  foreign pixels. Its corner fiducials then say which it was. Every corner
  shifted by the same amount means the window MOVED; only the top and left
  corners losing rows and columns while bottom-right stays put means it
  was COVERED.
- **Wayland keeps region capture on a single display.** The refusal is now
  Wayland AND `displayCount > 1`, and nothing else. The only capability
  fullscreen does not restore is `getCursorScreenPoint()`, which returns
  0,0 wherever the mouse is — and that is load-bearing for exactly one
  decision, which display `pickRegion` opens on. With one display there is
  nothing to get wrong (the opening crosshair starts in the corner and
  corrects on the first mouse move); with two it reliably picks the wrong
  one. The portal still charges a permission prompt and a source picker per
  capture (~3s), which is a cost, not a defect. `capture:interactive`
  refuses ahead of `guardScreenCapture` so a refused capture never raises
  that prompt. Do not lift the refusal by fixing only the pointer: with two
  displays the portal returns whichever monitor the user picked, with no
  `display_id`, and two same-shaped monitors pass the geometry check.
- **The refusal lives in the handler and nowhere else — in particular, not
  in `preWarmRegionSelector`.** A draft skipped pre-warming where the
  selector is refused, to save the renderers. That is a second refusal with
  no voice: `runInteractiveRecord` in index.ts drives `pickRegion` directly,
  finds no selector windows, resolves `destroyed`, and the Record button
  does nothing, silently. Pinned by
  [selector-overlay-fullscreen.test.ts](../../apps/desktop/src/main/capture/__tests__/selector-overlay-fullscreen.test.ts).
- **⇧-snap-to-window and source-app metadata do not work on Linux at all,
  X11 included.** `build-native.mjs` builds the `window-list` helper for
  darwin (Swift) and win32 (C++) only, so `listWindowsSnapshot()` returns
  an empty list behind one `warn`. That is why no hover highlight follows
  the pointer over windows there. It is a missing native helper, not a
  Wayland limitation — though a Wayland-native session has no protocol to
  enumerate other apps' windows, so any Linux helper would be X11-only.
- **The refusal must SHOW itself, and the notice hangs off the refusal —
  not off the trigger.** A refusal only the log can see is a dead button,
  which is strictly worse than the broken selector it replaced. The
  first version explained itself from `capture-trigger.ts`, which only the
  global hotkeys and the native tray menu route through; the Library's
  Quick Capture button and the tray popover's tiles dispatch straight over
  IPC from the renderer and `void` the promise, so on Ubuntu the app's
  headline button did nothing at all. `showWaylandRefusalNotice()`
  ([wayland-refusal-notice.ts](../../apps/desktop/src/main/capture/wayland-refusal-notice.ts))
  is now raised from the handler, for `principal === "ipc"` only — every
  human entry point is `ipc`, and an agent has nobody to dismiss a modal.
  It offers **Capture Full Screen** rather than only naming it: the
  message already says that is the way to capture here, and making the
  user dismiss an alert and go find a different button is the same dead
  end wearing a hat.
- **`WAYLAND_SELECTOR_MESSAGE` is user-visible text, so only measured
  claims go in it.** Two drafts failed that: one blamed Wayland's
  placement rules for the misaligned selector (true of a native client,
  but not the cause, since fullscreen needs no placing), and one told users
  drag-to-select was unavailable on Wayland when the real cause was our
  own missing fullscreen call. Its Xorg advice holds only because of the
  `resizable` rule above. Correcting a header comment is not enough; grep
  the strings.
- **On a Wayland session, assume a native Wayland client, and do not try
  to place the overlay.** An earlier version of this section said the
  opposite, that Electron defaults to X11 and runs as an XWayland client
  whose placement is honoured. It was wrong. Electron 41 resolves to
  `wayland` on a Wayland session even with `DISPLAY` set. That was
  measured on mutter 46 and sway 1.9 from the resolved `--ozone-platform`
  switch, which Electron writes back even when nobody passed it; read it
  with `app.commandLine.getSwitchValue("ozone-platform")`. A native client
  cannot place its toplevel, and no readback will tell it where the window
  went. Fullscreen is why that no longer matters for the selector. XWayland
  is what you get only by asking for it (`--ozone-platform=x11`).
- **`capture:fullScreen` / `capture:allScreens` stay available there** —
  no overlay, no rect arithmetic, so the portal's picker IS the source
  selection and the editor's crop tool is the region selection. That is
  what the refusal notice points users at; keep it pointing somewhere.
- **Detection fails OPEN.** Only a positively-identified Wayland session
  is refused; an unrecognised environment keeps region capture, because a
  miss on X11 deletes a working feature while a miss on multi-display
  Wayland only restores the pre-refusal behavior — which the geometry
  check catches when the two monitors differ in shape, and not otherwise.
- **Neither CI job can catch any of this.** The Docker/xvfb harness has no
  portal and no window manager, and macOS never runs the code. Confirm on
  a real session with
  `pnpm --filter @pwrsnap/desktop probe:linux-capture`
  ([linux-capture-probe.mjs](../../apps/desktop/scripts/linux-capture-probe.mjs)),
  which reports session type and the RESOLVED ozone backend, the source
  list with `display_id` and measured dimensions, where a selector-shaped
  window lands (on X11 only; on native Wayland it says the readback is an
  echo), whether the overlay owns the screen and, if not, whether it was
  moved or covered (step 6), and whether the cursor point is real.
  `--no-overlay` keeps the
  measured steps and drops every watch-and-judge one; the banner prints
  the checked-out sha and `-dirty`, because a run was once pasted back
  that predated the commit it was meant to exercise.
