# The Linux tray — what PwrSnap supports, and why it is a native menu

Shipped-behavior reference. This describes what the code does today, not a
plan. The enforcement rules are in AGENTS.md §"The Linux tray is a native
menu"; the implementation is
[`tray.ts`](../apps/desktop/src/main/tray.ts) (`traySurfaceForPlatform`,
`refreshNativeTrayMenu`) and
[`linux-status-notifier-host.ts`](../apps/desktop/src/main/linux-status-notifier-host.ts).

## The decision

| | macOS | Windows | Linux |
|---|---|---|---|
| Tray surface | custom `BrowserWindow` popover | custom `BrowserWindow` popover | **native `Menu`** |
| Opened by | left-click on the icon | left-click on the icon | the host's own gesture, usually left-click |
| Native menu | right-click | right-click | **is the whole surface** |
| Rich popover | left-click on the icon | left-click on the icon | the menu's "Show Last Capture…" row |
| Recording indicator | icon title (`● REC`) + tooltip + menu | tooltip + menu | tooltip + menu |
| Timed-capture countdown | icon title (`3 / 2 / 1`) | — | — |

On Linux the tray offers Quick Capture, Record Video, **Show Last Capture**,
Open Library, Settings and Quit. The first two and the last three are the same
verbs as the popover's primary actions; "Show Last Capture…" opens the popover
itself — the last-snap preview, the mode grid and the export preset row that a
native menu cannot draw. See §"The popover on Linux" below for what that costs
on Wayland.

## Why not the popover

This is not a UI preference. Four separate pieces of Electron's Linux
surface make the popover unusable as the tray's PRIMARY surface, and all four
are stated in Electron's own type definitions (checked against the pinned
`electron@41.10.7`). (The popover is still reachable from a menu row — see
§"The popover on Linux". What these four rule out is opening it *at the
indicator*, which is what a tray popover is.)

1. **`Tray.getBounds()` is `@platform darwin,win32`.** The popover is
   anchored by `positionTrayWindow(window, tray.getBounds())`. Measured on
   Electron 41.10.7 under Linux it returns `{x: 0, y: 0, width: 0, height:
   0}` — there is nothing to anchor to.
2. **`Tray.popUpContextMenu()` and the `right-click` event are also
   `@platform darwin,win32`.** `setContextMenu` is the only menu API with no
   platform annotation — which is the bug this document accompanies: PwrSnap
   built its menu exclusively inside a `right-click` handler that can never
   fire on Linux, and never called `setContextMenu`. The tray had no menu at
   all there.
3. **`BrowserWindow.setPosition` is "Not supported on Wayland (Linux)"**, and
   `getPosition` / `getBounds` return zeros because "introspecting or
   altering window position is not supported on Wayland". Anchoring to the
   cursor instead — the obvious X11 fallback — puts the popover wherever the
   compositor likes on the sessions most current distros default to.
4. **`BrowserWindow.setContentSize` "may not work" on Wayland**, "as some
   window managers restrict programmatic window resizing". That call is the
   entire basis of the resize-to-fit design (AGENTS.md §"Tray + float-over
   popover sizing"). Measured against a headless weston it *does* work (see
   §"Measurements"), but there is no way to check at runtime, so the design
   cannot depend on it.

A native menu has none of these problems: the host draws it, positions it,
and sizes it, on X11 and Wayland alike, and on every desktop that supports a
tray at all.

The popover factory (`createTrayWindow`) still exists and still runs on
Linux — but only under E2E, where `showTrayPopoverForE2E` pins the window at
a fixed point on the primary display so the tray renderer can be measured
under xvfb. **A green Linux E2E tray spec is not evidence that a Linux tray
popover works**: xvfb is X11, and no indicator is driving it.

## Wayland, and the one thing that cannot be measured from inside

Most of this document is about the tray. This section is about the **session
type**, because it is what the two popover surfaces — the tray popover and the
post-capture float-over — both trip over, and because the obvious way to detect
it does not work.

