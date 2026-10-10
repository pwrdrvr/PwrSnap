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

The same holds on GNOME's own window manager, measured on mutter 46 with
pixels read back through its ScreenCast API. With a 32px top / 67px left
strut, a native Wayland window requested at `0,0 1920×1080` landed at
`67,32`: mutter moves a monitor-sized toplevel into the work area. Yet
`getBounds()`, `getContentBounds()` and the renderer's `screenX/Y` all read
`0,0`, and `screen.getPrimaryDisplay().workArea` still reported the whole
display, because a Wayland client is not told about struts either.

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
XWayland is quietly saving you. It was measured again on mutter 46 headless
and on sway 1.9, both with `DISPLAY` set, and both resolved to `wayland`. It
holds even with `WAYLAND_DISPLAY` unset, as long as `XDG_SESSION_TYPE=wayland`:
Chromium falls back to the default `wayland-0` socket.

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

So the compositor decides where it goes, and it does NOT choose the centre of
the screen on stock GNOME. Measured on mutter 46 with default settings, a
frameless popover-sized native Wayland window lands by mutter's automatic
placement, near the **top-left of the work area**. The 440×302 popover
landed at `111,78` in a work area starting at `67,32`, and a toast mapped
next went directly below it at `111,380`. mutter centres new windows only
with `org.gnome.mutter center-new-windows` set to true (measured: both
centred), and neither GNOME's nor Ubuntu 24.04's shipped overrides set it.
sway floats the popover in the centre. **A popover that opens somewhere is
worth more than no popover**, which is the trade this feature makes; it is
not a placement that more arithmetic could improve.

**X11 keeps a real anchor.** `setPosition` works there for an on-screen
target: measured under XWayland on mutter 46, a toast requested at the
bottom-right landed exactly there. `getBounds()` is still zeros, but the
pointer is on the indicator at the moment the row is clicked, so the popover
is centred under the cursor and clamped into the work area, which makes it
correct for a bottom panel as well as a top one.

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

Identical on weston and on xvfb, and on mutter 46 headless (native Wayland,
`innerHeight` following `setContentSize` to `620` and back to `300`). On sway
1.9 the real popover, opened from the menu row, was constructed at 880 and
reported by the compositor at `440×302` once the renderer's measurement
landed. Window *size* is client-driven in xdg-shell, so this is a protocol
property rather than a weston courtesy. The design still keeps two hedges,
because a resize can land late:

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

Measured on sway 1.9 with the real build: the popover took keyboard focus
when shown, and all three exits worked. Re-picking the row closed it,
Escape closed it, and focusing another window closed it through blur. Two
caveats come with that. Focus on a Wayland seat rides `wl_keyboard.enter`,
so a headless seat with no keyboard device delivers no `focus`/`blur` to
any client, and blur-dismiss looks broken there when it is not. Give the
seat a virtual keyboard (`wtype`) before measuring. And whether GNOME Shell
gives the popover focus is still unmeasured; the toggle is the exit that
does not depend on the answer.

## The float-over toast on Linux

The post-capture toast was independently broken on Linux, and the root cause is
one line of `electron.d.ts`: **`setOpacity` is `@platform win32,darwin`.**
That held through Electron 41. Electron 44 implements it on Linux; see
§"Measurements" for what that does and does not show.

The toast never called `hide()` off Windows. It pseudo-hid with `setOpacity(0)`
plus `setPosition(-20000, -20000)` and restored with `setOpacity(1)` plus a
once-only `showInactive()`. On macOS that is deliberate — a real `hide()` there
is `[NSWindow orderOut:]`, which cascades key state through the floating-level
focus sink and yanks the caret out of whatever app the user is typing in.

On Linux none of it works:

| Call | Linux X11 | Linux Wayland |
|---|---|---|
| `setOpacity(0)` | **inert** — `getOpacity()` still `1` | **inert** |
| `setPosition(-20000, …)` | works on a bare X server; a real WM refuses it (mutter 46 put the window at `0,0`) | **inert** |
| `hide()` / `showInactive()` | works | works |

