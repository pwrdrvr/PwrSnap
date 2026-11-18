# Agent rules: Profiling, tracing and React DevTools

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Startup profiling harness — `PWRSNAP_STARTUP_PROFILE=1`

Env-gated, kept wired in production builds. Captures main + renderer
CPU profiles, heap snapshots, and a ms-relative startup-marks timeline
(window-show source, paint lifecycle, per-command timings). Profiling
runs are passive observers: global hotkeys, boot GC, and filename
maintenance are skipped — a profiling instance on a cloned userData
that grabs ⌘⇧C steals real captures into the throwaway clone DB
(capture bundles live in `~/Documents/PwrSnap`, OUTSIDE userData).
Run recipe, findings from the 2026-06 black-window investigation, and
the clone-safety checklist:
[docs/solutions/2026-06-12-library-startup-black-window-profiling.md](../../docs/solutions/2026-06-12-library-startup-black-window-profiling.md).

## Multi-process trace harness — `PWRSNAP_TRACE=1`

Env-gated, off by default, kept wired in production builds — same
posture as the startup profiler above. Records an
`Electron.contentTracing` Chrome trace across the browser, GPU, and
every renderer, because the hot-CPU harness cannot explain a hot **GPU**
process: that process runs no V8, so there is nothing to CPU-profile.
Compositor frame cadence, tile raster, and overlay/CALayer attribution
only exist in a trace.

```bash
PWRSNAP_TRACE=1 node apps/desktop/scripts/dev.mjs   # arms, records nothing
kill -USR2 <main pid>                               # records 15 s (again = stop early)
```

**On Windows there is no SIGUSR2** — libuv never raises it, so the
listener is registered but inert. Use the delayed one-shot instead:
`PWRSNAP_TRACE_AUTOSTART_DELAY_MS=20000`. The armed log line names
whichever trigger actually works on the host.

Sessions land in `<userData>/diagnostics/trace/` laid out like a hot-cpu
session, and `app.getAppMetrics()` is sampled into the same
`events.ndjson` for the trace window — a trace shows what a process DID,
not what it COST.

Two things to know before measuring GPU-process CPU:

- **Close DevTools first.** It composites through the same GPU process
  and its Performance Monitor polls continuously; it inflated one
  measurement by roughly 15 points. Drive the app over
  `--remoteDebuggingPort` + `Runtime.evaluate` instead — CDP with no
  domains enabled composites nothing.
- **`ps`'s `%CPU` is a since-boot average.** Use `ps -o time=` deltas
  over a wall window, the same cumulative-delta method the hot-CPU
  harness uses.

Worked example — the 2026-08 video-playback GPU burn, where a 1 px
playhead was re-rasterizing a tile 120 times a second:
[docs/solutions/2026-08-20-video-playback-gpu-process-burn.md](../../docs/solutions/2026-08-20-video-playback-gpu-process-burn.md).

## React DevTools renderer profiling — `PWRSNAP_REACT_DEVTOOLS=1`

Nothing in the app connects React DevTools on its own. Two opt-in env
vars, both read by
[electron.vite.config.ts](../../apps/desktop/electron.vite.config.ts) at Vite
config time — **not at app runtime** — turn it on:

| Variable | What it does |
|---|---|
| `PWRSNAP_REACT_DEVTOOLS=1` | Injects `<script src="http://localhost:8097">` as the first `<head>` script so the renderer loads the standalone DevTools backend. |
| `PWRSNAP_REACT_DEVTOOLS_HOST` / `_PORT` | Point that script somewhere other than `localhost:8097`. |
| `PWRSNAP_REACT_PROFILING=1` | Aliases `react-dom/client` → `react-dom/profiling`, for `electron-vite build` only. |

Both take the repo's usual flag allowlist (`1`/`true`/`yes`/`on`, the
same one `content-trace-config.ts` and `hot-cpu-profile-config.ts` use).
A "non-empty and not 0" test would read `false`/`off`/`no` as ON and
silently bake the bridge into a build.

