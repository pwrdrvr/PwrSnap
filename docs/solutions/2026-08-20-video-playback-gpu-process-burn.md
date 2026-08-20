# Video playback burned the GPU process; a 1 px playhead was the reason

**Date:** 2026-08-20
**Symptom:** playing a video in the Library focus view pinned an
"Electron Helper" row near 47% in Activity Monitor.
**Resolution:** the row is the GPU process. With DevTools closed it is
~32%, all of it caused by the timeline playhead forcing a full tile
re-raster on every display frame. Two fixes take it to ~20%.

## What was already known going in

- The **main process is not hot** — 1.5% mean / 6.9% max, from the
  per-process sidecar added in #443.
- The **renderer is ~25%**, only ~10% of it on the main thread; React is
  entirely gone from the profile after #446.
- The display is **120 Hz ProMotion**, and DevTools' Performance Monitor
  showed 239.8 style recalcs/sec — exactly two per frame.
- A controlled A/B replica reached only ~18% and could not account for
  the rest, which is what motivated tracing the real app.

Ruled out by measurement before this investigation: layer promotion (in
the replica), the video frame's rounded border + `overflow: hidden`,
wavesurfer, backdrop-filter, and the quick-capture breathe animation.

## The harness

`PWRSNAP_TRACE=1` arms an `Electron.contentTracing` recorder
([content-trace-recorder.ts](../../apps/desktop/src/main/diagnostics/content-trace-recorder.ts)).
It exists because the hot-CPU harness cannot explain a hot **GPU**
process: that process runs no V8, so there is nothing to CPU-profile.

```bash
PWRSNAP_TRACE=1 node apps/desktop/scripts/dev.mjs   # arms, records nothing
kill -USR2 <main pid>                               # records 15 s
```

Output lands in `<userData>/diagnostics/trace/trace-<stamp>-<id>/`, laid
out like a hot-cpu session (`session.json` manifest, `events.ndjson`).
`app.getAppMetrics()` is sampled into the events log for the same window
— a trace shows what the GPU process DID, not what it COST, and cost was
the question.

## The control that had to come first

The original 47% observation was made **with DevTools open**. DevTools
renders through the same GPU process and its Performance Monitor polls
continuously, so the first job was re-measuring without it.

With DevTools closed, no tracing, a 178 s clip playing in focus view:

| state | GPU process | renderer |
|---|---|---|
| video **playing** | 31.4% | 15.4% |
| video **paused** (same view, same layout) | **0.0%** | 0.1% |

Two things follow. The burn is real and not a DevTools artifact — but it
is also *entirely* playback-driven, with no idle or static component.
(Tracing itself is nearly free: 31.9% while recording vs 31.4% not.)

Subtracting, roughly 15 of the original 47 points were DevTools' own
compositing plus its polling. That is arithmetic against the reported
number, not a measurement of DevTools.

## What the trace showed

Everything in the frame pipeline ran at **118.6/sec** — the full 120 Hz
display rate — while the video itself decoded only ~56 frames/sec:

```
Display::DrawAndSwap                    118.7/s
RasterTask                              118.6/s   <- one full tile raster per frame
LocalFrameView::RunPaintLifecyclePhase  118.6/s
ProxyImpl::Commit                       118.6/s
MojoVideoDecoderService::OnDecoderOutput 55.7/s   <- the actual video
```

The `RasterTask` args named the culprit shape: `layerId: 5`, one
`HIGH_RESOLUTION` tile, a **new `sourceFrameNumber` every frame**. Some
layer's content was changing 120 times a second.

Not the video. The video was already doing the right thing — `num_overlays: 1`
every frame, `OverlayProcessorMac::ProcessForOverlays`,
`CARendererLayerTree::CommitScheduledCALayers`,
`ImageTransportSurfaceOverlayMac::Present`. **The video rides a CALayer /
IOSurface overlay plane and is never composited by hand.** No fix needed
there, and none available.

GPU-main self time, as a share of wall clock:

| | |
|---|---|
| `IOSurfaceImageBacking::WaitForCommandsToBeScheduled` | 5.9% |
| `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush` | 4.4% |
| `RasterDecoderImpl::DoRasterCHROMIUM::Deserializing` | 3.5% |
| `SkiaOutputSurfaceImplOnGpu::SwapBuffers` | 2.0% |

Raster round trips and Metal backpressure, not drawing.

## Bisecting it in the live app

CSS overrides injected over CDP into the running app, 12 s per state:

| state | GPU | renderer |
|---|---|---|
| baseline (playing) | 31.8% | 15.4% |
| `.vtl__playhead { visibility: hidden }` | 18.7% | 12.9% |
| `.vtl__playhead { will-change: transform }` | 22.3% | 12.8% |
| whole timeline `display: none` | 16.0% | 6.1% |
| `video { visibility: hidden }` (timeline still live) | 19.4% | 12.7% |
| both hidden | 6.4% | 6.1% |

