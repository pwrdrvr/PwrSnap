# Windows hotkey capture: PNG encoding dominates the warm path

This records the diagnosis from five real Windows hotkey invocations and
the encoder probe used to evaluate the next optimization. Production capture
encoding is unchanged; the associated fix closes a bundle directory handle
even when directory `fsync` fails.

## Evidence

The reported checkout matched `2eed3e66` (main at investigation time). A slow
Windows VM captured one image and cancelled four subsequent selectors. All
frames requested 2992 × 1876 physical pixels.

| Stage (ms) | First invocation | Four warm invocations |
|---|---:|---:|
| Trigger → presentation acknowledgement | 1269 | 661–901 |
| Screen acquisition, including PNG and file write | 707 | 456–617 |
| NativeImage PNG encoding | 433 | 296–415 |
| desktopCapturer.getSources | 261 | 148–195 |
| Temp PNG write | 6 | 3–8 |
| Native window enumeration | 207 | 66–102 |
| Show calls → two-frame renderer acknowledgement | 206 | 38–125 |

These are nested and overlapping intervals, not additive categories.
PNG encoding alone is 41–46% of warm trigger-to-acknowledgement time.
`thumbnail.toPNG()` is synchronous main-process work. Window enumeration
overlaps frame acquisition; its whole duration is not an additional saving.
Hotkey dispatch, storage readiness and the already-prewarmed selector take
only a few milliseconds. The 750 ms debounce does not delay the accepted
leading edge. The 15-second startup prewarm is a separate startup concern.
Trace log lines are buffered until presentation, so use their recorded stage
durations, not the timestamps at which the logger prints them.

After the completed selection, persistence logged success about 576 ms
later. Composite outputs appeared roughly 2.8–4.5 seconds after persistence.
Those logs do not isolate queueing, rendering, encoding or actual float-over
paint, so they identify another measurement target without proving which
render operation is the bottleneck. Cancelled selectors never take that path.

The file-handle GC warning has a concrete candidate in `atomicWriteBundle`:
the directory handle was closed only after a successful `sync()`. A failed
directory sync skipped close. Closing in `finally` fixes that leak while
preserving best-effort directory durability and the required file-body sync.
A regression test injects a failed directory sync and verifies close and the
successfully persisted bytes. The warning alone cannot identify its handle.

## Repeatable encoder probe

From the repository root, on the machine to measure:

```text
pnpm --filter @pwrsnap/desktop exec electron scripts/benchmark-screen-png.cjs --iterations 10
```

Optional `--input "path/to/existing-opaque-screenshot.png"` uses an existing
local image. No screenshot is taken, no BrowserWindow is opened, no PwrSnap
startup runs, and no app state or capture directory is accessed automatically.
Only environment metadata and measurements are printed, with no input path
or image contents. Synthetic UI, gradient and noise fixtures are the default.
Use the normal workspace Electron environment (unset `ELECTRON_RUN_AS_NODE`
if it was set in the shell).

Each variant gets one warmup, then the order rotates between iterations.
Each sample creates a fresh bitmap-backed NativeImage **before** timing.
Using `createFromBuffer(png).toPNG()` instead can return cached PNG bytes,
making the benchmark report microseconds without doing any encoding.

The probe compares native PNG with Sharp PNG compression levels 0, 1 and 6
(adaptive filtering off), plus opaque RGB levels 1/6 with filtering off/on.
RGB variants remove the verified-opaque alpha channel in Sharp's timed async
pipeline. It measures bitmap extraction, channel conversion,
synchronous submission and total encoding time, plus output bytes. The
Sharp path includes a full alpha check and rejects nonopaque input rather
than guessing at premultiplied-alpha semantics. A one-pixel color probe
checks channel order. Every output is decoded to sRGB RGBA and compared to
the native output, including dimensions, outside the timed interval.
Pixel mismatch is a failing exit status. This check does not prove equivalent
ICC metadata or correctness for every monitor color space.

Output defaults to one summary per fixture/encoder (24 rows), with median
timings rounded to two decimal places. Add `--samples` for individual sample
rows as well. Timing calculations retain full precision internally.

