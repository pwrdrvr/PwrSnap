# features/update — AGENTS.md

## Two channels, and they are not redundant

`AppUpdateBanner` listens to both `events:app-update:status` and
`events:app-update:check-result`, and collapsing them into one breaks the
feature:

- **`events:app-update:status`** carries *what the updater is doing* —
  checking, available, downloading (with percent and bytes), downloaded,
  canceled, install-failed, error. Every check moves it, including the hourly
  background ones.
- **`events:app-update:check-result`** is emitted from exactly one place —
  `runMenuUpdateCheck` in [auto-updater.ts](../../../../main/auto-updater.ts),
  i.e. Help → Check for Updates. It is the only thing that distinguishes "the
  user is waiting for this answer" from "the hour hand looked again".
  Settings → Updates' own **Check for Updates** button deliberately does not
  emit it: that surface reports its result inline, and a card in the Library
  repeating the answer would be saying the same thing twice.

So the live progress card is gated on having seen a `checking` tick on the
*result* channel, and is then driven by the *status* channel. A background
download must raise nothing: the user did not ask, and the only thing worth
interrupting them for is the finished, actionable offer.

`checking` is the one mid-flight value on the result channel; every other
value on it is an outcome — and `available` is deliberately NOT one of them.
`checkForAppUpdatesNow` answers `available` the moment electron-updater
accepts the release, with `autoDownload` on and the whole download still to
run, so `runMenuUpdateCheck` holds the outcome back until the download
settles. Report `available` as the outcome and the card comes down
mid-download, which is the defect this channel exists to fix.

## In-flight gets a progress track; finished gets the countdown

A countdown drains toward a dismissal. That is right for a notice that has
finished talking and wrong for work still running — a real download is
minutes, and before this the menu check said nothing at all while the whole
download ran invisibly, with no way to stop one.

So: while a user-initiated check is working, `AppUpdateBanner` renders a live
card — progress track, byte meter, Cancel — with **no** `.app-update-banner
__timer`. Only when the check settles does the outcome go on a card that has
one. Don't put a countdown on the live card, and don't leave one off the
settled card.

## The compact rows stay out of this

`AppUpdateRow` (tray popover + post-capture float-over) shows **actionable
states only**, and that is deliberate — see the header of
[app-update-notice.ts](./app-update-notice.ts). Both popovers size themselves
to their content, so a row that appears and vanishes mid-check resizes the
window under the user's cursor; the float-over arrives unbidden after every
capture and has no business reporting work the user started somewhere else.
The Library window is where Help → Check for Updates is answered.

If a future change does want progress in the tray, gate it on the same result
channel — never on the status channel alone, or an hourly background download
starts resizing the popover.

## Cancel is offered from `available`, so main must be ready by then

`updateProgressCopy` turns Cancel on as soon as the status reaches
`available` — before any bytes have moved. `auto-updater.ts` therefore
registers its `activeDownload` at that same moment, with an empty `cancel`
slot that electron-updater's token fills in once it exists, and honours a flag
that was already set (`applyPendingCancel`). Register it any later and there
is a window in which the button is on screen and does nothing: the click marks
the card `canceling`, main finds no download, and the update installs anyway.

## A cancel is not an error

`{ status: "canceled" }` is its own status on purpose. `available` would
promise a download that is no longer running, and `error` would put a danger
eyebrow in front of someone who got exactly what they asked for.
electron-updater agrees: it deliberately does **not** dispatch its `error`
event for a cancellation, and emits `update-cancelled` instead.

The download's rejection is byte-identical to a network failure's, so
`auto-updater.ts` remembers that *it* asked (`activeDownload.canceled`) rather
than sniffing the error. Keep that flag the discriminator.

That rejection handler is also the only thing observing `downloadPromise` at
all — this app's check does not await it — so removing it puts every failed
download back to being an unhandled rejection.

## Every wording has a downgrade twin

