# `perf-bench` — video-stage playhead A/B harness

Mounts the **real** `VideoStage` (transport + timeline) in headless
Chromium against a fake media clock — no decode, no IPC, no Electron —
and reports the renderer cost of one animation frame of playback.

It exists because the thing being measured (React reconciliation of the
stage subtree at frame rate) is invisible in an app-level CPU profile
once the video decoder is also running, and because React's development
build inflates it ~5×. This isolates it and lets you A/B the same
machine with `git stash`.

Not wired into CI: absolute numbers are machine-specific, only
same-machine deltas mean anything.

**This bench measures JS only.** Once React was off the playhead path
(#446) the remaining playback burn was compositor frame production,
which is invisible here and mostly lands in the GPU process. That half
has its own harness — [`playhead-cpu/`](playhead-cpu/README.md) — which
runs the real Electron binary against a real recording and samples
per-process CPU.

```bash
source ~/.nvm/nvm.sh && nvm use
npx playwright install chromium              # once

npx vite build --config perf-bench/vite.config.ts
node perf-bench/run.mjs --seconds 10 --runs 3 --label after

# ...and against React's development build, which is what `pnpm dev`
# serves and what the in-app hot-CPU profiles capture:
BENCH_REACT=development npx vite build --config perf-bench/vite.config.ts
node perf-bench/run.mjs --seconds 10 --runs 3 --label "after / dev react"
```

Read the **script / style / layout** columns, not `task`: `task` carries
a fixed ~215 µs/frame of harness overhead (frame scheduling, the
mutation counter, the profiler) that is present in both arms.

**Interleave the arms.** Absolute numbers drift 25 %+ with machine load;
ratios do not. Run before → after → before → after in one sitting rather
than comparing a run from an hour ago. The header line reports which
react-dom the bundle was actually built against, so a pasted result can
never be mis-attributed to the wrong arm.

Findings and the numbers this produced:
[docs/solutions/2026-08-20-video-stage-playhead-cpu.md](../../../docs/solutions/2026-08-20-video-stage-playhead-cpu.md)