**The 1-pixel playhead was ~13 of the ~32 points**, and simply promoting
it to its own layer recovered ~9.5 of them.

## Why a 1 px line cost that much

`placePlayhead` already used `transform` rather than `left`, on the
reasonable theory that a transform is compositor-only. It is not — *not
on an unpromoted element*. Without a compositing reason, the transform
lives in the containing layer's paint, so cc re-rasterized the whole tile
each time it moved.

And the cost is not fill rate. The damage is about 2×78 px. The cost is
the fixed per-raster round trip: paint-op serialize → IPC → GPU
deserialize → Metal flush → IOSurface backpressure. That is why shrinking
the damage rect does nothing and promotion does everything.

The replica had tested `will-change` and measured no effect. In the real
app it is worth 9.5 points. Worth remembering when a replica disagrees
with production.

## The second, independent problem

Promoting the playhead removed the raster but **not** the swaps:

| | baseline | promoted only | timeline hidden |
|---|---|---|---|
| `RasterTask` | 118.6/s | 9.9/s | 10.0/s |
| `ProxyImpl::Commit` | 118.7/s | **118.7/s** | 10.0/s |
| `Display::DrawAndSwap` | 118.7/s | **118.7/s** | 61.7/s |

Writing `style.transform` every rAF tick forces a compositor commit,
draw, and swap even when the layer only moves. And it was moving almost
nowhere: a 178 s clip across a 1044 px strip advances **5.9 px/sec**, so
at 120 Hz the head crosses a device pixel about every tenth frame. The
other ~110 writes a second re-presented an identical picture.

So the head is now quantized to device pixels and the write is skipped
when the quantized position is unchanged. Not a throttle — it writes on
every frame that renders differently and never on one that doesn't.

## The fixes

1. **`will-change: transform` on `.vtl__playhead`**
   ([video-timeline.css](../../apps/desktop/src/renderer/src/styles/video-timeline.css))
   — removes the per-frame raster.
2. **Device-pixel quantization + skip-if-unchanged in `placePlayhead`**
   ([VideoTimeline.tsx](../../apps/desktop/src/renderer/src/features/shared/VideoTimeline.tsx))
   — removes the per-frame commit and swap.

Neither subsumes the other; one kills raster, the other kills swap.

Measured (178 s clip, focus view, DevTools closed):

| | GPU | renderer | total |
|---|---|---|---|
| before | 31.8% | 15.4% | 47.2% |
| after | **20.3%** | **7.9%** | **28.2%** |

Frame pipeline after the fix, against the floor measured with the
timeline removed entirely:

| | before | after | floor |
|---|---|---|---|
| `RasterTask` | 118.6/s | 9.9/s | 10.0/s |
| `ProxyImpl::Commit` | 118.7/s | 20.4/s | 10.0/s |
| `Display::DrawAndSwap` | 118.7/s | 67.0/s | 61.7/s |
| GPU-main instrumented busy | 19.9% | 11.0% | 5.8% |

The removed GPU-main self time is exactly the raster path:
`DoEndRasterCHROMIUM::Flush` 4.35% → 0.61%,
`DoRasterCHROMIUM::Deserializing` 3.47% → 0.45%,
`IOSurfaceImageBacking::WaitForCommandsToBeScheduled` 5.92% → 2.96%.

### Clip length changes the mix

On a **short** clip the head moves ~20× faster, so it genuinely crosses a
device pixel almost every frame and the dedupe rarely fires. Promotion
still pays:

| 8.4 s clip | GPU | renderer |
|---|---|---|
| promotion defeated (`will-change: auto`) | 32.2% | 14.5% |
| both fixes | 26.5% | 14.5% |

The renderer is flat there because its cost is the rAF loop's style and
paint lifecycle, which neither fix touches.

## What is left, and what would take it

After both fixes, `LocalFrameView::RunPaintLifecyclePhase`,
`ProxyMain::BeginMainFrame`, and `VideoFrameSubmitter::OnBeginFrame` all
still run at ~118/sec. That is the playhead rAF loop keeping the
main-thread frame lifecycle alive at display refresh, and it is what the
separate playhead-throttling work targets. It is the only remaining lever
for short clips, where the dedupe cannot fire.

Everything below that is the irreducible cost of presenting a video: ~62
swaps/sec of an overlay plane, which is the video's own frame rate.

## Reproducing any of this

```bash
PWRSNAP_TRACE=1 node apps/desktop/scripts/dev.mjs --remoteDebuggingPort 9222
```

Drive the app over CDP on 9222 rather than opening DevTools — attaching a
CDP client and calling `Runtime.evaluate` enables no domains and does not
composite anything, so it does not perturb the measurement the way the
DevTools frontend does. `kill -USR2 <main pid>` to record.

Per-process CPU is in the session's `events.ndjson` (`cpu-sample` rows),
or read it straight from `ps -o time=` deltas against the GPU pid — same
cumulative-delta method the hot-CPU harness uses, and immune to `ps`'s
since-boot `%CPU` average.