PwrSnap can offer a move *back* to the selected slot (`downgrade: true`),
which PwrGit has no equivalent of. A version number lower than the running one
described as an "update" reads as a bug, so `updateProgressCopy` and
`updateCheckOutcomeNotice` each word the switch case separately, the same way
`appUpdateNotice` already does. Main carries the flag onto `downloading` and
`canceled` so they can.

## The `checking` tick is edge-triggered, so there is a snapshot beside it

`events:app-update:check-result` is fired once and never replayed. A window
that subscribes a beat later misses the whole check and shows nothing until
the finished offer arrives — and **React flushes passive effects AFTER
paint**, so that gap is reachable even for a window that was already on
screen when the user picked the menu item. It showed up as an e2e flake
where the first thing the Library ever rendered was "Update ready".

So `use-user-update-check.ts` also reads `app:update:userCheckRunning` on
mount and races it against the live event — the same shape of recovery
`useAppUpdateStatus` already does with `app:update:status`, and for the same
reason. A real event always wins. Main holds the flag in `runMenuUpdateCheck`
alone, so the snapshot cannot raise a card for a background download.

The flag is a COUNT, not a boolean: the menu item has no disabled state, so a
second click gives a second `runMenuUpdateCheck` frame, and whichever finished
first would otherwise answer "nobody asked" while the other still held the
card open.

**The menu item goes over the bus, not straight to the function.** The
application menu is installed by whichever process owns the windows — the
LIBRARY process under the experimental split — while `app:update:*` routes to
the agent. `index.ts` therefore dispatches `app:update:menuCheck`; calling
`runMenuUpdateCheck()` locally ran a second, uninitialized electron-updater in
the wrong process and set a flag that `app:update:userCheckRunning` (also
agent-routed) never read, so the recovery above was dead in split mode.

Anything else that comes to be driven off this channel needs the same pair:
the event for liveness, the snapshot for a late arrival.

## The stand-in `checking` is held here, never written into the status

The result channel's `checking` tick outruns the status event it mirrors by
however long the GitHub release read takes, so `use-user-update-check.ts`
shows a local `checking` until a real status arrives. It is **local state**,
not a write into the shared status, because a check started while an update is
already downloaded must not walk that status backwards — main answers that
case from its held download without emitting a single status event, so a
clobbered status would take the standing Restart offer away permanently.
Pinned by `AppUpdateBanner.test.tsx` §"keeps a standing Restart offer while a
fresh check runs beside it".

## The dev fake is the only way to see any of this

Real auto-update runs in packaged builds only, so `simulateDevUpdateCheck`
walks the whole machine — checking → available → a ramp of download percents
with byte counts → downloaded — for a user-initiated check in `pnpm dev`. It
ramps rather than emitting one sample because a meter cannot be judged against
a single frozen percent, and it honours Cancel for the same reason.

The e2e harness launches with `NODE_ENV=production` and skips
`initAppUpdater`, so it needs `PWRSNAP_E2E_UPDATE_FAKE=1` to put the fake back
(and `PWRSNAP_E2E_UPDATE_STEP_MS` to pace it, so `e2e/update-check.spec.ts`
can click a button that only exists mid-download). Both are gated on
`PWRSNAP_E2E=1`. Unlike PwrGit's, this path has no platform branch — the fake
runs the same on the Linux CI lane as on macOS — so the spec needs no
`test.skip(LINUX)`.

## A version the app names, it must also be able to describe

Every update surface prints a version number the user has never seen and
cannot look up from inside the app. Settings → About's **Open changelog**
reads the `CHANGELOG.md` that shipped INSIDE the running build, so by
construction it says nothing about the build being offered — a v1.1.0
install cannot carry v1.1.1's notes. Before this the four-slot matrix, the
`Update ready: v1.1.1` line, the Library toast and the two compact rows all
named a version with no way out to what is in it.

So: **any surface that renders a version renders a
[`ReleaseNotesLink`](./ReleaseNotesLink.tsx) beside it**, and the URL comes
from `releaseNotesUrl` in
[packages/shared/src/release-notes.ts](../../../../../../packages/shared/src/release-notes.ts)
— never composed at the call site.