API references: [Electron NativeImage](https://www.electronjs.org/docs/latest/api/native-image)
and [Sharp PNG options](https://sharp.pixelplumbing.com/api-output/#png).
Use the logged Electron version when interpreting results; bitmap color
semantics can change across releases.

## Local validation, not a Windows speedup claim

macOS arm64, Electron 41.10.7, Sharp 0.35.4/libvips 8.18.6, five measured
iterations per variant, 2992 × 1876 pixels. All 60 measured outputs matched
the reference pixels. Median total milliseconds:

| Fixture | Native | Sharp 0 | Sharp 1 | Sharp 6 |
|---|---:|---:|---:|---:|
| Synthetic UI | 59.24 | 23.15 | 16.90 | 18.78 |
| Gradient | 58.90 | 20.29 | 23.46 | 20.94 |
| Noise | 274.59 | 19.89 | 156.66 | 268.58 |

Sharp synchronous extraction/check/conversion/submission took medians of
8.6–12.2 ms across these cases. This is not a full event-loop-stall profile.
Output-size tradeoffs are substantial: UI was 23,119 bytes native versus
412,627 at Sharp 1; gradient was 21,314 versus 2,270,417. Sharp 0 was about
22.5 MB for every fixture. Faster encoding alone does not establish faster
selector presentation: extra disk/stream/decode work can erase the benefit.

Run the same probe on the affected Windows machine, ideally with a locally
retained representative opaque screenshot. Before adopting a replacement,
measure end-to-end hotkey latency, output-size effects, color fidelity and
main-process responsiveness. Candidate tuning can also compare opaque RGB
output and adaptive filtering. Preserve full-resolution lossless source
pixels; changing JPEG quality or downscaling is not an equivalent fix.

## Windows follow-up: the encoder gain reproduces

The operator ran the original four-variant probe on Windows x64, Electron
41.10.7, Sharp 0.35.4/libvips 8.18.6. Ten measured iterations per variant,
2992 × 1876 pixels, BGRA bitmap layout; all 120 samples reported identical
decoded pixels. Median total milliseconds:

| Fixture | Native | Sharp 0 | Sharp 1 | Sharp 6 |
|---|---:|---:|---:|---:|
| Synthetic UI | 215.92 | 67.15 | 46.74 | 49.39 |
| Gradient | 213.40 | 60.55 | 57.34 | 57.36 |
| Noise | 789.29 | 61.38 | 299.08 | 636.53 |

Sharp 1 is 4.6× faster for UI, 3.7× for gradient and 2.6× for noise at
encoding alone. Most Sharp samples spend about 23–30 ms synchronously,
including approximately 5 ms bitmap extraction and 18–21 ms alpha
checking/channel conversion. Native blocks the main thread for essentially
the whole encoder interval. The gain is thus both lower encoder latency
and a much shorter main-thread stall; the original GDI fetch is not the
only important cost.

The sizes match the Mac results. Sharp 6 deserves comparison with Sharp 1:
UI takes only 2.65 ms longer but produces 135,151 instead of 412,627 bytes;
gradient latency is effectively tied while output shrinks from 2,270,417
to 392,452 bytes. Noise reverses the compression-time tradeoff. Sharp 0
spends 22.5 MB on even a flat desktop, so its noise result does not make
it a good universal default.

The probe now includes opaque RGB and adaptive-filtering variants to
test whether the size penalty can be reduced while retaining the speedup.
Keep the original variants as controls. These are still synthetic encoder
measurements, not a real hotkey or protocol-decode benchmark, and no
production encoder is selected yet.

The expanded probe passed locally on the same Mac/Electron combination,
five measured iterations per variant, all 120 pixel comparisons equal.
RGB without adaptive filtering is promising: level 6 produced UI in
15.60 ms / 96,334 bytes, gradient in 16.26 ms / 259,561 bytes, and noise
in 190.85 ms / 16,870,748 bytes. RGB level 1 produced UI in 14.07 ms /
259,974 bytes and noise in 121.50 ms / 17,785,478 bytes. Adaptive RGB
level 6 brought UI/gradient sizes near native (24,821 / 21,911 bytes),
but cost 54.21 / 53.27 ms compared with the same run's native 59.29 /
58.64 ms. This makes filtering a measured CPU/size tradeoff, not a free
improvement. Repeat these variants on Windows before selecting settings.

## Expanded Windows results: prefer RGB level 1 for the next hotkey trial

The operator repeated the expanded probe on Windows x64 with the same
Electron/Sharp versions, ten samples for each of eight encoders and three
fixtures. All 240 measured pixel comparisons passed. Compare variants
within this run; the native baseline was slightly faster than in the first
Windows run.

| Fixture | Native total / sync ms | RGB 1 total / sync ms | RGB 6 total / sync ms |
|---|---:|---:|---:|
| Synthetic UI | 203.90 / 203.90 | 42.79 / 23.62 | 44.49 / 23.89 |
| Gradient | 204.78 / 204.78 | 45.00 / 23.83 | 44.73 / 24.13 |
| Noise | 749.45 / 749.45 | 221.93 / 22.97 | 422.18 / 23.25 |

RGB level 1 with adaptive filtering off is the preferred candidate for
the latency-sensitive frozen snapshot. It reduces encoder time by about
79% for UI, 78% for gradient and 70% for noise, and main-thread synchronous
work by about 88%, 88% and 97% respectively. Compared with RGB level 6,
it gives up little or no time on UI/gradient and saves 200.25 ms on noise.
Its noise PNG is only about 5% larger than native. The price is larger
simple-screen files:

| Fixture | Native bytes | RGB 1 bytes | RGB 6 bytes |
|---|---:|---:|---:|
| Synthetic UI | 23,119 | 259,974 | 96,334 |
| Gradient | 21,314 | 1,075,038 | 259,561 |
| Noise | 16,892,933 | 17,785,478 | 16,870,748 |

Adaptive filtering costs about 85–88 ms extra on UI/gradient. Although RGB
level 6 with filtering approaches native file sizes, its 130 ms encoder
latency is a poor tradeoff for the immediate selector compared with 43–45
ms without filtering. Level 0 remains an unsuitable universal choice due
to its 22.5 MB output even for the synthetic UI.

These results justify moving to a real-capture A/B trial with RGB level 1,
not another synthetic compression sweep. Preserve the native fallback for
unsupported bitmap/color/alpha cases, keep full-resolution lossless pixels,
and measure the existing hotkey-to-presentation stages to include file I/O,
protocol delivery and decode. Approximately 18 ms of the remaining 23 ms
sync cost is the bitmap alpha-check/channel-swap loop, a secondary target
after end-to-end validation. The benchmark itself still does not change
production capture behavior or prove fidelity for arbitrary display color
spaces; the current PR remains diagnostic apart from directory-handle cleanup.