Owner: [`linux-window-placement.ts`](../apps/desktop/src/main/linux-window-placement.ts).

**The readback lies.** The tempting design is to set a position and read it
back: if it stuck, placement works. Measured on Electron 41.10.7 against a
headless weston *and* against xvfb, that probe returns the same answer on both:

```
setPosition(400, 300)   → getPosition()      = [400, 300]      on BOTH
setPosition(-20000, …)  → getPosition()      = [-20000, …]     on BOTH
setContentSize(440,880) → getContentSize()   = [440, 880]      on BOTH
setBounds(120,90,…)     → getBounds()        = {120, 90, …}    on BOTH
```

Every geometry getter reads Chromium's own cached widget bounds, which are
updated whether or not the compositor honoured the request. The two runs were
byte-identical across every call. So the session type has to come from the
environment.

**Ask Chromium which backend it chose, not the session which it offers.** The
distinction matters because Electron can run as an XWayland client on a Wayland
session — an X11 process that *can* position its windows. Electron writes the
resolved backend back into its own command line, so:

```ts
app.commandLine.getSwitchValue("ozone-platform")   // "wayland" | "x11"
```

is authoritative, and is what `canPositionOwnWindows` reads first. Measured on
41.10.7 with neither `--ozone-platform` nor `ELECTRON_OZONE_PLATFORM_HINT` set,
it reports `wayland` on a Wayland session and `x11` on an X11 one — including
when a Wayland session also has `DISPLAY` set, i.e. XWayland available.

⚠️  **That last measurement is the one to remember: on Ubuntu GNOME, Electron
takes Wayland by default.** `pnpm dev` there is a native Wayland client, not an
XWayland one, so it genuinely cannot place its own windows. Do not assume
XWayland is quietly saving you.

## The popover on Linux

"Show Last Capture…" in the native menu opens the real tray popover — the same
`BrowserWindow` and the same `TrayMenu` renderer macOS and Windows open on
left-click.

**It cannot be mounted next to the indicator on Wayland, and it does not try.**
Three separate things would have to be true:

1. Know where the indicator is — `Tray.getBounds()` is `{0,0,0,0}` on Linux.
2. Move a window there — `setPosition` is inert on Wayland.
3. Failing both, anchor to a parent surface — the indicator is drawn by the
   *panel's* process, so there is no surface of ours to anchor to, and Electron
   exposes no `xdg_positioner` or layer-shell path to reach for.

So the compositor decides, and for a frameless always-on-top toplevel on
GNOME that is roughly the centre of the screen. **A centred popover that opens
is worth more than no popover**, which is the trade this feature makes; it is
not a placement that more arithmetic could improve.

**X11 keeps a real anchor.** `setPosition` works there, and while `getBounds()`
is still zeros, the pointer is on the indicator at the moment the row is
clicked — so the popover is centred under the cursor and clamped into the work
area (which is what makes it correct for a bottom panel as well as a top one).

### Sizing

