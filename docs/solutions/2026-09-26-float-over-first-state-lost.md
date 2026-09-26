# The float-over's first state event was sent on a guess

**Symptom.** The first capture of a session could show no toast. Main
creates the float-over window lazily, inside the first
`setFloatOverState`, so that event always exists before the renderer
that has to show it. Main held it in `lastEvent` and sent it 100ms after
`did-finish-load`. The renderer subscribes in FloatOverHost's
`useEffect`. When the first render outlasted the 100ms, the event
reached a renderer with no subscriber and was dropped. Nothing resent
it.

Measured result: the renderer stayed at `data-state="idle"` with no
`.fo`. From the code, what that leaves on screen: main has already
restored the window (`setIgnoreMouseEvents(false)`), the idle div
measures about 0, and the resize clamps the window to
`FLOAT_OVER_HEIGHT_MIN_DIP` (160). That is a transparent 392×160 window
at the bottom-right that takes clicks. The copy shortcuts are armed for
a capture the user cannot see, and main's state stays `loaded` until the
next capture, because the auto-dismiss countdown lives in a toast that
never rendered.

## State or intent?

`floatOverState` is a **state broadcast**. Every event replaces the
renderer's whole state (`show-idle` → idle, `show-loaded` → that
capture, `cancel` / `dismiss` → idle), and main keeps the latest one.
A late subscriber needs only the latest event, and main still has it.
A preload latch is for a one-shot intent that exists nowhere else.
Here the renderer can simply ask.

## Measurements

All runs used the Linux Docker harness (`scripts/e2e/run-docker.sh`,
arm64, 4 CPUs) with a temporary probe spec. Each launch did one thing:
it called `setFloatOverState({ kind: "show-loaded" })` through the E2E
bridge, as the float-over's first event. CPU load came from
`node -e "for(;;){}"` children: 2× or 6× the CPU count.

Timing came from temporary instrumentation. The preload installed a raw
listener on `floatOverState` and wrapped `pwrsnapApi.on`. It reported
`recv` (with the live subscriber count) and `subscribe` to main over
IPC, as `performance.now()` plus `performance.timeOrigin`. Main recorded
its own events with `Date.now()`. Nothing touched the float-over
renderer until 4s after the send.

FloatOverHost subscribed this long after `did-finish-load` on
origin/main:

| load | launches | min | median | max | first event lost |
|---|---|---|---|---|---|
| none | 10 | 9ms | 13ms | 48ms | 0 |
| 2× CPUs | 10 | 16ms | 24ms | 61ms | 0 |
| 6× CPUs | 10 | 43ms | 84ms | 115ms | **2** |

The two losses, times in ms from window creation:

| | loss 1 | loss 2 |
|---|---|---|
| `did-finish-load` | 679 | 702 |
| main sends (timer) | 780 | 803 |
| renderer receives, **0 subscribers** | 793.6 | 810.6 |
| FloatOverHost subscribes | 794.0 | 811.2 |
| toast 4s later | `idle`, no `.fo` | `idle`, no `.fo` |

The subscription came less than a millisecond after the event. The
render was finishing, and the IPC task ran just ahead of React's
passive-effect flush.

With the fix, under 6× load, 20 of 20 first toasts rendered. The reply
went out 0.4–9ms after the subscription, once per launch.

## The fix

FloatOverHost subscribes, then calls `pwrsnapApi.requestFloatOverState()`.
Main checks that the request came from the float-over's own
webContents. It then answers with `lastEvent` on `floatOverState` and
starts sending live. There is no timer and no load event.

- **Subscribe first, then ask.** The answer travels on the state
  channel, and an answer with no subscriber is dropped. The renderer
  test fails if the two lines are swapped.
- **Nothing goes out live before the request.** So the first event is
  delivered exactly once. It is not sent live and then replayed.
- **A reloaded renderer asks again.** The old code replayed only on the
  first `did-finish-load`.

## A probe that hides the bug

The same trap the Library's lost `editor:open` intent hit
([pwrdrvr/PwrSnap#653](https://github.com/pwrdrvr/PwrSnap/pull/653)).
A `page.evaluate` or `executeJavaScript` into the float-over before the
send queues behind the first render, so the test cannot send before the
renderer is up. Report renderer times to main over IPC and read them
from main. Only then inspect the renderer.

## Checked and not affected

- `floatOverCopyPulse` and `floatOverVideoCopyShortcut` fire only from
  shortcuts armed on a toast that is already showing. The renderer is
  subscribed by then.
- The tray popover has no equivalent held event.