With both unset the plugin is never constructed and the alias key is
never added, so a normal build is byte-identical to one from a tree
without this feature — verified by building from both configs and
diffing `out/renderer`.

### Attaching to the dev build

This is the configuration to reach for first, and it needs no build
changes.

```bash
npx react-devtools
```

Then launch this checkout with the bridge enabled. Use a scratch userData
root, never your real profile — `PWRSNAP_E2E=1` **together with**
`PWRSNAP_USER_DATA` is what rebases `documents` into userData, so a
profiling run cannot touch `~/Documents/PwrSnap`:

```bash
S="$(mktemp -d)"                     # scratch profile; purge it afterwards
env HOME="$S" PWRSNAP_USER_DATA="$S" PWRSNAP_E2E=1 PWRSNAP_REACT_DEVTOOLS=1 \
  pnpm --filter @pwrsnap/desktop dev --remoteDebuggingPort=9333
```

Do not paste that `env` line without setting `S` first: with it unset both
variables expand to the empty string, `PWRSNAP_E2E=1` alone does not rebase
`documents`, and the run reads the operator's real library.

`npx react-devtools` must already be listening when the renderer loads —
the script tag is a synchronous classic script, and a refused connection
just means React never registers a renderer with the hook.

**Do not add `react-devtools` to `package.json`.** It depends on
`electron@^23`, which would pull a second Electron runtime into
`node_modules` alongside the one the app actually uses.

### Knowing which instance you attached

Several PwrDrvr Electron apps usually run at once on this machine and the
standalone DevTools window says nothing about which page is on the other
end of its socket. Never drive or restart another session's instance.
Two things resolve it:

- **The bridge is opt-in per process.** An instance started without
  `PWRSNAP_REACT_DEVTOOLS=1` has no script tag and *cannot* connect, so
  starting exactly one bridged instance is itself the isolation.
- **The injected bridge logs its endpoint and the checkout it was built
  from** to the renderer console:
  `[pwrsnap] React DevTools bridge -> http://localhost:8097 (renderer from /…/apps/desktop)`.
  Read it over CDP (`Runtime.evaluate`) or in that window's own Electron
  DevTools to confirm *this* window is the one talking to that port.

To profile two checkouts at once, give each its own port and run one
listener per port:

```bash
npx react-devtools --port 8098
PWRSNAP_REACT_DEVTOOLS=1 PWRSNAP_REACT_DEVTOOLS_PORT=8098 …
```

Every window in the process loads the same renderer bundle, so the tray,
float-over, settings, and region-selector windows carry the bridge too —
and **the standalone server keeps only one connection**, closing the
previous one with "Only one connection allowed at a time". So the window
you are profiling is whichever connected LAST, which is often the region
selector rather than the Library. Confirm the tree in the Components tab
before recording, or close the other windows first.

### Which build to use for what

**Use the dev build to find re-render storms and update loops.** It is
the better tool for that, not a fallback:

- The Profiler's "Record why each component rendered" attribution is
  richer in a development build — it names the changed props and the
  changed hook indices (`Hook 7 changed`). The production profiling build
  drops some of that detail.
- No build step, no packaging, and HMR still works.
- A pathology shows up as a *ratio* — components re-rendered per commit,
  or commits per interaction — and ratios survive the dev build's
  overhead intact.

**Use the profiling build only when an absolute millisecond number has to
be trustworthy.** Development React is much slower than production React
and the overhead is uneven across component shapes, so dev-build
durations rank badly against each other and **must never be quoted as the
cost users pay.** A plain production build is not an option: it reports
"Profiling not supported", because production `react-dom` is compiled
without the timing instrumentation.

```bash
PWRSNAP_REACT_PROFILING=1 PWRSNAP_REACT_DEVTOOLS=1 pnpm --filter @pwrsnap/desktop build
pnpm --filter @pwrsnap/desktop preview
```

