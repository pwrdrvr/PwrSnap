# Contributing to PwrSnap

Thanks for taking the time to improve PwrSnap. The project is MIT-licensed
(see [LICENSE](LICENSE)) and currently in alpha — actively developed, but
designed to be non-destructive between releases. The settings substrate and
capture/overlay schemas migrate forward without invalidating older installs;
keep that contract in mind when proposing changes to either.

This document covers the development setup, repository conventions, testing
workflow, and diagnostic tooling needed to ship a change confidently. For the
load-bearing project rules (brand, command bus, sandboxed renderers,
settings substrate, popover sizing gotchas, native binding repair), read
**[AGENTS.md](AGENTS.md)** first. For the user-facing pitch, see
**[README.md](README.md)**.

## Development Setup

1. Install Node.js from `.nvmrc` (currently `v24.14.1`).
2. Run `pnpm install` from the repo root.
3. Run `pnpm dev` for the desktop app.

Useful checks (all run from the repo root):

- `pnpm typecheck` — workspace-wide TypeScript check
- `pnpm test` — Vitest unit + integration suite
- `pnpm test:desktop-e2e` — Playwright + Electron end-to-end suite
- `pnpm test:desktop-e2e:docker` — the Linux/xvfb E2E subset on Docker, used
  to reproduce GitHub Actions failures locally
- `pnpm lint` — `typecheck` + `licenses:check`
- `pnpm licenses:check` — verifies `THIRD_PARTY_LICENSES` matches a
  deterministic regeneration; run `pnpm licenses:generate` after dependency
  changes
- `pnpm release:check` — release metadata gate (tag / version / changelog)

When focusing root Vitest runs through `pnpm test`, pass file paths or
filters directly, for example
`pnpm test apps/desktop/src/main/__tests__/development-dock-icon.test.ts`. Do
not insert a standalone `--` before the focus args; `pnpm test -- apps/...`
makes Vitest run the full workspace suite.

## Workspace Map

- `apps/desktop` — Electron app shell (main, preload, renderer, IPC).
- `packages/shared` — cross-process command-bus contracts, IPC channel
  constants, Result envelopes, overlay schemas.
- `packages/codex-app-server-protocol` — generated TypeScript types for the
  Codex App Server stdio JSON-RPC protocol. **Generator output; do not
  hand-edit `src/`.** Regenerate via `pnpm codex:generate-protocol`.

