# The Dock reclaim restores activation POLICY, not activation

**Symptom.** Start a video recording and pick a PwrSnap window itself as
the target (the Library). The countdown HUD shows on top as expected,
but the window being recorded dives underneath another app's window
part-way through the ~3s countdown. The user has to find it and click it
before the countdown ends, or the take records whatever is now covering
it. Captures taken with the still-image path are unaffected.

## The two wrong answers this replaced

Both were plausible enough to be written down before the logs existed,
and both are dead.

**"The raise branch needs the spread Dock reclaim its sibling has."**
`startRecordingFromSelection`'s raise branch calls
`reclaimDockIconIfLibraryAlive()` once, while the `previousAppPid`
branch below it calls `scheduleDockReclaim()` — a spread of five
attempts — with a comment about catching AppKit's async demotion. The
asymmetry looks like the bug. It is not: `tearDown()` calls
`scheduleDockReclaim()` **unconditionally**, before the three-case
branch, so the raise path has always had the spread. Adding it again
would be a literal no-op. The logs also show the spread working — it
caught a demotion and re-asserted Regular policy mid-countdown.

**"The reclaim itself knocks us down."** Electron's `dock.show()` has a
`TransformProcessType` workaround that activates `com.apple.dock` first
*when our app is active*, so a reclaim firing while we held activation
could plausibly have deactivated us. Ruled out by measurement: we had
already lost activation before the reclaim ran, so that branch was never
taken.

## What actually happens

Instrumented take, all times relative to the commit-time raise at t=0
(`video-record raised our windows`, which reported `dockVisibleAfter=true`):

| t | event |
|---|---|
| +94ms | lead-in tick, phase `preflight`: `focusedWindowTitle=PwrSnap`, `dockVisible=false` |
| +101ms | lead-in tick, phase `countdown`: same |
| +125ms | `reclaiming Dock icon …` with `focusedWindowTitle=null` |
| +1104ms | lead-in tick, `countdown`: `overlappingCount=2` `focusedWindowTitle=null` `dockVisible=true` |
| +2111ms | lead-in tick, `countdown`: identical |
| +3117ms | lead-in tick, `starting`: identical |

Read the two columns separately and the whole thing falls out:

1. By +94ms the Dock tile is already stripped — AppKit has demoted us to
   Accessory — but a window titled `PwrSnap` still holds key. That is
   most likely the Library, with the app still active (an Accessory app
   can hold activation; the two are not the same bit) — but see the
   caveat below: the title cannot rule out the focus-sink.
2. Between +101ms and +125ms the last PwrSnap window loses key; by the
   reclaim nothing of ours is key and another app is frontmost.
3. At +125ms the spread reclaim fires and re-asserts Regular policy. The
   Dock tile comes back (`dockVisible=true` from +1.1s on). **Activation
   does not**, and nothing else asks for it.
4. For the remaining ~3s the recording-controller's per-tick re-raise
   runs on schedule, reports the correct overlap set, and calls
   `moveTop()` on it — with no visible effect.

Step 4 is the part that makes this hard to see. macOS orders an
**inactive** app's window only among that app's own windows, so
`moveTop()` is not a no-op — it really does reorder the Library relative
to our other windows — it simply cannot lift it above the active app's
window. The log line looks completely healthy every tick. That re-raise
loop was added for this exact user-visible symptom and its comment says
so; it was never able to fix it.

**Policy, activation and z-order are three different things.** The
reclaim restores the first. Nothing restored the second, and the third
follows the second.

## The fix

`scheduleLeadInReraise` in
[record-from-selection.ts](../../apps/desktop/src/main/recording/record-from-selection.ts):
a spread of deferred checks alongside the Dock reclaim's, each of which
re-activates **only if the recorded window has lost key**. Pinned by
`record-from-selection-overlap.test.ts` §"holding z-order through the
lead-in".

The scoping decisions, all load-bearing, all mutation-tested:

- **Only the raise branch schedules it.** Case two — the user snapped to
  another app's window — must never pull PwrSnap forward. The
  recording-controller's per-tick loop cannot make that call: it only
  knows the rect overlaps one of our windows, which is true in both
  cases (the Library sitting partially behind the window the user
  picked). The three-case decision lives in `record-from-selection.ts`,
  so the recovery has to as well.
- **Lead-in phases only** (`preflight` / `countdown` / `starting`). Once
  the take is live, activating PwrSnap records the recorded app losing
  focus — menu bar switch, title bar going inactive, caret vanishing,
  all inside the rect and all in the file. See AGENTS.md "Mid-take UI".
  The same guard is what stops an Escape-cancelled countdown from
  yanking us forward a second later, since the phase leaves the set.
- **macOS only.** The demotion is AppKit's; on Windows and Linux
  `activateApp` is a no-op, so all that would remain is `focus()`ing the
  Library over whatever the user clicked.
- **Only when none of the windows we raised holds key.** The first
  version asked `getFocusedWindow() !== null` instead, on the theory
  that a key window implies an active app. It does not here: the
  focus-sink is a focusable **non-activating** panel and can hold key
  while another app is frontmost — which would have skipped the
  re-raise in exactly the state it exists for. `win.isFocused()` on the
  recorded window asks the real question, and the common case still
  spawns no helper.
- **Each timer belongs to its take, and checks the phase on both sides
  of the helper.** A selection-generation counter stops a cancelled
  take's timers acting on the next one (a quick case-two commit), and
  the phase is checked again after `activateApp` returns, because the
  helper can take up to its 1.5s timeout.
- **The spread stops at 1s on purpose.** Activation happens inside the
  helper, where nothing can recall it; ending at 1s keeps a stalled
  helper's activation (≤2.5s) ahead of `starting`. A later demotion is
  not covered — none was measured — and covering one means cutting the
  helper timeout in step.

## If you are chasing this again

- **`dockVisibleAfter=true` proves nothing about z-order.** It was in the
  log from the start and is what made the first hypothesis look wrong-ish
  but survivable. Read `focusedIsOverlapping` / `focusedIsLibrary`
  instead.
- **A focused-window TITLE proves little.** The Library is titled
  `PwrSnap`, and the focus-sink — which can be key in an inactive app —
  may fall back to the same app name. The +94ms reading above predates
  the `focusedIs*` fields and cannot tell the two apart; the fix does
  not depend on which it was.
- **A healthy-looking overlap set proves nothing either.** Every tick in
  the failing take reported the right windows.
- The demotion is not unique to recording — the first reclaim of any
  session fires when the selector *shows*, with the same
  `focusedWindowTitle=null`. That one is pre-existing and harmless
  because nothing is being recorded yet.
- The instrumentation that settled it is still in place:
  `recording lead-in z-order tick` (debug, in `recording-controller.ts`)
  and the `focusedWindowTitle` / `focusedIsLibrary` fields on the
  reclaim line (info, in `window.ts`). The reclaim line is deliberately **info**, so a field
  report distinguishes the two failure modes without the user having to
  turn debug collection on first.