Measured cost of the alias on the renderer bundle, `react-dom` 19.2.8:

| | baseline | profiling | delta |
|---|---|---|---|
| `assets/index-*.js` raw | 1,180,744 B | 1,200,986 B | +20,242 B (+1.7%) |
| `assets/index-*.js` gzip | 349,176 B | 355,051 B | +5,875 B (+1.7%) |
| whole `out/renderer` | 2,153,874 B | 2,174,116 B | +20,242 B (+0.9%) |

**Only `react-dom/client` is aliased**, and that is what keeps one
reconciler in the bundle. In React 19 both `react-dom/client` and
`react-dom/profiling` `require("react-dom")` for their shared internals,
so bare `react-dom` (`createPortal`, used in `Library.tsx`,
`Editor.tsx`, `DeleteConfirm.tsx`) and `react-dom/server` keep resolving
normally and cannot produce a second copy. The +20 KB delta is the
instrumentation; a second reconciler would be an order of magnitude more.

Confirm a build really is the profiling one by grepping the chunk for a
Profiler-only fiber field: `treeBaseDuration` appears **21 times** in the
profiling bundle and **0 times** in the baseline.

### The DevTools browser extension does not work here

`electron-devtools-installer` plus the React DevTools MV3 extension is a
dead end on Electron 41, and the half that works makes it look like it
might. Measured on Electron 41.10.7 with React Developer Tools 8.0.0:

- The extension installs and Electron accepts `manifest_version: 3`.
- Its background **service worker runs**.
- Content-script injection works — `__REACT_DEVTOOLS_GLOBAL_HOOK__` is
  installed in the page with the full hook API. The old `chrome.scripting`
  blocker from 2023 is genuinely gone.
- **The extension's `devtools_page` never loads.** No webContents is
  created for it, and no Components or Profiler tab appears, with the
  window shown or hidden.

Backend attaches, frontend does not. Use the standalone route.

### Packaging cannot ship the bridge

`PWRSNAP_REACT_DEVTOOLS` is read at build time, so nothing at app runtime
can undo a renderer HTML that was built with it.
[verify-asar-contents.mjs](../../apps/desktop/scripts/verify-asar-contents.mjs)
fails packaging when any packaged HTML loads a remote script, and
`release.mjs` + `package-win.mjs` run it on every packaging path. The
rule is written against the shape — a remote `<script src>` in a shipped
renderer — not against the flag.

Four things about that gate are deliberate. The two content rules are
pinned by
[packaged-html-rules.test.mjs](../../apps/desktop/scripts/packaged-html-rules.test.mjs),
the two failure modes by
[verify-asar-contents.test.mjs](../../apps/desktop/scripts/verify-asar-contents.test.mjs)
§"packaged renderer HTML":

- **It fails closed on an unreadable entry.** An HTML entry that cannot be
  read is reported, not skipped. This is a check whose whole job is to stop
  something shipping, so "could not look" has to be as loud as "looked and
  found it".
- **It fails closed on an empty scan.** Matching zero files is a failure,
  not a pass. Without that, a renderer that stopped landing under `/out/`
  would leave the check inspecting nothing and printing OK, for every
  release after the one that moved it.
- **It is scoped to `/out/`.** electron-builder ships `out/**` plus the
  auto-included production `node_modules`; a dependency that vendors a
  playground page pointing at a CDN would otherwise fail a release with a
  message about a flag that has nothing to do with it.
- **The pattern requires whitespace before `src`.** `\bsrc` also matches
  `data-src`, an inert lazy-loading placeholder that loads nothing.

PwrSnap has no `rejectDevOnlyEnvVarsInProduction`-style registry in
`src/main`, so there is no runtime warning when an operator exports one
of these and then launches a *packaged* build. Nothing breaks — the
variables are only ever read by the Vite config — but the Profiler simply
never connects, with no explanation. Worth adding if that bites someone.
