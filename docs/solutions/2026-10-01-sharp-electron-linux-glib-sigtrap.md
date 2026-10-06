# `editor-crop-clip` "lost its open": main was killed by sharp's glib clash

**Symptom.** `apps/desktop/e2e/editor-crop-clip.spec.ts` failed PRs that
never touched it, on the Linux Desktop E2E job, on the first attempt and
on the retry (pwrdrvr/PwrSnap#678). A different test in the file failed
each time. The CI shape matched the lost-intent flake fixed on 2026-09-26
([2026-09-26-library-open-capture-lost-intent.md](2026-09-26-library-open-capture-lost-intent.md)):
`editor:open` returned `ok`, `.psl__focus` never became visible within 15s,
and teardown logged
`[e2e-teardown] graceful close failed (close=timeout, exited=false)`.

That resemblance was the trap. The intent was not lost. The main process
was dead, or dying, before the Library could act on it.

## What the harness showed once it kept the evidence

`scripts/e2e/run-docker.sh --iterations` prints only the last three lines
of a failing run. A copy that kept full Playwright output per iteration,
plus a fixture hook that recorded each Electron child's stdout, stderr and
`exit` (code, signal, and whether `close()` had been requested), gave:

| | |
|---|---|
| main @ e228d737, 8 iterations | 4/8 (as reported) |
| main @ 78bec9ad, 20 iterations | 12/20 |
| Electron launches in a 6-iteration run | 30 |
| launches that died on their own | 4, all `signal=SIGTRAP closeRequested=false` |

The SIGTRAP landed at different points: during `insertVector`, during the
`editor:open` dispatch (`Target page, context or browser has been closed`),
and once after a test had passed, so `close()` found no process
(`Cannot read properties of undefined (reading '_object')`). Every death
came 300–500ms after launch, during the first sharp work. It came in the
middle of a burst of:

```
GLib-GObject: g_object_ref: assertion 'G_IS_OBJECT (object)' failed
GLib-GObject: g_object_unref: assertion 'G_IS_OBJECT (object)' failed
```

interleaved with `compose-tree` render lines. The same burst was in EVERY
launch, healthy ones included (hundreds of lines each). That is why it had
been read as harmless xvfb noise. One more line was there every time:
`[SharpElectronLinux] Warning: Binaries provided by Electron for use on
Linux may be incompatible with sharp`.

Run alone, the line-433 test had passed 5/5. That was sample size: with
~10% per-test failure, 5 clean runs happen about 60% of the time. Order
did not matter. Every test launches its own Electron with its own HOME.

## Root cause

Measured in the E2E container (sharp 0.35.4, sharp-libvips 1.3.3,
Electron 41.10.7):

- `electron` has `libglib-2.0.so.0`, `libgobject-2.0.so.0` and
  `libgio-2.0.so.0` as DT_NEEDED.
- `libvips-cpp.so.8.18.6` statically links glib: 1797 exported `g_*`
  symbols, internal calls bound to its own copy.
- `sharp-linux-<arch>-0.35.4.node` imports seven glib symbols
  (`g_object_ref`, `g_object_unref`, `g_signal_connect_data`, `g_malloc`,
  `g_free`, `g_log_set_handler`, `g_utf8_validate`). It expects them to
  resolve to libvips-cpp.

Inside Electron the global scope (the executable, then its DT_NEEDED) is
searched first, so those imports bind to the system glib. The system
GType registry does not know libvips' types, so each ref/unref fails its
`G_IS_OBJECT` check and does nothing. sharp's C++ wrappers end up holding
no references. libvips frees images sharp is still using, and main crashes.
sharp documents this (install docs, §"Electron and Linux"). Upstream is
[electron/electron#46323](https://github.com/electron/electron/issues/46323),
still open, with no fix in sharp as of 0.35.5.

A 40-line Electron main that only runs sharp (create → SVG composite →
resize → webp → raw, four at a time, 200 rounds) reproduces it with no
PwrSnap code at all: **exit 133 (SIGTRAP), 3 of 3 runs**.

## What did not work

- **`RTLD_DEEPBIND`** on the addon (pre-`process.dlopen` with the flag,
  then a normal `require`): the GLib assertions disappear, and the probe
  segfaults, **exit 139, 3 of 3**. Deep binding also changes how the
  addon's other imports resolve, and the electron executable defines
  `free`, `operator new` (`_Znwm`, `_Znam`) and `operator delete`
  (`_ZdlPvm`, `_ZdaPv`): Chromium's allocator shim. Deep-bound, the addon
  frees shim-allocated memory with glibc's `free`.
- **A separate process.** A `utilityProcess` or an `ELECTRON_RUN_AS_NODE`
  child is still the electron executable, so the system glib is loaded
  there as well. A real Node binary is not available in a packaged build
  (the runAsNode fuse is off).

## The fix

sharp's WebAssembly build (`@img/sharp-wasm32`) runs libvips, glib
included, inside the wasm module, so there is no symbol to clash on. The
same probe forced onto wasm: **3/3 clean, zero GLib lines**. User decision
2026-10-01: take it on Linux, where PwrSnap is not distributed.

1. [sharp-wasm-steer.ts](../../apps/desktop/src/main/sharp-wasm-steer.ts)
   registers a `module.registerHooks` resolve hook, in Electron on Linux
   only. The hook answers sharp's `@img/sharp-linux*/sharp.node` request
   with `MODULE_NOT_FOUND`, which is what sharp's loader expects from an
   absent platform package, so it falls through to `@img/sharp-wasm32`.
   If the wasm package is not installed, the steer leaves native alone
   rather than make `import sharp` throw at startup, and the boot log says
   so.
2. The steer is a separate rollup input, imported first by `index.ts` and
   by both worker entries. The output is ESM, so a module inlined into an
   entry chunk would be evaluated after the hoisted `import sharp`.
   Measured: the built `index.js` imports five `node:` built-ins, then
   `./sharp-wasm-steer.js`, then every chunk that imports sharp.
3. `.pnpmfile.cjs` makes the package installable:
   - It adds `@img/sharp-wasm32` to sharp's optional dependencies at sharp's
     own version. sharp does not depend on it, and pnpm's isolated layout
     hides a sibling from sharp's loader.
   - It gates the package to `os: linux`. Its manifest has no platform
     fields, so it would otherwise install on the macOS and Windows hosts
     that stage release builds.
   - It drops the edge from `@img/sharp-freebsd-wasm32` and
     `@img/sharp-webcontainers-wasm32`. On pnpm 10.33 a Linux install
     listed `@img/sharp-wasm32` under `skipped`, with no platform reason of
     its own: pnpm reached it through the two platform-skipped wrappers
     first and never revisited it.

## Results

All runs: `scripts/e2e/run-docker.sh --test 'editor-crop-clip'`, retries
off, five Electron launches per iteration, arm64 Docker on Apple silicon.

| build | iterations | result | launch exits |
|---|---|---|---|
| main @ 78bec9ad | 20 | 12/20 | — |
| main + exit capture | 6 | 2/6 | 26 clean, 4 SIGTRAP |
| steer built, wasm package not installed (native, as main) | 20 | 7/20 | 78 clean, 22 SIGTRAP |
| fix + exit capture | 20 | **20/20** | **100 clean**, 0 GLib lines, 0 `SharpElectronLinux` |

The full GHA-style Linux suite with the fix (`run-docker.sh`, no
`--test`): 103 passed, 52 skipped (the macOS-only specs), 2 failed. The two
failures are `visual-regression.spec.ts` ("library grid renders seeded
captures", "editor focus renders the source canvas and chrome"). Unmodified
`origin/main` at 3527a153 fails both in the same harness with identical
diffs: 35,932 and 41,689 differing pixels, and the same 918×714 vs 920×727
size mismatch. The editor golden still shows the toolbar from before the
nine-slot tool bag (#674). Neither screenshot contains sharp output. Those
goldens are recorded on GHA x64, so this arm64 harness cannot judge them
either way.

## Costs, measured or known

- Slower image work on Linux. The probe ran its 3,200 sharp operations in
  20–33s under wasm, about 25ms per operation. The spec got faster anyway
  (about 6.2s per iteration against 6.9–8.7s before), because nothing
  crashes or waits out a 15s timeout.
- **SVG `<text>` renders blank** under wasm (no native text rendering), and
  SVG goes through resvg instead of librsvg. Text annotations do not
  depend on it: they bake through Chromium (`text-html-bake.ts`). The cart
  drag icon's labels do, so they are blank on Linux.

## Reading the next one

- If a Linux E2E log shows `G_IS_OBJECT` or `SharpElectronLinux` again,
  sharp is running native inside Electron. Look for a warn line saying
  the wasm package is missing, or for a new entry point that loads sharp
  without importing the steer first.
- A teardown that reports `close=timeout, exited=false` after an
  operation that "returned ok" is not proof of a hang. Record the child's
  exit signal before reasoning about renderer state.

## Addendum (2026-10-06): the package on a Mac is a stale tree, not a gate failure

`pnpmfile.test.mjs` › "the installed sharp exposes its wasm binding only on
Linux" failed on macOS checkouts at an unmodified `main` (593be5b4). Every one
of them had `@img+sharp-wasm32@0.35.4` in `node_modules/.pnpm`, and all of
their `node_modules` were last installed with pnpm 10.33.0, before the gate
settled. The gate itself holds:

- A clean `pnpm install --frozen-lockfile` with pnpm 12.9.1 on macOS skips the
  package. `.modules.yaml` lists it under `skipped`, and the test passes.
- **pnpm does not remove an installed package that the lockfile now skips for
  this platform.** Measured on 12.9.1: install with `os: [linux]` deleted from
  the lockfile entry, restore the line, then run `pnpm install
  --frozen-lockfile` and plain `pnpm install`. Neither removes it, and the
  second reports "Already up to date". **`pnpm prune` does remove it.** It
  leaves a dangling `@img/sharp-wasm32` symlink beside sharp, which resolves
  as `Cannot find module`.
- Release staging does not ship it, even from such a stale tree. `pnpm
  deploy --prod --legacy` installs from the lockfile and skips it.
  `injectDarwinPlatformPackages` copies only the four named darwin slices. On
  Windows and darwin-arm64, `pruneSharpNativePackages` removes it anyway,
  because `sharp-wasm32` matches `^sharp-`, and `verify-asar-contents` fails if
  it survives. The universal mac build has neither check. Today that build is
  protected only by deploy honoring the lockfile.

The test now says this in its failure message, and it names `pnpm prune`.
