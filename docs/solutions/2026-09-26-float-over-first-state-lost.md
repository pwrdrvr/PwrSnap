# The float-over's first state event was sent on a guess

**Symptom.** The first capture of a session could show no toast. Main
creates the float-over window lazily, inside the first
`setFloatOverState`, so that event always exists before the renderer
that has to show it. Main held it in `lastEvent` and sent it 100ms after
`did-finish-load`. The renderer subscribes in FloatOverHost's
`useEffect`. When the first render was still running at the send, the
event could reach the renderer before its subscriber and be dropped.
Nothing resent it.

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
`node -e "for(;;){}"` children: 2×, 6× or 12× the CPU count.

Timing came from temporary instrumentation. The preload installed a raw
listener on `floatOverState` and wrapped `pwrsnapApi.on`. It reported
`recv` (with the live subscriber count) and `subscribe` to main over
IPC, as `performance.now()` plus `performance.timeOrigin`. Main recorded
its own events with `Date.now()`. Nothing touched the float-over
renderer until 4s after the send. The two clocks agree to about a
millisecond; where order mattered, main's own receipt order settled it.

| build | load | launches | subscribe after `did-finish-load` | send before subscribe | lost |
|---|---|---|---|---|---|
| origin/main | none | 10 | 9–48ms | 0 | 0 |
| origin/main | 2× | 10 | 16–61ms | 0 | 0 |
| origin/main | 6× | 30 | 11–115ms | 2 | **2** |
| origin/main | 12× | 10 | 79–154ms | 7 | **3** |
| fix | 6× | 20 | 3–89ms | 0 | 0 |
| fix | 12× | 10 | 94–165ms | 0 | 0 |

Being late is not enough to lose the event. The timer's send also runs
late under load, and a send that reaches a renderer still mid-render
sits in the queue. What decides it is the next task: if React's
passive-effect flush runs first, the event is delivered; if the IPC
task does, it is dropped. Every loss was a send that landed before the
subscription, and those races were lost 5 times out of 9.

Two of the losses at 6×, times in ms from window creation:

| | loss 1 | loss 2 |
|---|---|---|
| `did-finish-load` | 679 | 702 |
| main sends (timer) | 780 | 803 |
| renderer receives, **0 subscribers** | 793.6 | 810.6 |
| FloatOverHost subscribes | 794.0 | 811.2 |
| toast 4s later | `idle`, no `.fo` | `idle`, no `.fo` |

With the fix, 30 of 30 first toasts rendered under load. That includes
9 launches at 12× that subscribed later than the old 100ms grace. The
reply followed the subscription every time, once per launch.

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

## The other float-over channels

- `floatOverCopyPulse` is cosmetic. Main has already copied the image
  when it sends the pulse, so a pulse nobody hears loses only the flash.
- `floatOverVideoCopyShortcut` is a one-shot action, and main sends it
  whether or not the renderer is listening. The shortcuts are armed at
  `show-loaded`, so a video shortcut pressed during the first toast's
  first render is dropped. Nothing is on screen to act on yet. This
  change leaves that as it was.
- The tray popover has no equivalent held event.