(`setOpacity` is also inert on mutter 46, on both backends.)

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
applied on X11 and deliberately not attempted on Wayland, where stock mutter
puts the toast near the top-left of the work area (see §"The popover on
Linux") and sway tiles or floats it. One extra caveat
there — `screen.getCursorScreenPoint()` is not a reliable global pointer read
for a Wayland client, so on a multi-monitor Wayland session the toast may be
anchored to the wrong display. It is not placed there anyway, so the practical
effect is nil until placement becomes possible.

`showInactive()` has no Wayland equivalent. There is no protocol for mapping
a toplevel without focus, so the compositor decides, and sway focused the
toast on every show.

**Measured end to end on sway 1.9, with #593, #594 and this change merged.**
The flow was tray → Quick Capture → fullscreen selector → Enter. The toast
appeared with the capture. Escape on it hid it, a second capture showed it
again (the once-only show is gone), and Escape in the selector cancelled
with the toast staying hidden. The native Wayland client took the grab
through Xwayland, because the container's portal could not stream.
**Without #593's fullscreen selector**, the toast pre-shown at `show-idle`
took keyboard focus from the (non-fullscreen) selector. Enter and Escape
then went to the toast, so the selector could not be committed or
cancelled from the keyboard. Land this after #593, not before.

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

**One row changed in Electron 44.** The same xvfb recipe on 44.4.5, with 41.10.7
run beside it for control, gives `getOpacity()` = `0.25` after
`setOpacity(0.25)` and `0` after `setOpacity(0)` (41.10.7: `1` both times).
`hide()` / `showInactive()` are unchanged. That is a readback, and xvfb has no
compositor to draw it, so it shows the call now stores the value, not that a
window fades. The float-over keeps its real `hide()` on Linux either way. The
rest of the table was not re-run on 44, and Wayland was not re-measured.

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
A bare xvfb container has no panel, so every call above succeeds and nothing
appears — which is precisely the failure mode this whole document is about.
The next recipe closes that gap.

### Against a real StatusNotifierItem host

A headless wlroots compositor with a bar gives a container a real SNI host:
waybar's `tray` module owns `org.kde.StatusNotifierWatcher`, draws the icon,
and lets the exported menu be driven over D-Bus exactly as a panel drives
it. Measured on Electron 41.10.7 with the real PwrSnap build
(`pnpm --filter @pwrsnap/desktop build`, then `electron .` as a throwaway
user) under sway 1.9 + waybar 0.9.24:

| What | Result |
|---|---|
| host probe log line | `linux tray host probe statusNotifierHost=present desktop=sway sessionType=wayland` |
| watcher's `RegisteredStatusNotifierItems` | the PwrSnap item, once `installTray` runs |
| the icon in the bar | **drawn** — a `grim` screenshot shows the tangerine mark in waybar's tray |
| `IconPixmap` | one `48×48` image — the `tray-icon-linux.png` bitmap, as intended |
| `Id` | `PwrSnap_status_icon_1` |
| `ItemIsMenu` | `false` |
| `Menu` | `/com/canonical/dbusmenu`; `GetLayout` returns Quick Capture…, Record Video…, Show Last Capture…, Open Library, Settings…, Quit PwrSnap (plus separators), Quick Capture carrying the `Control+Shift+C` shortcut once the hotkey registers |
| dbusmenu `Event(<id>, "clicked")` | dispatches the row: Quick Capture opens the selector (`origin=native_tray_menu.quick_capture`), Settings… opens Settings, Show Last Capture… toggles the popover |
| `Activate(x, y)` | Electron emits `click` |
| `SecondaryActivate(x, y)` | Electron emits `click` as well — not a separate event |
| `ContextMenu(x, y)` | Electron emits nothing; the host draws the menu from `Menu` |
| `ProvideXdgActivationToken(s)` | `UnknownMethod` — not implemented (see Known limitations) |

Two things trip up a scripted run. Electron renumbers every dbusmenu item on
the first `GetLayout` after a re-export, so look an item up by label just
before sending `Event` rather than caching its id; a real host re-fetches on
`LayoutUpdated` and never notices. And the menu is exported twice at boot by
design — once from `installTray`, once more when the hotkey registers and
the Quick Capture accelerator appears. That is the signature gate working,
not a stray republish.

The recipe, run as the unprivileged user that owns the session. Nothing here
touches a real desktop:

```bash
cat > ~/sway.conf <<'EOF'
output HEADLESS-1 resolution 1920x1080
bar { swaybar_command waybar }
EOF
# ~/.config/waybar/config — just the tray:
#   { "modules-right": ["tray"], "tray": { "icon-size": 24 } }
export XDG_RUNTIME_DIR=$(mktemp -d) XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway
export DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)
WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway -c ~/sway.conf &
# launch PwrSnap (or a bare Tray script), then:
gdbus call --session --dest org.kde.StatusNotifierWatcher \
  --object-path /StatusNotifierWatcher \
  --method org.freedesktop.DBus.Properties.Get \
  org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems
gdbus call --session --dest <item> --object-path /com/canonical/dbusmenu \
  --method com.canonical.dbusmenu.GetLayout -- 0 -1 '@as []'
grim /tmp/bar.png
```

This is a wlroots host, not GNOME's AppIndicator extension. It answers what
Electron exports and what a host can do with it — not which gesture GNOME
Shell maps to `Activate`. That part still needs a GNOME session.

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
  `weston --debug`; it hung rather than failing, so weston placement was never
  confirmed at pixel level. Placement has since been confirmed on mutter 46
  (below) and on sway 1.9, whose `grim` and `swaymsg -t get_tree` report the
  compositor's own view.

**mutter is reachable from a container too**, and that closes most of the
"weston is not mutter" gap. `mutter --headless --wayland --virtual-monitor
1920x1080` is GNOME's window manager without the Shell UI, and its own
`org.gnome.Mutter.ScreenCast` D-Bus API streams the output over PipeWire.
One frame from `gst-launch-1.0 pipewiresrc path=<node> num-buffers=3 !
videoconvert ! pngenc snapshot=true ! filesink` confirms placement at pixel
level. Panel struts can be stood in for by two X11 `_NET_WM_WINDOW_TYPE_DOCK`
windows with `_NET_WM_STRUT_PARTIAL`, mapped through mutter's Xwayland.
Everything this document says about mutter was measured that way.

What still needs a real GNOME Shell session: whether the Shell gives a newly
mapped popover focus, and which gesture its AppIndicator extension maps to
`Activate`.

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
  `click` on Linux when the item is activated — measured on 41.10.7, for
  `Activate` AND for `SecondaryActivate` (usually the middle button), while
  `ContextMenu` emits nothing. The item also exports `ItemIsMenu = false`,
  which tells a host that honours the property to send `Activate` on the
  primary click instead of opening the menu; on such a host a left-click on
  PwrSnap's icon currently does nothing. The SNI spec does not say which
  gesture causes an activation — Electron's own docs note it is left
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
- **A tray action cannot raise a PwrSnap window that is already open, under
  Wayland.** A Wayland client may only take focus with an activation token,
  and the only token a tray click could carry is one the host hands over
  through the SNI `ProvideXdgActivationToken` extension — which Electron
  41.10.7's item does not implement (measured: `UnknownMethod`). So a
  dbusmenu click reaches PwrSnap with no token. Measured on sway: "Open
  Library" with the Library already open behind Settings left focus on
  Settings. A window the action CREATES does get focus (Settings… opened
  focused the first time), because placing a new toplevel is the
  compositor's call. What GNOME Shell shows instead of raising is not
  measured. Nothing PwrSnap can fix without Electron support; re-check on a
  major bump.
- **The indicator id is per-app at this pin.**
  [electron/electron#40936](https://github.com/electron/electron/issues/40936)
  reports Electron apps registering as `chrome_status_icon_1`, which would
  make PwrSnap indistinguishable from every other Electron app to desktop
  features that sort, hide, or reorder tray icons. Measured on 41.10.7 the
  item's `Id` is `PwrSnap_status_icon_1`, so that does not reproduce here.
  Re-check on an Electron bump; it is one `gdbus` call (see §"Against a real
  StatusNotifierItem host").

## Linux is not a distribution target

There is no `linux:` section in
[electron-builder.yml](../apps/desktop/electron-builder.yml) and no Linux
release artifact; the Linux CI job is E2E only. Everything above applies to
running from source (`pnpm dev`) or to a package someone builds by hand.
Because there is no Linux package, there is also nowhere to *declare* a
runtime dependency — which is moot anyway, per the libayatana note above.
