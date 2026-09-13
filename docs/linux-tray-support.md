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
| Recording indicator | icon title (`● REC`) + tooltip + menu | tooltip + menu | tooltip + menu |
| Timed-capture countdown | icon title (`3 / 2 / 1`) | — | — |

On Linux the tray offers Quick Capture, Record Video, Open Library,
Settings and Quit — the same verbs as the popover's primary actions. What it
does **not** offer is the popover's rich content: the last-snap preview, the
export preset grid, the drag-out affordances. Those live in the Library
window on Linux.

## Why not the popover

This is not a UI preference. Four separate pieces of Electron's Linux
surface make the popover unbuildable, and all four are stated in Electron's
own type definitions (checked against the pinned `electron@41.10.7`):

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
   popover sizing"), so a popover that did somehow open in the right place
   still could not hug its content.

A native menu has none of these problems: the host draws it, positions it,
and sizes it, on X11 and Wayland alike, and on every desktop that supports a
tray at all.

The popover factory (`createTrayWindow`) still exists and still runs on
Linux — but only under E2E, where `showTrayPopoverForE2E` pins the window at
a fixed point on the primary display so the tray renderer can be measured
under xvfb. **A green Linux E2E tray spec is not evidence that a Linux tray
popover works**: xvfb is X11, and no indicator is driving it.

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
