# Renderer bytecode headroom and development owner stacks

This records the renderer function-size investigation and its measured scope.
The deterministic guard is `pnpm check:renderer-bytecode`, included in `pnpm
lint` and CI. Timing is evidence for the Library split, not a test assertion.

## What the oracle found

Both installed Node 24.22.0 / V8 13.6 and Electron 44.9.3 / V8 15.2 report
`--max-optimized-bytecode-size=61440` and Sparkplug enabled through
`--v8-options`. The guard fails above 49,152 bytes, retaining 12 KiB of
headroom before that TurboFan cutoff. This is compiler eligibility, not a
promise that V8 will optimize a function or that an optimized function is fast.

Automatic discovery covered 301 renderer application modules, including
components, hooks, local functions and anonymous callbacks. Library was the
only over-budget module. The largest other Vitest functions were
RegionSelector (21,363), FloatOver (15,249), LocalAgentsPage (14,650),
EditorLoaded (11,921), ChatPanelSurface (8,663), FloatOverHost (8,586) and
VideoTimeline (8,411) bytes. These are bytecode measurements, not source sizes.

| Library variant | Original largest function | Controller after | Render function after |
| --- | ---: | ---: | ---: |
| Vitest client (jsdom) | 52,740 | 24,502 | 20,886 |
| Vitest SSR | 52,740 | 24,502 | 20,886 |
| Development Vite + React | 47,804 | 22,435 | 19,199 |
| Production Rollup + esbuild, per module | 42,426 | 22,421 | 14,955 |

The [bounded guard logs](renderer-bytecode-2026-11-15/guard.txt) show exit 1
on the original Library (both Vitest variants) and success on the split.
Its oracle test also injects oversized, uncalled nested and
anonymous functions alongside an unresolved import and a top-level throw:
both oversized functions are detected without loading the import or running
the throw. Valid functions and repeated compilation of identical source pass.
Syntax errors fail closed.

## Repeated measurements

Host: Apple M2 Max, macOS 27.2 (26B123), arm64. Toolchain: Node 24.22.0,
React 19.3.1, Vitest 4.1.12, Vite 7.3.7. The representative file was
`Library.shortcuts.test.tsx`: the same 24 cases before and after, covering
keyboard shortcuts, grid selection, edit entry and responsive navigation.

Each cell below contains three sequential runs in milliseconds. Reported file
span is the JSON reporter's `endTime - startTime` for the file; process time
also includes Vitest startup and transformation. All per-case durations,
versions, flags and audit maxima are in [evidence.json](renderer-bytecode-2026-11-15/evidence.json).
The [bounded verbose logs](renderer-bytecode-2026-11-15/runs.txt) retain raw
run output with only home/worktree paths and ANSI color escapes removed.

| Code / flags | Reported file span | Whole process |
| --- | --- | --- |
| Original, plain Node | 655.5 / 676.6 / 625.9 | 2192 / 1976 / 1853 |
| Original, `node --no-sparkplug` | 423.6 / 452.0 / 432.0 | 1722 / 1804 / 1765 |
| Split, plain Node | 466.0 / 492.2 / 505.1 | 1839 / 1811 / 1916 |
| Split, `node --no-sparkplug` | 434.9 / 450.0 / 463.8 | 1783 / 1812 / 1814 |

Original median file span decreased 34.1% with Sparkplug disabled; whole
process median decreased 10.7%. The split with Sparkplug enabled decreased
median file span 24.9% from the original. Its remaining flag difference was
8.6%. This demonstrates a local development-test cost; it establishes no
Linux, Windows, Electron UI or production latency improvement.

The installed React development JSX runtime constructs
`Error("react-stack-top-frame")` for owner stacks. The flag sensitivity is
consistent with the large-frame owner-stack cost found in PwrAgent. This
investigation did not record a CPU profile proving that exact internal V8
stack-table path on this host.

Vitest 4 drops parent V8 arguments when creating test workers. Measurements
therefore used a temporary copy of the repository config that forwarded
`process.execArgv` into each project's `test.execArgv`. A temporary setup
file logged the worker flags and versions on every run. Both the launching
process and the workers had `--no-sparkplug` only in the flagged runs;
`NODE_OPTIONS` was empty. There was no repository Sparkplug override to remove,
and none was added. The post-split measurements excluded the newly added
lifecycle regression case so the 24 original cases remained comparable.

## Why the split has this shape

`Library` calls `useLibraryController`, retaining the same hooks, effect order
and owning component. The controller returns a render callback. A stable
`LibraryView` component invokes that callback after the controller has returned,
so development JSX creation does not keep the large controller on the stack.
The original JSX is text-identical; keys, refs, callbacks and effect dependencies
are preserved. A regression case verifies that a parent render preserves the
focused search input and mounted subscriptions. The controller and render
functions remain separate after production compression.

## Guard coverage and boundaries

- Every application `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` under renderer
  `src` is discovered, excluding declarations, tests and fixture directories.
  No named-export list or source-size threshold controls inclusion.
- Vitest client and SSR output use the installed Vitest 4 evaluator's wrapper,
  including CJS globals. Development transforms use the real electron-vite
  renderer configuration and React plugin. Production uses the real
  React/Rollup/esbuild configuration with every application module as an
  entry and imports externalized. Keep the wrapper aligned when upgrading
  Vitest's evaluator contract.
- A disposable Node process eagerly compiles scripts/ES modules with
  `--no-lazy --no-compilation-cache --experimental-vm-modules`. It never
  evaluates them, links imports or opens an Electron window. Disassembly is
  reduced as a stream to function names, ordinals, modules, variants and byte
  lengths; output is limited to the largest functions and budget failures.
  A missing transform/measurement, compiler failure or smaller runtime
  optimization limit fails the check.
- Production checks are per module, not final linked chunks. Third-party
  dependencies, shared-package modules, Electron main/preload and V8's
  runtime optimization decisions are outside this renderer guard. The oracle
  currently runs on CI Node, not Electron. Both installed runtimes' default
  limits were verified, but their bytecode lengths need not be identical.
  Follow-up coverage is tracked in [#817](https://github.com/pwrdrvr/PwrSnap/issues/817).

## Validation

`pnpm check:changed` passed lint/type/dependency/license/settings/color and
typed-boundary checks; its sandboxed full test phase could not access local
sockets, native caches and media services. The full `pnpm test` run outside
the filesystem sandbox passed: 9,706 tests, 9 skipped, 731 files passed and
2 skipped. No retries or timeout increases were used. The focused oracle and
Library regression run also passed (29 tests). A final `pnpm lint` and
`pnpm build` both passed. No headed desktop E2E was
needed for this behavior-preserving render extraction.

The PwrAgent reference was PR #3756 at
`30e49f153a5016f253e27e99bca9af95010a2b95`; its state and head were checked
before adapting it. No overlapping open PwrSnap bytecode PR was found.
