# Hot CPU diagnostics workflow

**Date:** 2026-07-05

PwrSnap's Advanced -> Developer page can arm hot renderer CPU diagnostics for the Library renderer. When the renderer crosses the configured CPU trigger, PwrSnap writes a session under the app-owned diagnostics root:

```text
~/Library/Application Support/PwrSnap/diagnostics/hot-cpu/<session>
```

The diagnostics are evidence for analysis, not proof that a previously observed CPU issue is still active. Treat a captured profile as a snapshot of what the renderer was doing during that run.

## Session contents

Each hot CPU session contains:

- `session.json` - manifest with the session id, creation time, artifact list, configuration, and runtime versions.
- `samples.ndjson` - CPU and memory samples taken before a profile starts.
- `events.ndjson` - monitor lifecycle events such as monitor start, profile start, profile write, heap snapshot write, and cleanup/limit events.
- `renderer-hot-0001.cpuprofile` - Chrome DevTools CPU profile for the hot window.
- `renderer-hot-0001-<phase>.heapsnapshot` - optional V8 heap snapshots when smart heap snapshots were enabled.

Open `.cpuprofile` files in Chrome DevTools Performance or a compatible profile viewer. Open `.heapsnapshot` files in Chrome DevTools Memory.

## Capture workflow

1. Open Settings -> Advanced -> Developer.
2. Choose the start delay and trigger mode.
3. Enable smart heap snapshots only when memory state matters; heap snapshots are large and can briefly stall the renderer.
4. Click Start Capture and reproduce the scenario.
5. When the Library banner appears, copy the handoff text or reveal the session folder.
6. Turn heap snapshots back off after the bounded capture if the app has not already auto-disabled them.

The copied handoff text includes exact artifact paths. It should be enough for an agent or human reviewer to inspect the artifacts without hunting logs.

## Packaged-build verification

Development captures usually contain `localhost` source URLs. Packaged builds may show bundled paths or source-map-derived names instead. Before treating diagnostics as release-ready after changes to this area, capture at least one hot CPU profile from built output and verify:

- The `.cpuprofile` parses as valid JSON and opens in DevTools.
- The profile contains enough renderer attribution to identify PwrSnap code paths.
- `session.json`, `samples.ndjson`, and `events.ndjson` match the captured profile.
- Heap snapshots, when enabled, parse as V8 heap snapshots and are bounded by the configured limit.

Do not add source-map or packaging changes until a packaged capture proves the profile is too opaque to troubleshoot.

## Safety boundaries

Diagnostics cleanup must target only `diagnostics/hot-cpu` session directories. It must never delete captures, settings, secrets, render cache entries, SQLite files, or files under `~/Documents/PwrSnap`.

Profiling and cleanup are developer diagnostics, not normal app maintenance. Keep the controls under Advanced -> Developer and keep heap capture opt-in.
