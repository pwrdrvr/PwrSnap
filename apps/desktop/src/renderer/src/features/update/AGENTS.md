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