See the "How it's built" table in [README.md](README.md#how-its-built) for
the layer → stack → path mapping.

## Pull Requests

- Keep PRs focused on one change.
- Follow Conventional-Commit-style PR titles: `type(scope): description`.
  Prefer scopes that match the project area being changed:
  - `desktop` — the Electron app itself (main, preload, renderer).
  - `protocol` — the consumed `@pwrdrvr/codex-app-server-protocol` package.
  - `design` — UI work tied to the design system.
  - `release` — packaging, signing, notarization, distribution, auto-update.
  - `docs` — documentation only.
  - `tests` — test coverage, fixtures, infrastructure.
- Include tests or explain why the change is documentation-only.
- Run the relevant checks before requesting review.
- Update `THIRD_PARTY_LICENSES` with `pnpm licenses:generate` when dependency
  changes affect bundled notices.

## Codex App Server (the AI brain)

All AI features in PwrSnap go through the user's installed Codex CLI / Codex
Desktop instance over stdio JSON-RPC — annotation, description generation,
tag suggestion, smart filenames, sensitive-data review, and (Phase 5+) voice
describe. **No direct OpenAI / Anthropic / xAI calls** in `apps/desktop`.

Protocol types live at
[packages/codex-app-server-protocol/](packages/codex-app-server-protocol/);
`src/` is generator output. To (re)generate against the locally installed
Codex CLI:

```bash
pnpm codex:generate-protocol
```

By default this runs against Codex Desktop's bundled binary at
`/Applications/Codex.app/Contents/Resources/codex`. Override via
`PWRSNAP_CODEX_BIN=/path/to/codex pnpm codex:generate-protocol` to point at
a system-installed CLI, a custom build, or a CI install. Regenerate whenever
Codex Desktop autoupdates or a new protocol surface lands that PwrSnap wants
to consume.

PwrSnap is an App Server **client only** — never an App Server
*implementation*.

## Repository Conventions

- **pnpm workspaces.** Apps in `apps/*`, packages in `packages/*`. Always run
  `pnpm install` from the repo root.
- **Channel naming.** IPC channels use bare `<domain>:<verb>`
  (`capture:region`, `library:list`, `overlays:upsert`). No `pwrsnap:`
  prefix; matches PwrAgnt convention.
- **Single command bus.** All commands route through
  [`apps/desktop/src/main/command-bus.ts`](apps/desktop/src/main/command-bus.ts).
  ipcMain (Phase 1), HTTP RPC (Phase 7), and a future MCP transport all
  dispatch through it. Exactly one place to register a command and exactly
  one place to enforce auth + capability checks.
- **TypeScript strict.** `tsconfig.base.json` has `strict`,
  `verbatimModuleSyntax`, `isolatedModules`, and (per the deepening plan)
  `exactOptionalPropertyTypes`.
- **Renderers stay sandboxed.** Every `BrowserWindow` is created with
  `contextIsolation: true, sandbox: true, nodeIntegration: false`. Lifecycle
  tests enforce.
- **Result-pattern for cross-process errors.** Electron `invoke` strips
  `instanceof`. All command handlers return `Result<Res, PwrSnapError>` —
  `{ ok: false, error: { kind, code, message, cause? } }`.

The full and authoritative list of conventions, gotchas, and load-bearing
patterns (popover sizing, `setMinimumSize(0, 0)`, settings substrate,
better-sqlite3 native binding repair) lives in
**[AGENTS.md](AGENTS.md)** — read it before touching window code,
settings, or the native sidecar.

## Testing

For the desktop end-to-end suite, prefer `pnpm test:desktop-e2e` from the
repo root. The package-level
`pnpm --filter @pwrsnap/desktop test:e2e` path is also safe — it builds
`apps/desktop/out/` before launching Playwright.

To reproduce the Linux GitHub Actions Desktop E2E job locally, use
`pnpm test:desktop-e2e:docker` (or pass `--test '<pattern>' --iterations 30`
for flake hunting). This runs the Linux/xvfb subset on Docker's native Linux
platform; macOS-only clipboard, tray, menu-bar, screen-capture, and AppKit
windowing specs are expected to be skipped. Add `--platform linux/amd64`
only when investigating architecture-specific GHA parity.

## better-sqlite3 Native Binding Repair

PwrSnap uses `better-sqlite3`, which ships a native `.node` binary. The
system Node ABI and Electron ABI can diverge — especially after switching
worktrees, updating Electron, or running `pnpm install` under a different
Node version. The usual symptom during `pnpm dev` is:

```text
better_sqlite3.node was compiled against a different Node.js version
NODE_MODULE_VERSION <old>. This version of Node.js requires NODE_MODULE_VERSION <new>.
```

Do not chase this as a database bug. Repair the native sidecar from the repo
root:

```bash
pnpm install
cd apps/desktop && node ./scripts/rebuild-native-for-electron.mjs
```

The script keeps two binaries on purpose:

- `better-sqlite3/build/Release/better_sqlite3.node` stays compiled for
  system Node so unit tests and scripts can `require("better-sqlite3")`.
- `better-sqlite3/electron-native/better_sqlite3.node` is compiled or
  downloaded for Electron and is what the app loads at runtime.

For release/package work, the Electron sidecar must be built for the target
architecture, not necessarily the host. The script honors `npm_config_arch`
/ `npm_config_target_arch` (including `"universal"`, which lipos arm64 +
x64 prebuilds into a fat binary), and
`apps/desktop/src/main/persistence/native-binding.ts` ignores the sidecar
unless its metadata matches the running Electron version, `better-sqlite3`
version, and `process.arch`.

## Release Pipeline

The desktop release pipeline (universal DMG, signing, notarization,
auto-update, stable `PwrSnap.dmg` URL) is documented in
[docs/desktop-release-runbook.md](docs/desktop-release-runbook.md).

## Plan Documents

- Implementation plans live in `docs/plans/`. The current canonical
  buildout plan is
  [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md)
  — read it before changing scope, schema, IPC contracts, or phase order.
- Brainstorm / requirements docs (when they appear) live in
  `docs/brainstorms/`.
- Solution learnings (post-incident notes, gotchas) live in
  `docs/solutions/`.
- Treat plan documents as decision artifacts, not implementation scripts.
- Do not delete or "clean up" files in `docs/brainstorms/`, `docs/plans/`,
  or `docs/solutions/`.

## Conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not report vulnerabilities in public issues. Follow
[SECURITY.md](SECURITY.md).
