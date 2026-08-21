# `playhead-cpu` — compositor-CPU A/B for the video playhead

The sibling `perf-bench` measures **JS**: React reconciliation on the
playhead path, which [#446](https://github.com/pwrdrvr/PwrSnap/pull/446)
removed. This one measures what was left after that, which is not JS at
all — **compositor frame production**.

Any DOM mutation inside a frame makes Chromium produce a compositor
frame at that vsync. So a playhead that moves every `requestAnimation-
Frame` pins frame production at the **display's** rate (120 Hz on a
ProMotion panel) rather than at the rate the video itself decodes
(~48–57 Hz for these VFR screen recordings). Raster runs in the **GPU
process** under out-of-process rasterization, so most of the cost lands
there and a renderer-only JS profile cannot see any of it.

The harness runs the repo's own Electron binary with a visible,
always-on-top window playing a **real capture**, renders the same DOM
the stage does (video in a rounded frame, filmstrip lane, 1 px playhead
div, tenths timecode, slider aria attributes), and alternates three
arms:

| arm | what it does |
|---|---|
| `frozen` | everything mounted and decoding, head never moves — the floor |
| `raf` | publish every animation frame — what shipped before #448 |
| `throttled` | `requestVideoFrameCallback`-driven, ~30 Hz cap, 100 ms floor — #448 |

CPU comes from the kernel's cumulative CPU time per pid (`ps -o
cputime=`), sampled across the interval, so one core = 100 % and the
numbers line up with Activity Monitor. Electron's own
`percentCPUUsage` is deliberately **not** used for the headline
figures: measured against `ps`, it reads about an order of magnitude
low (it normalizes across cores). It gets the A/B ratio right, not the
scale.

```bash
ffmpeg -i ~/Documents/PwrSnap/<some-capture>.mp4 \
  -vf "fps=1/6,scale=-1:112,tile=30x1" -frames:v 1 /tmp/strip.png

../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  main.cjs --video ~/Documents/PwrSnap/<some-capture>.mp4 \
          --film /tmp/strip.png --seconds 16 --rounds 3
```

Not wired into CI — it needs a real recording, a visible window, and a
machine nobody is using. Absolute numbers are machine-specific; only
same-machine deltas mean anything, which is why the arms alternate
within one process rather than running as separate invocations.

Findings:
[docs/solutions/2026-08-20-video-stage-playhead-cpu.md](../../../../docs/solutions/2026-08-20-video-stage-playhead-cpu.md)
