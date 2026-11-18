# Agent rules: Tray and popover sizing

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## The Linux tray is a native menu, not the popover

**On Linux the tray's PRIMARY surface is a native `Menu` attached with
`tray.setContextMenu`, and nothing may anchor a window to the indicator
there. Do not let a new tray affordance be wired only through the
popover-platform events.** Owner: `traySurfaceForPlatform` +
`refreshNativeTrayMenu` in [tray.ts](../../apps/desktop/src/main/tray.ts).
Reference: [docs/linux-tray-support.md](../../docs/linux-tray-support.md). Pinned by
[tray-linux-native-menu.test.ts](../../apps/desktop/src/main/__tests__/tray-linux-native-menu.test.ts)
and
[tray-linux-wayland-popover.test.ts](../../apps/desktop/src/main/__tests__/tray-linux-wayland-popover.test.ts).

The popover IS reachable on Linux — the menu's `Show Last Capture…` row opens
it (`toggleLinuxTrayPopover`). What is not reachable is opening it **at the
indicator**, which is what a tray popover is; the compositor places it. That
distinction is the whole of the Wayland bullet below.

PwrSnap shipped with no working Linux tray, and the failure mode is worth
remembering because nothing in the code looked wrong: the `Tray` was
created, and then every affordance hung off it was attached to an API
Electron declares macOS/Windows-only. Read the annotations in
`electron.d.ts` before assuming a `Tray` method works everywhere:

| API | Platform | Consequence |
|---|---|---|
| `Tray.getBounds()` | `darwin,win32` | measured `{0, 0, 0, 0}` — nothing for `positionTrayWindow` to anchor to |
| `Tray.popUpContextMenu()` | `darwin,win32` | the menu cannot be raised |
| `Tray` `right-click` / `double-click` | `darwin,win32` | the handler never fires |
| `Tray.setTitle()` | `darwin` | no `● REC`, no timed countdown |
| `Tray.setContextMenu()` | **all** | the only menu path that exists on Linux |
| `Tray` `click` | **all** | fires on Linux for SNI `Activate` AND `SecondaryActivate` (measured); deliberately unwired there — see the doc |

Wayland closes the two remaining escapes: `BrowserWindow.setPosition` is
"Not supported on Wayland (Linux)" (and `getBounds` returns zeros there),
and `setContentSize` "may not work … as some window managers restrict
programmatic window resizing" — which is the single call the whole
resize-to-fit design rests on (see "Tray + float-over popover sizing").

Five things that bite:

- **Always hand `new Tray()` the `NativeImage`, never the path.** Both are
  accepted and behave identically — until the file is missing, where measured
  on 41.10.7 the path form THROWS (`Failed to load image from path`) and the
  NativeImage form returns a blank icon. `installTray` runs un-awaited inside
  `app.whenReady().then(...)`, so that throw aborts the rest of the boot
  (focus sink, selector pre-warm) instead of degrading to a blank spot in the
  panel. The `icon.isEmpty()` warning is the intended handling.
- **Every input that can change a menu label must call
  `refreshNativeTrayMenu`, and it publishes only on a real difference.** It
  compares a signature of the template — labels, accelerators, enabled flags,
  `type`, recursing into submenus — against the last export. `setTrayHotkeys`
  is wired to `onSettingsChanged`, which fires on EVERY settings and secret
  write, so without that gate a theme toggle re-exports the tray menu; and
  because `setContextMenu` REPLACES the exported object, some SNI hosts close
  an open menu when it happens. A failed export must not update the
  signature, or the next refresh skips the retry and the tray freezes at the
  last menu that did publish. The Linux menu is a PERSISTENT D-Bus object,
  and Electron's docs are explicit that "in order for changes made to
  individual `MenuItem`s to take effect, you have to call `setContextMenu`
  again." Today that is recording phase, hotkey ownership, and the dev
  seeder's extra items. macOS/Windows rebuild the template inside
  `right-click` and need nothing.
- **Nothing time-varying may go IN that menu.** `phase: "recording"` is set
  exactly once, so there is no tick to rebuild off and a `mm:ss` clock would
  freeze at `00:00` — and a per-second republish would replace the menu
  under a user who has it open. The persistent row therefore reads
  `● Recording — Stop and Save`; only the popover platforms carry the clock.