The popover's whole design is resize-to-fit: the renderer measures its content
and main `setContentSize`s the window to match (AGENTS.md §"Tray + float-over
popover sizing"). Electron documents `setContentSize` as "may not work" on
Wayland, and `getContentSize` cannot be used to check — see the readback note
above.

Measured, it *does* work. The honest probe is the renderer's own
`window.innerHeight`, which is the real viewport of the surface Chromium paints
into and cannot echo a request that was refused:

| | cached `getContentSize()` | **real `window.innerHeight`** |
|---|---|---|
| constructed 440×880 | `[440, 880]` | `880` |
| `setContentSize(440, 620)` | `[440, 620]` | **`620`** |
| `setContentSize(440, 300)` | `[440, 300]` | **`300`** |
| `setContentSize(392, 812)` | `[392, 812]` | **`812`** |

Identical on weston and on xvfb. Window *size* is client-driven in xdg-shell, so
this is a protocol property rather than a weston courtesy — but it is weston,
not mutter, so the design still does not depend on it:

- **Linux constructs the popover taller** (880 rather than 440 —
  `trayPopoverConstructedHeight`). The constructor frame is the last size the
  window is guaranteed to have, so on Linux it is sized to *fit* the content
  rather than to be corrected. A refused resize then renders the content at the
  top of a taller transparent window — dead area below it that still hit-tests,
  which beats a popover with its bottom rows clipped off.
- **The first open waits for one measurement before showing**
  (`LINUX_TRAY_FIRST_MEASURE_WAIT_MS`, 1.2s). Linux does not pre-warm the
  popover the way macOS and Windows do, so without the wait the first open
  would paint the constructor frame and then visibly jump. The deadline means a
  renderer that never posts still gets a window.

### Dismissing it

On Wayland a client cannot activate itself without an activation token, so the
popover may never take keyboard focus — and **blur-dismiss and Escape both need
focus**. Three exits, in order of how much they can be relied on:

1. **Re-pick the menu row.** It toggles, and it needs no focus. This is the
   guaranteed one, and it is why the row toggles rather than only opening.
2. **Escape**, wired in main via `before-input-event` (Linux only — macOS and
   Windows dismiss on a click outside, which is reliable there).
3. **Click outside**, via the existing blur-dismiss.

## The float-over toast on Linux

The post-capture toast was independently broken on Linux, and the root cause is
one line of `electron.d.ts`: **`setOpacity` is `@platform win32,darwin`.**

The toast never called `hide()` off Windows. It pseudo-hid with `setOpacity(0)`
plus `setPosition(-20000, -20000)` and restored with `setOpacity(1)` plus a
once-only `showInactive()`. On macOS that is deliberate — a real `hide()` there
is `[NSWindow orderOut:]`, which cascades key state through the floating-level
focus sink and yanks the caret out of whatever app the user is typing in.

On Linux none of it works:

| Call | Linux X11 | Linux Wayland |
|---|---|---|
| `setOpacity(0)` | **inert** — `getOpacity()` still `1` | **inert** |
| `setPosition(-20000, …)` | works | **inert** |
| `hide()` / `showInactive()` | works | works |

So on X11 only the position half of the park was doing anything, and on Wayland
neither half was — the toast was shown once and then stayed on screen, or never
appeared where the user was looking. The once-only `showInactive()` made it
worse: the region selector pre-shows the toast *under* the fullscreen selector
with `show-idle`, which spent the single show, so the `show-loaded` the user
actually needs to see did nothing.

**Linux now uses the real `hide()` / `showInactive()` cycle Windows already
proves** (`floatOverHideModelForPlatform`). macOS keeps the park, because the
AppKit reason for it is real and applies to nothing else.

Placement follows the same rule as the popover: the bottom-right corner is
applied on X11 and deliberately not attempted on Wayland. One extra caveat
there — `screen.getCursorScreenPoint()` is not a reliable global pointer read
for a Wayland client, so on a multi-monitor Wayland session the toast may be
anchored to the wrong display. It is not placed there anyway, so the practical
effect is nil until placement becomes possible.

## What a user needs: a StatusNotifierItem host

Electron's Linux tray is Chromium's `StatusIconLinuxDbus`. It registers a
freedesktop **StatusNotifierItem** on the session bus and hands the drawing
to whatever process owns `org.kde.StatusNotifierWatcher`.

**There is no `libayatana-appindicator3` runtime dependency.** Electron
stopped routing the tray through libappindicator in Electron 22
([electron/electron#36333](https://github.com/electron/electron/pull/36333))
and speaks the D-Bus protocol itself. Installing the library changes
nothing; it is neither necessary nor sufficient. What matters is whether a
*host* is running.

| Desktop | Host | Action needed |
|---|---|---|
| **KDE Plasma** | the panel itself | none |
| **Ubuntu GNOME** | `ubuntu-appindicators@ubuntu.com`, preinstalled and enabled | none, normally |
| **Debian / Fedora / vanilla GNOME** | none by default | install + enable the extension (below) |
| **sway / Hyprland / Omarchy** and other wlroots setups | whatever bar is running | enable that bar's tray module — waybar's `tray`, for example |
| **A bare compositor with no bar** | none | no application can show a tray icon; use the hotkeys |

GNOME dropped the legacy XEmbed system tray in GNOME Shell 3.26 and never
shipped an SNI host, so on a GNOME session without the extension **no
application** gets a tray icon — not PwrSnap, not Slack, not Steam. The
extension is "AppIndicator and KStatusNotifierItem Support":

```bash
# Debian / Ubuntu
sudo apt install gnome-shell-extension-appindicator
# Fedora
sudo dnf install gnome-shell-extension-appindicator
```

Then enable it (GNOME Extensions app, or `gnome-extensions enable
appindicatorsupport@rgcjonas.gmail.com`) and **log out and back in** —
enabling an extension does not attach it to an already-running Wayland shell
session.

## When no host exists, PwrSnap keeps working and says so

It does not refuse to start, and it does not hide the failure. `installTray`
still creates the `Tray`: an SNI host that starts *after* PwrSnap is picked
up by Chromium's own `NameOwnerChanged` handling, so "no host right now" is
a snapshot, not a permanent state.

What it does do is ask the bus and log the answer, because nothing else
will — a registration with no host produces no error, no event, and no
callback. Look for this line at startup:

```
[pwrsnap:tray] tray icon will not appear: No StatusNotifierItem host is running, …
  { statusNotifierHost: 'absent', desktop: 'ubuntu:GNOME', sessionType: 'wayland' }
```

`statusNotifierHost` is `present`, `absent`, or `unknown`. **`unknown` is
never reported as `absent`** — a probe that could not reach a verdict (no
`gdbus` on `PATH`, a non-zero exit, a timeout) says so rather than printing a
confident remedy to a user whose tray host is fine.

The same question by hand:

```bash
gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.kde.StatusNotifierWatcher
```

`(true,)` means a host is listening and the problem is elsewhere; `(false,)`
means nothing can draw a tray icon in that session. (That is the exact
output the parser is written against — verified in a bus-with-no-host
session, where it prints `(false,)` and exits 0.)

Meanwhile the app is reachable two other ways: the global hotkeys and the
Library window. Note that `globalShortcut` has its own Wayland caveats —
Chromium cannot always register global keys there — so on a Wayland session
with no tray host, the Library window may be the only entry point.

## The icon is a separate 48px file

Linux reads `tray-icon-linux.png`, not the `tray-icon.png` set Windows uses,
and the difference is load-bearing. `StatusIconLinuxDbus` publishes the
image's **scale-1 representation** into the SNI `IconPixmap` property and
lets the panel scale from there. `nativeImage.createFromPath` treats
`tray-icon@2x.png` / `@3x` as scale-2 and scale-3 representations of one
16pt image, so the scale-1 rep of that set is the 16×16 base and the larger
siblings are never consulted — every HiDPI panel would upscale 16px.
`tray-icon-linux.png` is 48×48 with no `@Nx` siblings, so the scale-1 rep is
48×48 and panels downscale instead.

Both are emitted by `pnpm --filter @pwrsnap/desktop tray-icon`
([generate-tray-icon.mjs](../apps/desktop/scripts/generate-tray-icon.mjs)).
Do not rename the Linux file to `tray-icon-linux@3x.png` — the suffix is
exactly what would demote it back to a representation of a 16pt image.

## Measurements, and how to repeat them

Everything asserted above about Electron's Linux behavior was measured on
Electron 41.10.7, not inferred — including the two results that are easy to
get backwards.

| Call | Result on Linux |
|---|---|
| `new Tray(<NativeImage>)` + `setContextMenu` | succeeds, even with **no** `DBUS_SESSION_BUS_ADDRESS` at all |
| `new Tray(<path>)` + `setContextMenu` | succeeds — identical behavior to the NativeImage form |
| `new Tray(<missing path>)` | **THROWS** `Failed to load image from path` |
| `new Tray(<empty NativeImage>)` | succeeds — a blank icon, no throw |
| `tray.getBounds()` | `{x: 0, y: 0, width: 0, height: 0}` |
| `tray.setTitle("● REC")` | returns without throwing, and shows nothing |
| `createFromPath("tray-icon.png").toBitmap()` | 1024 bytes — 16×16×4, **not** the @2x/@3x siblings |
| `createFromPath("tray-icon-linux.png").toBitmap()` | 9216 bytes — 48×48×4 |
| `setOpacity(0)` then `getOpacity()` | **`1`** — inert, on X11 *and* Wayland |
| `hide()` then `isVisible()` | `false`; `showInactive()` restores — both backends |
| `app.commandLine.getSwitchValue("ozone-platform")` | the RESOLVED backend, even when nothing passed it |
| `setContentSize(w, h)` then renderer `window.innerHeight` | follows exactly — both backends |
| `setPosition(x, y)` then `getPosition()` | echoes `x, y` — **on both backends; not a capability probe** |

Three of those are the reason the change is shaped as it is. `setContextMenu`
is safe on a bus-less system, so `installTray` can call it unconditionally on
Linux without risking the boot. The `@Nx` siblings genuinely do not raise the
published bitmap, so the extra 48px asset is doing real work. And rows 2–4
settle a question that looks like a coin flip: `Tray`'s constructor takes
either a `NativeImage` or a path, the path form is folklore-preferred on
Linux, and it behaves identically — right up until the file is missing, where
it throws and the NativeImage form does not. Since `installTray` runs
un-awaited inside `app.whenReady().then(...)`, that throw would abort the
rest of the boot rather than degrade to a blank icon, so **PwrSnap always
passes the `NativeImage`** and lets the `isEmpty()` warning explain a blank.

The recipe, which needs no PwrSnap build — a standalone Electron script
under `xvfb-run` in a `node:24-bookworm` container, run twice: once with
`DBUS_SESSION_BUS_ADDRESS` unset, and once under `dbus-run-session` (a live
bus with no SNI host, which is the state a vanilla-GNOME user is in):

```bash
docker run --rm -v "$PWD":/probe -w /probe node:24-bookworm bash -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends     xvfb xauth libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2     libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2     libgbm1 libxshmfence1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0     libgtk-3-0 libdbus-1-3 dbus dbus-x11 libglib2.0-bin
  npm i electron@41.10.7
  xvfb-run --auto-servernum dbus-run-session -- ./node_modules/.bin/electron --no-sandbox .
'
```

Note what this recipe canNOT tell you: whether the icon actually **draws**.
A container has no panel, so every call above succeeds and nothing appears —
which is precisely the failure mode this whole document is about. Confirming
a visible indicator needs a real desktop session with a real SNI host.

### Repeating the Wayland half

The same container can run a **nested Wayland compositor**, which is what the
Wayland column above was measured against. `xvfb` is X11, so the Linux E2E job
cannot reach any of this — **a green Linux E2E proves nothing about Wayland.**

```bash
apt-get install -y weston
export XDG_RUNTIME_DIR=/tmp/xdgrt; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
weston --backend=headless-backend.so --width=1920 --height=1080 \
       --socket=wayland-1 --idle-time=0 &
env -u DISPLAY WAYLAND_DISPLAY=wayland-1 XDG_SESSION_TYPE=wayland \
  ./node_modules/.bin/electron --no-sandbox --ozone-platform=wayland .
```

Two things about measuring inside it:

- **Assert on the renderer's viewport, not on the main-process getters.**
  `await win.webContents.executeJavaScript("[innerWidth, innerHeight]")` is the
  real surface size. `getContentSize()` is a cached echo (above), and so are
  `getPosition` / `getBounds` / the renderer's own `screenX` / `screenY`.
- **`weston-screenshooter` did not produce output** in this container even with
  `weston --debug`; it hung rather than failing. So **window PLACEMENT under
  Wayland was not confirmed at pixel level** — it rests on Electron's
  documentation plus the protocol, not on a measurement. Sizing was confirmed,
  via the viewport route.

And the limit that no container run can cross: weston is not mutter. GNOME's
placement policy for a frameless always-on-top toplevel — the thing that
decides where the popover actually lands for the user — needs a real GNOME
Wayland session to confirm.

## Known limitations

- **The menu is persistent, so anything time-varying in it goes stale.**
  macOS and Windows rebuild the template inside the `right-click` handler;
  Linux publishes it once and replaces it only when `refreshNativeTrayMenu`
  runs. Every input that can change a label therefore has to call that
  refresh — recording phase, hotkey ownership, the dev seeder's extra items —
  and anything that changes *continuously* has to be left out. That is why
  the recording row reads `● Recording — Stop and Save` on a persistent menu
  instead of carrying the `mm:ss` clock the popover platforms show.
- **`Tray.setTitle` is `@platform darwin`.** The `● REC` indicator and the
  timed-capture countdown beside the icon are macOS-only — measured inert,
  not fatal, off macOS (they were already silent no-ops on Windows). The
  tooltip and the menu carry the state instead.
- **Screen recording is not implemented on Linux.**
  `recordingBackendCapabilities("linux")` reports `backend: "unsupported"`
  with every control false, so the menu's Stop / Restart / Cancel rows are
  correctly absent there. "Record Video…" is still offered, matching the rest
  of the app's surfaces.
- **A StatusNotifierItem "activate" does nothing.** Electron does emit
  `click` on Linux when the item is activated, but the SNI spec does not say
  which gesture causes an activation — Electron's own docs note it is left
  click in some environments and double left click in others. PwrSnap wires
  no `click` handler on Linux, because the two candidate responses are both
  wrong somewhere: doing nothing leaves the icon unresponsive on a host that
  maps left-click to Activate and the menu to another gesture, while opening
  the Library raises a window on every click on a host that both opens the
  menu and sends Activate. `popUpContextMenu` is `@platform darwin,win32`, so
  "show the menu" is not available as the response. Deciding this needs
  measurement across real desktops rather than a guess; until then the menu
  gesture is the only tray affordance.
- **The menu is only re-exported when it would look different.**
  `refreshNativeTrayMenu` compares a signature of the template (labels,
  accelerators, enabled flags, `type`, and submenus) against what was last
  exported and skips `setContextMenu` on a match. This is not only a saving:
  `setTrayHotkeys` is wired to `onSettingsChanged`, which fires on every
  settings and secret write, and replacing the exported menu object can close
  an open menu on some SNI hosts. A failed export deliberately does not
  update the signature, so the next refresh retries rather than treating a
  menu the host never received as the live one.
- **All Electron apps share one indicator id.** Since the
  `StatusIconLinuxDbus` migration, Electron apps register as
  `chrome_status_icon_1` rather than under the application name — reported as
  [electron/electron#40936](https://github.com/electron/electron/issues/40936).
  Desktop features that sort, hide, or reorder individual tray icons cannot
  tell PwrSnap apart from any other Electron app. Nothing PwrSnap can fix.

## Linux is not a distribution target

There is no `linux:` section in
[electron-builder.yml](../apps/desktop/electron-builder.yml) and no Linux
release artifact; the Linux CI job is E2E only. Everything above applies to
running from source (`pnpm dev`) or to a package someone builds by hand.
Because there is no Linux package, there is also nowhere to *declare* a
runtime dependency — which is moot anyway, per the libayatana note above.