Five things about that are load-bearing:

- **The control takes a VERSION, never a URL.** That is what keeps "a
  version that is not a published release gets no control" a single
  decision. `app-update-notice.ts` and `update-progress.ts` carry a
  `version` on their copy objects and know nothing about GitHub; they must
  not grow a `notesUrl` field again, because a URL alongside the version it
  is derived from is state that can disagree with itself, and it drags the
  composer into every module that writes wording.
- **The URL is DERIVED from the version, not read from the feed.**
  `AppUpdateReleaseInfo.url` carries GitHub's `html_url` for the four
  published slots, but the STATUS surfaces have no feed record at all —
  `AppUpdateStatus` carries a bare version through every transition,
  including the ones electron-updater raises, which never saw our GitHub
  read. One composer that takes a version is the only thing all five
  surfaces can share. Deriving is exact because the release tag is `v` +
  the version (`configureAutoUpdaterFeedForRelease` already assumes it).
- **No URL means no control.** `releaseNotesUrl` answers `undefined` for
  anything this repo could not have tagged — a dev build, a
  `PWRSNAP_E2E_APP_VERSION` override, a tag like `nightly` — and
  `ReleaseNotesLink` renders `null` for it. A link onto a 404 is worse than
  none, and in the tray and float-over it would also cost popover width for
  nothing.
- **It is an `<a href>` whose click is cancelled, and it carries no
  `title`.** The `onClick` → `preventDefault()` → `app:openExternal`
  pairing is the mechanism — it is what opens the page and the only path
  that could report a failure — and the `href` is what makes a
  middle-click or cmd-click land somewhere, since Chromium turns those into
  a `window.open` that `onClick` never sees. That input is safe because of
  the navigation guard (root AGENTS.md, "No webContents opens a window, and
  none navigates away"), which denies the window and hands the URL to the
  browser after clearing the SAME allowlist the verb uses. It was written as
  a `<button>` first, in the window before that guard landed, when a
  modifier-click on a real anchor would have loaded github.com inside a
  BrowserWindow carrying our preload — so if the guard is ever removed, this
  goes back to a button rather than losing the `onClick`. **`disabled` drops the `href`, not just marks it
  aria-disabled** — otherwise a greyed-out control is the one thing on the
  surface still answering a cmd-click. `title` is out because with an
  accessible name already present it becomes the accessible DESCRIPTION,
  and a screen reader then reads the whole URL aloud after the link — and
  PwrSnap wires no context-menu handler, so there is no "Copy Link Address"
  it would feed. All pinned by `ReleaseNotesLink.test.tsx`, and
  `main/__tests__/app-open-external-release-notes.test.ts` runs every
  composed URL through BOTH gates — a URL the verb opens and the guard
  blocks is a control that works on one input and silently does nothing on
  the other.
- **Settings → Updates hangs it OUTSIDE the tile.** The slot tile is a
  `role="radio"`, and an interactive element nested in one is neither valid
  HTML nor keyboard-reachable — hence `.pss__slot-cell` wrapping the two.
  All four slots get a link, not just the selected one: picking a slot
  rewrites which build the app installs, so reading the notes has to be
  possible without picking. Pinned by
  `features/settings/__tests__/UpdatesPage.test.tsx`, which also pins that
  the status line's link follows the LIVE status rather than the settled
  check result — the same precedence the sentence beside it uses.

The one surface that deliberately renders NO link is the `checking` card —
it has no version yet.

**On the two compact rows the control takes `.psu__x`'s tones, not
`.psu__go`'s.** It has no opaque background, so its label sits directly on
the row's `--accent-tint` (and on `--warn-soft` in the retry variant),
where `--accent` measures 4.29:1 in the light theme — under the 4.5:1 AA
floor for 10px bold. The comment above `.psu__go` in
[update-row.css](../../styles/update-row.css) is where that number comes
from. Do not brighten it to accent without giving it an opaque fill first.
