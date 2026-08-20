# Hot CPU diagnostics workflow

**Date:** 2026-07-05 (updated 2026-08-20: main-process monitor + per-process attribution)

PwrSnap's Advanced -> Developer page can arm hot CPU diagnostics. One
enable arms two monitors: the Library renderer (profiled over CDP via
`webContents.debugger`) and the Electron main process (profiled
in-process via `node:inspector` — same CDP Profiler domain). When a
monitored process crosses the configured CPU trigger, PwrSnap writes a
session under the app-owned diagnostics root:

```text
~/Library/Application Support/PwrSnap/diagnostics/hot-cpu/<session>
```

Each monitor writes its own session directory in the same format; the
manifest's `target` field (`renderer` | `main`) and the artifact prefix
say which process a session belongs to.

The diagnostics are evidence for analysis, not proof that a previously observed CPU issue is still active. Treat a captured profile as a snapshot of what the process was doing during that run.

## Session contents

Each hot CPU session contains:

- `session.json` - manifest with the session id, creation time, profiled target, artifact list, configuration, and runtime versions.
- `samples.ndjson` - CPU and memory samples taken before a profile starts. Every sample carries a `processes` array: per-process CPU for every Electron process (browser/GPU/renderer/utility), computed from `cumulativeCPUUsage` deltas over wall time. This is how heat shows up in processes that cannot be JS-profiled — during the 2026-08-20 looping-video incident the GPU process was the burner (~56%) and the renderer-only tooling was blind to it. The `electronCpuPercent` field (Electron's instantaneous `percentCPUUsage`) is retained for comparison only; it read ~2.4% while the cumulative-delta `cpuPercent` correctly read ~43% in that same incident, so trust `cpuPercent`.
- `events.ndjson` - monitor lifecycle events such as monitor start, profile start, profile write, heap snapshot write, and capture-limit events.
- `renderer-hot-0001.cpuprofile` / `main-hot-0001.cpuprofile` - Chrome DevTools CPU profile for the hot process (compact JSON, one line).
- `renderer-hot-0001-<phase>.heapsnapshot` / `main-hot-0001-<phase>.heapsnapshot` - optional V8 heap snapshots when smart heap snapshots were enabled.

Open `.cpuprofile` files in Chrome DevTools Performance or a compatible profile viewer. Open `.heapsnapshot` files in Chrome DevTools Memory.

## Per-target tuning

The trigger thresholds are shared between the two monitors by default.
For a main-process-only investigation, the
`PWRSNAP_HOT_CPU_PROFILING_MAIN_THRESHOLD_PERCENT` and
`PWRSNAP_HOT_CPU_PROFILING_MAIN_SLOWBURN_THRESHOLD_PERCENT` env vars
override the trigger thresholds for the main target without touching the
renderer's.

## Capture workflow

1. Open Settings -> Advanced -> Developer.
2. Choose the start delay and trigger mode.
3. Enable smart heap snapshots only when memory state matters; heap snapshots are large and can briefly stall the renderer.
4. Click Start Capture and reproduce the scenario.
5. When the Library banner appears, copy the handoff text or reveal the session folder.
6. Turn heap snapshots back off after the bounded capture if the app has not already auto-disabled them.

The copied handoff text includes exact artifact paths. It should be enough for an agent or human reviewer to inspect the artifacts without hunting logs.

PwrSnap does not automatically delete diagnostics sessions. After the evidence is no longer useful, reveal the diagnostics folder from Settings and remove the session directories intentionally in Finder.

## Packaged-build verification

Development captures usually contain `localhost` source URLs. Packaged builds may show bundled paths or source-map-derived names instead. Before treating diagnostics as release-ready after changes to this area, capture at least one hot CPU profile from built output and verify:

- The `.cpuprofile` parses as valid JSON and opens in DevTools.
- The profile contains enough renderer attribution to identify PwrSnap code paths.
- `session.json`, `samples.ndjson`, and `events.ndjson` match the captured profile.
- Heap snapshots, when enabled, parse as V8 heap snapshots and are bounded by the configured limit.

Do not add source-map or packaging changes until a packaged capture proves the profile is too opaque to troubleshoot.

## Safety boundaries

The in-app diagnostics commands only reveal the app-owned diagnostics root or a validated session directory. PwrSnap does not expose a renderer command that deletes diagnostics artifacts.

Profiling is a developer diagnostic, not normal app maintenance. Keep the controls under Advanced -> Developer and keep heap capture opt-in.
