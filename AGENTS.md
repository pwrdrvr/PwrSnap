# PwrSnap Repository Guidance

## Source of Truth

- Implementation plans live in `docs/plans/`. The current canonical buildout plan is
  [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md) —
  read it before changing scope, schema, IPC contracts, or phase order.
- Brainstorm / requirements docs (when they appear) live in `docs/brainstorms/`.
- Solution learnings (post-incident notes, gotchas) live in `docs/solutions/`.
- The original Claude Design handoff bundle (HTML/JSX/CSS reference for the
  Library + Float-Over + Tray surfaces) is preserved verbatim under `design/`.
  Treat it as a visual reference, not as code to import.

## Workflow

- Treat plan documents as decision artifacts, not implementation scripts.
- Keep changes aligned with the current active plan unless the user explicitly
  changes scope.
- Do not delete or "clean up" files in `docs/brainstorms/`, `docs/plans/`, or
  `docs/solutions/`.

## Agent Instruction Files

- Keep a sibling `CLAUDE.md` symlink next to every `AGENTS.md`, pointing at
  that `AGENTS.md`, so Codex and Claude read the same local guidance.
- Project root: `CLAUDE.md → AGENTS.md` (this file).

## Brand and Identity

- Product name is **PwrSnap** — one word, two capitals (`Pwr` + `Snap`),
  rendered as `Pwr` in primary text + `Snap` in copper accent. Never insert
  whitespace between the halves; never lowercase the second capital.
- Company is **PwrDrvr LLC**. License markings are `UNLICENSED` —
  v1.0 is closed-source proprietary.
- Visual language follows the design system in `design/` — warm near-black
  surfaces, burnt-copper accent (`#e8743a`), Geist + Geist Mono.

## Codex App Server is the AI brain

**All AI features in PwrSnap go through the user's installed Codex CLI / Codex
Desktop instance over stdio JSON-RPC.** This is the schtick — annotation,
description generation, tag suggestion, smart filenames, sensitive-data
review, voice describe, sizzle-reel composition. No direct OpenAI / Anthropic
/ xAI calls in `apps/desktop`.

### Protocol package

TypeScript types for the protocol live at
[packages/codex-app-server-protocol/](packages/codex-app-server-protocol/).
The contents of its `src/` are **generator output** — do not hand-edit.

To (re)generate the protocol types from the locally-installed Codex CLI:

```bash
pnpm codex:generate-protocol
```

(equivalent: `pnpm --filter @pwrsnap/codex-app-server-protocol generate`)

This runs `codex app-server generate-ts --out ./src` against whichever `codex`
binary is on `PATH`. Commit the diff. Regenerate whenever the user's installed
Codex CLI ships a newer protocol version.

### Connecting at runtime

PwrSnap discovers and connects to the user's local Codex install — same model
as PwrAgnt. Settings → AI surfaces every detected Codex binary, lets the user
pick newest / pin a specific path, and persists the choice. Discovery code in
`apps/desktop/src/main/settings/codex-discovery.ts` mirrors PwrAgnt's
implementation; see plan §"Phase 0.5".

### One-shot vs multi-turn

Both shapes go through Codex App Server:

- **Phase 4 background pipelines** (annotate / describe / tag / filename) use
  ephemeral threads + `DynamicToolCall` for structured output. Image input
  rides as a `ContentItem` in `TurnStartParams`. Thread is closed immediately
  after the turn completes.
- **Phase 4+ user-facing AI surface** ("ask Codex about this snap") uses
  long-lived threads with normal `turn/start` cadence.
- **Phase 6 sizzle composer** uses multi-turn agentic flow.
- **Phase 5+ voice describe** uses `ThreadRealtime*`.

PwrSnap is an App Server *client* only — never an App Server *implementation*.

## Repository conventions

- **pnpm workspaces.** Apps in `apps/*`, packages in `packages/*`. Always run
  `pnpm install` from the repo root.
- **Channel naming.** IPC channels use bare `<domain>:<verb>` (`capture:region`,
  `library:list`, `overlays:upsert`). No `pwrsnap:` prefix; matches PwrAgnt.
- **Single command bus.** All commands route through
  `apps/desktop/src/main/command-bus.ts`. ipcMain (Phase 1), HTTP RPC
  (Phase 7), and a future MCP transport all dispatch through it. There is
  exactly one place to register a command and exactly one place to enforce
  auth + capability checks.
- **TypeScript strict.** `tsconfig.base.json` has `strict`,
  `verbatimModuleSyntax`, `isolatedModules`, and (per the deepening plan)
  `exactOptionalPropertyTypes`.
- **Renderers stay sandboxed.** Every `BrowserWindow` is created with
  `contextIsolation: true, sandbox: true, nodeIntegration: false`. The Phase 6
  Remotion player runs in a sandboxed renderer; render orchestration runs in
  a Node child process. Lifecycle test enforces.
- **Result-pattern for cross-process errors.** Electron `invoke` strips
  `instanceof`. All command handlers return `Result<Res, PwrSnapError>` —
  `{ ok: false, error: { kind, code, message, cause? } }`.

## Pull Requests

- Conventional Commit-style PR titles: `type(scope): short description`.
- Scopes that match the project area:
  - `desktop` — the Electron app itself (main, preload, renderer).
  - `protocol` — the `@pwrsnap/codex-app-server-protocol` package.
  - `design` — UI work tied to the design system.
  - `release` — packaging, signing, notarization, distribution.
  - `docs` — documentation only.
  - `tests` — test coverage / fixtures / infrastructure.

## Release / Distribution

- Closed-source proprietary. License markings (`UNLICENSED`) are load-bearing.
- macOS-first (Phase 1–7); cross-platform deferred to Phase 8.
- electron-builder config at [apps/desktop/electron-builder.yml](apps/desktop/electron-builder.yml).
  Hardened runtime + notarization wired (notarize off until Apple Developer
  ID is configured).
- Auto-update wires in Phase 3 via `electron-updater`, mirroring PwrAgnt's
  pattern.

## Dependencies and tooling

- Node version pinned in `.nvmrc` (currently `v24.14.1`).
- Package manager: `pnpm@10.33.0` (set in root `package.json`'s
  `packageManager` field).
- Electron + electron-vite versions pinned in `apps/desktop/package.json`,
  matching PwrAgnt for tool consistency.
