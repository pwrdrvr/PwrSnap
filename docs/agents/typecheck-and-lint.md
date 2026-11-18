# Agent rules: TypeScript unused-binding checks and Oxlint

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each rule below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Repository conventions — typecheck and lint

- **Dead imports and locals fail `pnpm typecheck`, and TypeScript is what catches
  them.** (Not `pnpm build` — electron-vite transpiles with esbuild and type-
  checks nothing, so a green build proves nothing here.) `noUnusedLocals` + `noUnusedParameters` ride
  `pnpm typecheck`, which `pnpm lint` already runs on every PR, so the check
  uses the native TypeScript 7 compiler. TypeScript 6 remains installed for
  JavaScript API consumers and `pnpm typecheck:legacy`; do not let the two
  packages' identically named `tsc` bins choose the compiler by accident.
  Package scripts select the compiler explicitly. `pnpm check:benchmark`
  compares repository file inventories and injected errors before timing
  repeated sequential pairs on one machine. It measures CLI checks, not LSP
  memory or editor responsiveness. Keep both unused-binding flags enabled.
  - This closes a real gap. A refactor in
    [#585](https://github.com/pwrdrvr/PwrSnap/pull/585) extracted a hook and
    left two imports behind in `VideoStage.tsx`, and `recording-audio.ts` kept
    the dead *value* half of a mixed `import { x, type X }` after only the type
    was still needed. Both survived a fully green CI run — 8 checks, 6121 tests
    — and were caught by a human reading the diff. `TS6133` catches both
    shapes, including the value-vs-type one.
  - **The `_` prefix is an escape hatch for PARAMETERS ONLY.**
    `noUnusedParameters` skips a parameter named `_foo`; `noUnusedLocals` does
    NOT skip a local or an import named `_foo`. Use it for a callback that must
    accept a positional argument it ignores. There is no escape hatch for a
    dead import — delete it.
  - A write-only private field counts as unused, which is the point: it is
    state nothing reads. Delete the field and its assignments rather than
    adding a read to quiet the compiler.
  - The flags are all-or-nothing and cannot be scoped per directory, so
    `e2e/**` and `__tests__/**` are gated too. That is deliberate — an unused
    import in a test is the same stale-refactor signal as one in `src/main`.
    The root `scripts/*.mjs` policy gates and
    `apps/desktop/scripts/*.mjs` are plain JS in no tsconfig, so TypeScript never
    sees them; Oxlint now checks those scripts, including unused bindings.
    `apps/desktop/tsconfig.json` does list `scripts/**/*.ts`, but
    that glob currently matches zero files.
- **Oxlint adds correctness coverage; it does not replace policy checks or
  TypeScript.** `pnpm lint:syntax` checks `apps`, `packages`, `scripts`, root
  Vitest config and pnpm hooks, including unit/E2E files. `.oxlintrc.json`
  pins an explicit rule list and the classic Rules of Hooks check; React
  Compiler rules and exhaustive-deps are not enabled by this adoption. Keep
  `design/**` untouched as a preserved handoff. TypeScript owns unused TS
  bindings; the JS rule permits unused `_` parameters, not `_` locals/imports.
  Intentional control-character validation and verification-cleanup throws
  have narrow, explained syntax exceptions.
- **Typed lint preserves receivers.** `pnpm lint:typed` checks production
  main, preload, renderer and shared TypeScript with `unbound-method`. Keep
  `oxlint.typed.json` at the root so relative overrides work. Callback methods
  implemented by React hooks/props may declare `this: void`; actual methods
  need a receiver-preserving call or bind. `scripts/lint-typed.mjs` rejects
  inline suppression of this rule, including blanket disables, using parsed
  comments. Its guard and native CLI file inventories must match; a test pins
  that equality and real lost-receiver probes. Do not disable the rule to
  accommodate an extraction. The typed pass deliberately excludes tests.
