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
(adaptive filtering off). It measures bitmap extraction, channel conversion,
synchronous submission and total encoding time, plus output bytes. The
Sharp path includes a full alpha check and rejects nonopaque input rather
than guessing at premultiplied-alpha semantics. A one-pixel color probe
checks channel order. Every output is decoded to sRGB RGBA and compared to
the native output, including dimensions, outside the timed interval.
Pixel mismatch is a failing exit status. This check does not prove equivalent
ICC metadata or correctness for every monitor color space.

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
