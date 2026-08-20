# The detail view's playhead was re-rendering the stage at 60 Hz

**Date:** 2026-08-20

A 2 h screen recording left looping in the Library detail view sat at
~50 % renderer CPU and ~50 % GPU. The grid-tile secondary suspect — a
hidden `<video>` still decoding behind the detail view — was fixed
separately in [#442](https://github.com/pwrdrvr/PwrSnap/pull/442)
(`docs/solutions/2026-08-20-hidden-grid-video-decode.md`). This note
covers the renderer half: the playhead.

## What it was

`VideoStage` drove the playhead through React state:

```ts
const tick = (): void => {
  let t = el.currentTime;
  if (loopRef.current && t >= r.end - 0.005) { el.currentTime = r.start; t = r.start; }
  setCurrentTime(roundTime(t));          // ← every animation frame
  raf = requestAnimationFrame(tick);
};
```

`roundTime` quantizes to **milliseconds**, so at 60 fps essentially
every frame produced a new value, and every new value re-rendered the
whole stage subtree: `VideoStage` → `VideoTransport` (four inline SVGs)
→ `VideoTimeline` (filmstrip, waveform lane, scrims, two handles, and
one tick `<span>` per minute of source — 121 of them for a 2 h clip).
About 180 elements reconciled per frame so a 1 px line could move and a
tenths timecode could tick.

The two consumers do not need anything like that resolution from
React. The line needs a position; the timecode is floored to tenths.

## Measuring it

Two independent measurements agreed.

**1. The captured hot-CPU sessions** (Settings → Advanced → Developer;
see `2026-07-05-hot-cpu-diagnostics-workflow.md`). Six 15 s renderer
profiles taken during the burn, all from a `pnpm dev` window
(`react-dom_client.js?v=…` — Vite's dep-optimizer URL, so React's
development build). Consistent across all six:

| | share of wall |
|---|---|
| `(idle)` | 62–74 % |
| React `performWorkOnRoot` | 11–17 % |
| `(program)` (paint / compositing / decode) | 10–18 % |

and essentially **all** of the React work was this one subtree:

```
VideoTimeline   3.68 %   553.6 ms
VideoTransport  3.59 %   540.4 ms
VideoStage      1.63 %   244.7 ms
tick (the rAF)  0.96 %   144.5 ms
                        ─────────
                        1483 ms of renderWithHooks' 1365 ms + commit
```

**2. An isolated A/B bench** — `apps/desktop/perf-bench`, which mounts
the real `VideoStage` against a fake media clock (no decode, no IPC) in
headless Chromium and reads `Performance.getMetrics` deltas. It renders
the same shape the app does (902 px strip, 121 ticks, 176 elements).
Per animation frame, 3 runs × 10 s each:

| µs / frame | before | after |
|---|---|---|
| **React production build** | | |
| script | 255 | 36 |
| style | 31 | 36 |
| layout | 47 | 9 |
| total main-thread task | 535 | 327 |
| → at 60 fps | **3.2 % of a core** | **2.0 % of a core** |
| **React development build** (what `pnpm dev` runs) | | |
| script | 1308 | 34 |
| style | 23 | 34 |
| layout | 33 | 8 |
| total main-thread task | 1547 | 305 |
| → at 60 fps | **9.3 % of a core** | **1.8 % of a core** |

Two things to read carefully here:

- **The bench's `task` number has a floor of roughly 290 µs/frame**
  that is present in both arms (frame scheduling, the harness's own
  MutationObserver, the profiler). The honest figure is the *delta*, or
  the script + style + layout columns: **333 → 81 µs/frame in
  production, 1364 → 76 µs/frame in development.**
- **Development React is ~5× the cost of production React here**, which
  is why the captured profiles look so much worse than a packaged build
  would. The bench's development arm (1.3 ms of script per frame) lands
  in the same range as the real dev-server profiles (1.9–2.8 ms of
  React work per frame, the extra being `jsxDEV` from the un-transformed
  dev JSX pipeline the bench's build-mode transform skips) — which is
  what makes the bench's production arm believable too.

So: in a packaged build this was worth ~1.2 points of a core, not 50.
It was never going to be the whole 50 % — most of that is decode and
compositing, which a JS profile cannot see. In a dev window it was
worth ~7.5 points, and it accounts for the entire React share of the
captured profiles.

## What it is now

`features/shared/playhead.ts` — a `PlayheadSource` (`get` / `set` /
`subscribe`), created once per stage. The rAF loop `set`s it; the two
leaves that actually draw the head subscribe and write their own DOM
node:

- `VideoTimeline` writes `transform: translateX(…)` on the playhead
  div (`transform`, not `left`, so a 60 Hz value never touches layout —
  visible in the layout column above), plus `aria-valuenow` /
  `aria-valuetext` on the slider, throttled to the tenth-second
  precision the timecode actually renders.
- `VideoTransport` renders the elapsed timecode through
  `TransportTimecode`, which writes `textContent` only when the
  formatted string changes.

React state (`currentTime`) keeps only the **discrete** head — seek,
pause, ended, capture switch — which is all any re-render needs. During
playback the stage does not re-render at all.

## Traps if you touch this

- **`currentTime` lags during playback, by design.** Anything that
  needs the live head must read `playhead.get()`. `VideoTimeline`'s
  drag-start capture (the position Escape restores) does exactly that;
  keying it off the prop would have restored the head to wherever
  playback last seeked.
- **A re-render must not snap the head back.** Something else can
  re-render the timeline mid-playback (a range change, a resize), and
  React will paint the playhead element from the stale `currentTime`.
  A `useLayoutEffect` with **no dependency array** re-places the head
  after every commit, before paint. Pinned by a test.
- **React never clobbers the imperative values.** React only touches
  the DOM for props whose *rendered* value changed, and the imperative
  channel writes properties React does not render (`transform`) or the
  same text node React last wrote. This only holds as long as the
  render path does not also set `transform` / `aria-valuenow` from
  `currentTime` — don't add that back.
- **`will-change: transform` was tried and dropped.** It measured
  slightly *worse* in the bench (95 → 81 µs/frame without it) and costs
  a compositing layer.
- **`useSyncExternalStore` is the wrong tool.** It exists to feed an
  external value back into render, which is the exact cost being
  removed.

## Re-running the bench

```bash
source ~/.nvm/nvm.sh && nvm use
npx playwright install chromium          # once
cd apps/desktop
npx vite build --config perf-bench/vite.config.ts
node perf-bench/run.mjs --seconds 10 --runs 3 --label after
# and against React's development build, to mirror `pnpm dev`:
BENCH_REACT=development npx vite build --config perf-bench/vite.config.ts
node perf-bench/run.mjs --seconds 10 --runs 3 --label "after / dev react"
```

`git stash` the source change and repeat for the other arm. The bench
is not wired into CI — it is a measurement tool, and its absolute
numbers are machine-specific; only same-machine A/B deltas mean
anything.

---

# Act two: the head was still driving the compositor at vsync

**Date:** 2026-08-20 (same day, after #446 landed)

With React off the playhead path, React is **absent** from renderer CPU
profiles during playback. The video kept burning CPU anyway, and the
remaining cost is not JS at all.

## The mechanism

**Any DOM mutation inside a frame makes Chromium produce a compositor
frame at that vsync.** A playhead that moves every `requestAnimation-
Frame` therefore pins frame production at the **display's** rate —
120 Hz on a ProMotion panel — instead of at the rate the video surface
actually updates, which is ~48–57 Hz for these VFR screen recordings.
It does not matter that the mutation is one `transform` on one 1 px
div: the frame gets produced either way.

Raster runs in the **GPU process** under out-of-process rasterization,
so most of the cost lands there. That is why a renderer-only JS profile
— the tool that found act one — cannot see any of this.

## Measuring it

Controlled A/B, repo's own Electron 41.10.3 binary, a real capture,
window forced visible, display confirmed at 120 fps:

| variant | GPU process | renderer |
|---|---|---|
| video alone (native `loop` attr) | 6.0 % | 5.2 % |
| + JS seek loop (loop-in-range) | 7.9 % | 6.2 % |
| + filmstrip image, playhead **frozen** | 8.4 % | 6.2 % |
| + playhead moving every rAF (120 Hz) | **18.1 %** | **14.1 %** |
| + playhead throttled to ~30 Hz | 11.4 % | 9.1 % |

The moving head cost **more than decoding and compositing the video
itself**.

`perf-bench/playhead-cpu` reproduces this on demand (see its README).
Same shape, different machine load — three alternating rounds on a
178 s, ~57 fps capture:

| arm | GPU process | renderer | publish Hz |
|---|---|---|---|
| `frozen` | 5.0 % | 4.1 % | 0 |
| `raf` (before) | 12.3 % | 9.9 % | 120.2 |
| `throttled` (after) | **7.1 %** | **6.0 %** | 25.6 |

≈ 70 % of the head's excess GPU-process CPU and ≈ 67 % of its excess
renderer CPU, recovered.

## What it is now

`VideoStage`'s playback loop runs at **two rates**, and conflating them
is the bug:

- The **wrap check** (loop-in-range) still runs every animation frame.
  It has to — being a frame late on the out-point is visible — and it
  costs nothing at the compositor, because setting `el.currentTime`
  mutates the media pipeline, not the DOM.
- The **publish** is capped at `PLAYHEAD_MIN_PUBLISH_MS` (33 ms). A 1 px
  line and a tenths-of-a-second timecode gain nothing above ~30 Hz.

Where `requestVideoFrameCallback` is available it drives the publish
instead of rAF. That is the cleanest form of the fix: rVFC fires once
per **decoded** frame, so it self-limits to the media's own rate, and
publishing from inside that callback coalesces the DOM mutation into a
compositor frame the video update was going to force anyway.

## Traps if you touch this

- **Latch rVFC on its FIRST CALLBACK, not on feature detection.**
  `requestVideoFrameCallback` exists on every Chromium
  `HTMLVideoElement` but only *fires* when frames are being presented.
  Detecting the method and handing it the job stalls the head wherever
  it does not fire — jsdom, a suspended surface, an element with no
  decodable frames. The rAF loop publishes at the 30 Hz cap until rVFC
  proves itself, so the latch can only ever *lower* the rate.
- **VFR needs a floor.** These are screen recordings: a stretch where
  nothing on screen moved can go a long time between decoded frames
  while the clock keeps running. `PLAYHEAD_MAX_GAP_MS` (100 ms — the
  tenths resolution the timecode renders at) lets the rAF loop cover
  the gap once rVFC is driving.
- **Discrete positions must never be swallowed by the throttle.** The
  loop wrap force-publishes; seek / scrub / pause / capture-switch go
  through `publishTime`, off the throttled path entirely. A head that
  lags a scrub by 33 ms reads as broken in a way a head that lags
  playback by 33 ms does not.
- **`meta.mediaTime` needs a sanity check against `el.currentTime`.**
  It is the truer head — the presentation time of the frame actually on
  screen — but a frame decoded just before a loop wrap can arrive
  *after* the wrap put the head back at the in-point, and publishing it
  flicks the head to the far end for an interval.

## Ruled out by measurement — do not retry these

- **`will-change: transform` / `translateZ(0)` layer promotion** on the
  playhead and/or the strip: 19.3 % vs 18.1 %, i.e. nothing. (Act one
  measured it slightly *worse* in the JS bench, too.)
- **The rounded border + `overflow: hidden` on `.psl__video-frame`**:
  no measurable CPU effect. It can be dropped on styling grounds — it
  was never a requirement — but not for CPU.
- **wavesurfer**: built with `interact: false`, `cursorWidth: 0`,
  blob-loaded, and never bound to the media element. It is static
  during playback and does not redraw.