- **macOS and Windows must NEVER call `setContextMenu`.** On an
  `NSStatusItem` it hands left-click to the menu and suppresses the `click`
  event `toggleTrayWindow` is wired to — deleting the popover UI on the two
  platforms where it works. The test asserts the absence.
- **Linux does not PRE-WARM the popover `BrowserWindow`** — it is built on
  the first `Show Last Capture…` click and kept. Do not add
  `prewarmTrayWindow` to the Linux arm of `installTray`: the native menu is
  the primary surface and most Linux users never open the popover, so that
  would be a resident renderer at boot for nothing. The consequence is that
  the first open races the renderer's mount, which is what
  `LINUX_TRAY_FIRST_MEASURE_WAIT_MS` and the taller Linux constructor frame
  exist for (see "Tray + float-over popover sizing"). `showTrayPopoverForE2E`
  still pins a window at a fixed point under E2E — so **a green Linux E2E
  tray spec proves nothing about the Linux tray.** xvfb is X11 and no
  indicator is driving it.
- **On Wayland the compositor owns placement, and the code must say so by
  not calling `setPosition`.** `placeLinuxTrayPopover` and the float-over's
  `placeBottomRightOn` both return early when
  `windowPlacementIsOurs()` is false. Calling an inert API instead would read
  as a placement that works. Three things would have to be true to mount the
  popover by the icon and none are: `getBounds()` is zeros, `setPosition` is
  inert, and the indicator lives in the PANEL's process so there is no
  surface of ours to anchor to (Electron exposes no `xdg_positioner` /
  layer-shell path). X11 keeps a real cursor anchor.
- **Detect the backend with `app.commandLine.getSwitchValue("ozone-platform")`,
  never with a geometry readback.** Owner:
  [linux-window-placement.ts](../../apps/desktop/src/main/linux-window-placement.ts).
  Measured on 41.10.7 against headless weston AND xvfb, `setPosition(400,300)`
  → `getPosition()` returns `[400,300]` on BOTH — every geometry getter echoes
  Chromium's cached widget bounds whether or not the compositor honoured the
  request, and the two runs were byte-identical. The switch is preferred over
  `XDG_SESSION_TYPE` because Electron-on-XWayland is an X11 process that CAN
  place its windows. Note the measured default: on a Wayland session Electron
  takes **wayland**, even with XWayland available — `pnpm dev` on Ubuntu GNOME
  cannot place its own windows.
- **The `Show Last Capture…` row must TOGGLE, and its label must stay
  static.** Toggle because on Wayland the popover may never take keyboard
  focus (a client cannot activate itself), so blur-dismiss and the Escape
  handler can both be unavailable — re-picking the row is the only dismissal
  guaranteed to work. Static because this menu is persistent: a label naming
  the last capture, or flipping to "Hide" while open, would need a per-capture
  republish, and a republish can close the menu under the user's cursor.
- **There is no `libayatana-appindicator3` dependency to declare.** Electron
  stopped routing the tray through libappindicator in Electron 22
  (electron/electron#36333) and speaks StatusNotifierItem over D-Bus itself.
  What a user needs is an SNI *host*: native on KDE, preinstalled on Ubuntu
  GNOME, an extension on vanilla GNOME, a bar's tray module on wlroots
  setups. When none is running, `installTray` still creates the `Tray` (a
  host that starts later is picked up by Chromium's `NameOwnerChanged`) and
  [linux-status-notifier-host.ts](../../apps/desktop/src/main/linux-status-notifier-host.ts)
  logs a `gdbus NameHasOwner` verdict with the remedy — because a
  registration with no host raises no error and fires no event. That probe
  reports `unknown` rather than `absent` whenever it cannot reach a verdict;
  do not "simplify" it into guessing, or a user with a healthy tray host
  gets told to install a GNOME extension they already have.

The icon is its own file for its own reason: `tray-icon-linux.png` is 48×48
with **no `@Nx` siblings**, because `StatusIconLinuxDbus` publishes the
image's scale-1 bitmap into the SNI `IconPixmap` property and `@Nx` siblings
do not raise it — measured, `createFromPath(...).toBitmap()` is 1024 bytes
(16×16×4) for the `tray-icon.png` set and 9216 (48×48×4) for this file.

Everything above about Electron's Linux behavior is measured on 41.10.7, and
both container recipes are in the doc. It is worth re-running on a major
Electron bump. The xvfb recipe cannot tell you whether anything draws — a
bare container has no panel, so every call succeeds and nothing appears,
which is exactly this bug's failure mode. The headless sway + waybar recipe
can: waybar's tray module is a real SNI host, and against it the real build
was measured drawing the icon, exporting a 48×48 `IconPixmap`, and
dispatching menu rows clicked over dbusmenu. It is a wlroots host, so which
gesture GNOME Shell maps to `Activate` still needs a GNOME session.

## Tray popover hide — `setOpacity(0)` before `hide()` on macOS

**The tray popover must never be hidden with a bare `hide()`, and never
shown with a bare `showInactive()` / `show()`. Both go through
`hideTrayWindowNow` / `showTrayWindowNow` in
[tray.ts](../../apps/desktop/src/main/tray.ts).**

`type: 'panel'` makes the popover an `NSPanel`, and AppKit resolves a
panel's default `NSWindowAnimationBehaviorDefault` to
`NSWindowAnimationBehaviorUtilityWindow` — so `[NSWindow orderOut:]`,
which is what `BrowserWindow.hide()` calls, plays a **~0.2s fade-out**
instead of clearing the window on the next frame.

That fade landed in users' screenshots. A capture started from a tray
button dismisses the popover and waits a 50ms compositor flush before
freezing the screen; 50ms into a 200ms fade the popover is still ~70%
opaque, and the region/auto path **crops that frozen snapshot** rather
than re-shooting — so a half-dissolved popover was baked into the saved
file. Captures taken with the global hotkey were clean, which sent the
investigation toward the compositor instead of the window.

**`isVisible()` cannot detect this.** AppKit orders the window out when
the fade *starts*, so the window reads hidden for the whole time it is
still on screen. That is why the `isVisible()` guard in
`hideTrayPopoverIfVisible` could not have caught it, and why all five
dismiss paths (capture, blur, toggle, right-click, double-click) route
through the helper — not just the capture one.

Two things that bite if you touch this:

- **The alpha-0 park makes every show path load-bearing.** A show that
  skips `showTrayWindowNow` brings the popover back at alphaValue 0:
  ordered in, key, hit-testing, painting nothing. Worse than the bug it
  replaced. `tray-instant-hide.test.ts` grep-asserts `tray.ts` for stray
  show/hide calls — if you add an entry point, use the helpers.
- **Never do this on Windows.** There the tray window is
  `transparent: true`, and `setOpacity` drives layered alpha
  (`SetLayeredWindowAttributes`), mutually exclusive with the per-pixel
  alpha a transparent window composites through — the same trap on
  `parkOffScreen` in float-over.ts, where an opacity round-trip left the
  toast blank. Windows has no NSPanel fade to fix.

The tray is the only panel affected: the float-over never calls `hide()`
(it opacity-parks), and the region selector and recording HUD both
`destroy()` right after hiding, which kills the animation. The tray is
the one panel we keep resident, for first-click latency.

Full write-up, including why only the tray and the fade-IN limitation
that remains in timed mode:
[docs/solutions/2026-09-02-tray-popover-nspanel-fade-in-captures.md](../../docs/solutions/2026-09-02-tray-popover-nspanel-fade-in-captures.md).

## Tray + float-over popover sizing — outer `inline-block` measurer

**Both popovers (the tray and the post-capture float-over) size
themselves dynamically by measuring an `inline-block` wrapper that
sits OUTSIDE the styled container, then telling main to
`setContentSize` the BrowserWindow to match. The two surfaces use
identical machinery on purpose — fixes flow naturally between them.
Do NOT revert to hardcoded heights, and do NOT measure the styled
container itself.** And past the main-side ceiling the float-over
scrolls rather than letting the window clip it — see
§"Past the ceiling, the float-over SCROLLS" below.

Width is display-responsive, but it is not viewport-responsive. The shared
policy in [popover-sizing.ts](../../packages/shared/src/popover-sizing.ts) chooses a
compact profile when the shortest work-area dimension is at most 800 DIP:
tray 360 DIP (regular 440), float-over toast 320 DIP (regular 392). It also
fits either width inside unusually narrow work areas. The recent rail is
omitted below 700 DIP of work-area width. Renderers initially use
`window.screen.availWidth/availHeight`. When the tray is positioned beside its
icon, main sends the destination display's work area so its prewarmed renderer
can re-measure after a display change. Main receives the measured CSS width,
converts it through the webContents zoom factor, and calls `setContentSize`.
Never key this policy to `innerWidth`, `innerHeight`, CSS viewport units, or
display scale factor: the first three are the BrowserWindow being resized and
create a feedback loop, while scale factor says nothing about usable logical
space.

Implementations:

- Tray: [TrayMenu.tsx](../../apps/desktop/src/renderer/src/features/tray/TrayMenu.tsx)
  → calls the preload's `requestTrayResize` (`tray:resize`). Main listens in
  [tray.ts](../../apps/desktop/src/main/tray.ts) (`wireTrayResizeChannel`),
  clamped to `[TRAY_HEIGHT_MIN=200, TRAY_HEIGHT_MAX=1040]`.

- Float-over: [FloatOverHost.tsx](../../apps/desktop/src/renderer/src/features/float-over/FloatOverHost.tsx)
  → dispatches `float-over:resize`. Main listens in
  [float-over.ts](../../apps/desktop/src/main/float-over.ts) (`wireFloatOverResizeChannel`).
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
  <div
    ref={containerRef}
    style={{ display: "inline-block", width: `${displayPolicyWidthCss}px` }}
  >
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
the resize handler in [tray.ts](../../apps/desktop/src/main/tray.ts)
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

### Linux: the measurer still runs, but it cannot be the only guarantee

**On Linux the resize-to-fit path is unchanged — the same wrapper, the same
IPC, the same `setContentSize`. What Linux adds is a floor under it, because
nothing in the process can verify the resize landed.** Owners:
`trayPopoverConstructedHeight` in
[window.ts](../../apps/desktop/src/main/window.ts) and
`LINUX_TRAY_FIRST_MEASURE_WAIT_MS` + `toggleLinuxTrayPopover` in
[tray.ts](../../apps/desktop/src/main/tray.ts). Pinned by
[tray-linux-wayland-popover.test.ts](../../apps/desktop/src/main/__tests__/tray-linux-wayland-popover.test.ts).

- **`getContentSize()` CANNOT tell you whether `setContentSize` worked.** It
  echoes the requested value on every backend — measured, byte-identical
  between headless weston and xvfb. The honest check is the renderer's own
  `window.innerHeight`, and by that measure `setContentSize` **does** work on
  Wayland (`440→620→300→812` all followed exactly on weston; `620→300` on
  mutter 46 headless; the real popover shrank from 880 to 302 on sway 1.9).
  Electron still documents the call as "may not work" there, and the
  first-open deadline can beat the resize, so the design does not depend on
  it.
- **The Linux constructor frame is TALLER (880, not 440)** and that is the
  floor: the constructor frame is the last size the popover is guaranteed to
  have. A refused resize then renders content at the top of a taller
  transparent window — dead area that still hit-tests — which beats clipping
  the bottom rows off. Do not "tidy" Linux back to 440 on the strength of the
  resize measurements.
- **The first Linux open waits for one measurement before showing.** Linux
  does not pre-warm the popover, so without the wait the first open paints the
  constructor frame and visibly jumps. The wait has a deadline
  (`LINUX_TRAY_FIRST_MEASURE_WAIT_MS`) so a renderer that never posts still
  gets a window — which is the *other* reason the constructor frame has to fit
  the content.
- **The float-over's Linux problem was never sizing — it was `setOpacity`.**
  Through Electron 41 that call was `@platform win32,darwin` and measured
  inert on BOTH Linux backends, so the toast's opacity park hid nothing and the once-only
  `showInactive()` (burned by the selector's `show-idle`) meant the commit
  never showed. Linux now uses the real `hide()` / `showInactive()` cycle
  Windows already proves — `floatOverHideModelForPlatform`, where macOS is the
  exception that has to earn its way out rather than the rule everyone else
  survives. Electron 44 implements `setOpacity` on Linux, and on 44.4.5
  under xvfb `getOpacity()` reads back what was set. That is not a reason to
  move Linux back to the park: it is a readback, xvfb draws nothing, and
  `hide()` needs no compositor. Pinned by
  [float-over-linux-visibility.test.ts](../../apps/desktop/src/main/__tests__/float-over-linux-visibility.test.ts).
- **Linux E2E green proves nothing here.** xvfb is X11. Reproducing any of
  this needs a nested Wayland compositor — recipe in
  [docs/linux-tray-support.md](../../docs/linux-tray-support.md) §"Repeating the
  Wayland half". Where a window actually LANDS is measurable with pixels on
  mutter 46 headless (same section): stock mutter puts a native Wayland
  popover or toast near the top-left of the work area, not centred and not in
  the corner. Whether GNOME Shell focuses it still needs a real session.

### When to revisit

- A new top-level section gets added or content becomes genuinely
  variable — the dynamic measurement should handle it for free, but
  verify with the forced-height diagnostic that your worst-case
  content fits under the main-side ceiling.
- The styled container loses `overflow: hidden` — at that point
  measuring it directly would also work, but there's no reason to
  switch off the wrapper pattern; it's strictly more robust and
  keeps the tray and float-over symmetrical.

### Past the ceiling, the float-over SCROLLS — it must never clip

**Measuring correctly is only half of it. What main does with a
measurement past its clamp is clip, and the toast's footer is last in
the box — so the row carrying Discard / Dismiss / Edit is exactly what
disappears.** That shipped. PR #638 bought the video toast back under
`FLOAT_OVER_HEIGHT_MAX` by cutting 100px of chrome (888 → 788), which
left ~12px of headroom; a third row of tags, an `AppUpdateRow`, the
short-clip warning or a long Codex error each spends it on its own.

The toast therefore caps its own height and scrolls the middle:
`.fo` wears `max-height: var(--fo-max-h)`, `.fo__body` (everything
between `.fo__hdr` and `.fo__foot`) is `flex: 1 1 auto; min-height: 0;
overflow-y: auto`, and the header and footer are `flex: none`. The
wrapper then measures `min(natural, cap)` and main's clamp never fires.
Policy in [float-over-sizing.ts](../../packages/shared/src/float-over-sizing.ts),
imported by BOTH main and the renderer — a renderer cap even a pixel
looser than main's clamp is clipped footer again.

Four things that bite:

- **The cap may NEVER be derived from the window's current size.**
  `100vh` / `window.innerHeight` / the wrapper's own `clientHeight` all
  look equivalent and close a feedback loop: the wrapper would report
  `min(natural, current window)`, main would size the window to that,
  and the toast could never grow again. That is strictly worse than the
  clipping — it does not heal on the next capture, and no
  `ResizeObserver` reports it, for the reason the section above this
  one gives. Both legal inputs are window-size independent: the
  `FLOAT_OVER_HEIGHT_MAX_DIP` constant, and the display's work area.
- **`window.screen.availHeight` is DIP and zoom-independent; measured
  on Electron 41 it equals `Display.workArea.height` exactly and does
  not move at zoom 0.5/1/1.5/2 — while `window.innerHeight` does.** So
  the CSS ceiling is `DIP / zoomFactor`, and the zoom comes from
  `webFrame.getZoomFactor()` via preload (`getZoomFactor`). Nothing
  else page-visible carries it: `devicePixelRatio` is
  displayScale × zoom and the page does not know the display's scale.
- **`min-height: 0` on `.fo__body` is load-bearing**, and looks like
  tidying. A flex item's `min-height` is `auto` — its content height —
  so without it the middle refuses to shrink, `.fo` overflows its own
  max-height, and `overflow-y: auto` never engages because the box
  never got smaller than its content. Same class as `flex: none` on the
  header and footer, without which those squash their padding first.
- **Do NOT add a `::-webkit-scrollbar` block** for the new scroller;
  the repo-wide `scrollbar-width: thin` rule governs it and
  `scrollbar-contract.test.ts` fails on one.

The tray has no cap, deliberately: its content is structurally bounded
(fixed mode grid, one preview, one hotkey list) while the toast's grows
with whatever the model wrote. The MEASURER stays identical on both —
the cap is published by the host onto the wrapper, not computed inside
the shared code — so fixes still flow between them.

Pinned by
[float-over-scroll-cap-contract.test.ts](../../apps/desktop/src/renderer/src/styles/__tests__/float-over-scroll-cap-contract.test.ts)
(the CSS, plus a grep that `FloatOverHost.tsx` names no viewport
measure), [float-over-sizing.test.ts](../../packages/shared/src/__tests__/float-over-sizing.test.ts)
(the policy) and the "float-over scroll cap" block in
[FloatOver.test.tsx](../../apps/desktop/src/renderer/src/features/float-over/__tests__/FloatOver.test.tsx)
(that swinging `window.innerHeight` moves nothing). jsdom has no
layout, so none of them can observe the scroll itself — measure that in
a real browser against the shipped stylesheet.
