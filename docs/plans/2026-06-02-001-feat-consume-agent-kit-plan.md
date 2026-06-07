---
title: "feat: migrate PwrSnap onto @pwrdrvr/agent-kit packages"
status: complete
date: 2026-06-02
completed: 2026-06-07
type: feat
target_repo: PwrSnap (this repo)
parent_plan: agent-kit repo, docs/plans/2026-06-02-001-feat-agent-kit-monorepo-buildout-plan.md
---

# feat: migrate PwrSnap onto @pwrdrvr/agent-kit packages

## Shipping Status — COMPLETE (2026-06-07)

All implementation units shipped. PwrSnap's chat (Library + Sizzle) and capture
enrichment run on the published `@pwrdrvr/agent-{core,client,acp,transport}`
packages; the in-tree generic substrate (JSON-RPC core, stdio transport,
`CodexThreadClient`, chat controller) is deleted. Persistence, prompts, tool
allowlists, the enrichment schema, and the command bus stayed in PwrSnap via
injected seams.

- **U1–U4** (transport/discovery seams, `agent-client` + `ThreadStore` adapter,
  renderer chat on the kit's neutral events, delete the duplicated substrate):
  shipped in **PR #195** (`feat: consume @pwrdrvr/agent-kit`, `0e48bcfb`).
- **U5** (`file:` links → published packages): done — PwrSnap consumes published
  npm releases, not `file:` links. Current pins: `@pwrdrvr/agent-acp ^0.10.3`,
  `@pwrdrvr/agent-client ^0.6.0`, `@pwrdrvr/agent-core ^0.1.3`,
  `@pwrdrvr/agent-transport ^0.1.4`.
- **ACP backends + Settings AI surface** (deferred "follow-up" in the original
  plan below) also shipped: per-job provider/model/reasoning routing, local ACP
  agents (Kimi/Grok/Qwen/Gemini) for enrichment + chat, pooled warm processes,
  host-owned approval policy, the MCP tool bridge (its own plan,
  `2026-06-05-001-feat-acp-chat-mcp-tool-bridge-plan.md`), and a polish pass in
  **PR #213** (`fix: Grok/ACP enrichment — clean JSON, correct model reporting,
  friendly names`, `906efe33`): thoughts-suppression for clean JSON, Grok
  token-usage + effective-model reporting (`agent-acp` 0.10.1→0.10.3), friendly
  model names, honest "Default (…)" annotation, and a model-override note.

Remaining items are small, non-blocking polish (do NOT gate this plan):
- Remember the models an agent rejects on `set_model` (`-32602`, e.g. Grok /
  Cursor's "Composer 2.5") and gray them out in the picker.
- Eager-warm the ACP/Codex model-label caches at startup (today they warm when
  Settings → AI Providers lists models).

---

**Target repo:** PwrSnap (this repo). All paths are PwrSnap repo-relative. The packages being
consumed live in the separate `agent-kit` repo (`@pwrdrvr/*` on npm).

This plan is the PwrSnap half of the agent-kit extraction. It is the **first real consumer** and the
proof that the extraction works — the master buildout plan is not "finished" until this lands. PwrSnap
keeps every domain concern (tool allowlists, prompts, enrichment schema, persistence, the command bus,
the SQLite stores); it swaps only the **generic substrate** it currently maintains as a hand-synced copy
of PwrAgnt's, plus it **gains** multi-profile Codex selection + relogin for free.

---

## Summary

Replace PwrSnap's in-tree generic agent substrate — the JSON-RPC core, stdio transport, `CodexThreadClient`,
`ChatThreadController`, `defineTool`/catalog plumbing, Codex discovery, and the presentational chat React kit —
with dependencies on `@pwrdrvr/agent-transport`, `@pwrdrvr/codex-discovery`, `@pwrdrvr/agent-client`,
`@pwrdrvr/agent-chat-react`, `@pwrdrvr/agent-core`, and `@pwrdrvr/codex-app-server-protocol`. Wire PwrSnap's
domain (tools, prompts, enrichment schema, SQLite store) into the packages via the injection seams (`Logger`,
`ThreadStore`, `OpenExternal`, tool catalog + dispatch). Delete the now-duplicated in-tree copies. Adopt the
multi-profile + relogin capability PwrSnap never had.

Consumption follows the master plan's distribution flow: **`file:` link** on this machine to prove it compiles
and a real turn runs → switch to the **`@pwrdrvr/*@next` prerelease** → (later) flip to stable. No `git`
dependency refs at any step (PwrDrvr policy).

---

## Problem Frame

PwrSnap's transport/discovery files literally carry `// Lifted from PwrAgnt` headers — they are a hand-synced
copy that drifts. The chat controller and client were built DI-first specifically so they could be lifted. Now
that the agent-kit packages exist, keeping the copies is pure liability: every fix has to be applied twice, and
PwrSnap is missing PwrAgnt's profile-management + relogin niceties purely because nobody back-ported them. This
migration deletes the duplication and closes that gap in one move.

---

## Goals

- PwrSnap's AI features (capture enrichment, Library Chat, Sizzle Reel chat) run on the `@pwrdrvr/*` packages with
  **no behavior change** users can perceive.
- The in-tree generic copies are **deleted**, not left as dead code.
- PwrSnap gains **multi-profile Codex selection + relogin** via `@pwrdrvr/codex-discovery`.
- PwrSnap CI is green on `@pwrdrvr/*@next`.

## Non-Goals (Scope Boundaries)

**Out of scope (stays exactly as-is in PwrSnap):**
- Domain tool allowlists (`library-tool-allowlist.ts`, `sizzle-tool-allowlist.ts` and their catalogs/dispatch),
  all prompts (`ai/prompts/*`, system-prompt builders), `enrichment-schema.ts` / `enrichment-image.ts` /
  `enrichment-budget.ts`, `sizzle/composer.ts` (ffmpeg), the command bus, all SQLite repos, settings substrate.
- The ACP / multi-agent surface — PwrSnap driving Kimi/Qwen/Gemini/Grok is enabled by the agent-kit ACP plan and
  picked up in **Deferred to Follow-Up** below, not here.

**Deferred to Follow-Up Work:**
- A PwrSnap Settings UI to *pick* a Codex auth profile + a relogin button (the capability lands here via the package;
  the UI surface is a fast follow once the package is wired).
- Switching PwrSnap to an ACP agent (depends on `@pwrdrvr/agent-acp`).
- Flip from `@pwrdrvr/*@next` to caret/stable ranges (coordinated by master plan U12).

---

## Key Technical Decisions

### KTD-S1 — Inject, don't fork. PwrSnap supplies the three seams.

- **Logger:** adapt `getMainLogger` to the package `Logger` interface (a thin shim).
- **ThreadStore:** wrap the existing `ChatThreadStore` (`better-sqlite3`, `chat_threads`) + `saveAiThreadUsage`/
  `estimateAiUsageCost` behind the package `ThreadStore` interface. The SQLite stays in PwrSnap; the package never
  sees it.
- **OpenExternal:** pass Electron `shell.openExternal` into `@pwrdrvr/codex-discovery`'s login flow.
- **Identity/config:** pass `clientInfo.name: "pwrsnap"`, service name, and the `PWRSNAP_CODEX_COMMAND` env name as
  config (these were hardcoded strings in the copy).

### KTD-S2 — Tools stay in PwrSnap; only the contract moves to the package.

`defineTool` and the catalog/dispatch machinery come from `@pwrdrvr/agent-client`; PwrSnap's actual tools
(`draw_arrow`, `redact`, `crop`, sizzle tools, …) keep dispatching to the PwrSnap command bus exactly as today.
The handlers (`library-chat-handlers.ts`, `sizzle-chat-handlers.ts`, `codex-handlers.ts`) keep their bus + SQLite
wiring and now build their catalogs with the package's `defineTool`.

### KTD-S3 — `file:` link first, then `@next`.

Validate on this machine with `file:../../agent-kit/packages/*` (and the protocol package via `file:` to its repo
checkout) before any version range. This is the master plan's U10 gate; PwrSnap is the harness that proves it.

---

## Implementation Units

### U1. Wire the transport + discovery packages behind PwrSnap's seams

- **Goal:** PwrSnap's main process opens its Codex connection via `@pwrdrvr/agent-transport` +
  `@pwrdrvr/codex-discovery` instead of the in-tree copies, with the logger/openExternal/config injected.
- **Dependencies:** agent-kit packages available via `file:` link.
- **Files:** `apps/desktop/package.json` (add `@pwrdrvr/agent-transport`, `@pwrdrvr/codex-discovery`,
  `@pwrdrvr/agent-core`, `@pwrdrvr/codex-app-server-protocol` as `file:` deps), a new
  `apps/desktop/src/main/ai/agent-kit-bindings.ts` (logger/openExternal/config adapters),
  `apps/desktop/src/main/settings/desktop-settings-service.ts` + `settings-handlers.ts` (call package discovery/auth
  probe), `apps/desktop/src/main/codex-app-server/stdio-transport.ts` consumers updated to the package transport.
- **Approach:** Replace imports from `apps/desktop/src/main/codex-app-server/{json-rpc,stdio-transport}.ts` and
  `apps/desktop/src/main/settings/codex-discovery.ts` with the package equivalents. Build the `Logger`/`OpenExternal`/
  config adapters in `agent-kit-bindings.ts`. Keep the discovery results flowing into Settings → AI exactly as before.
- **Patterns to follow:** existing binding/shim patterns in `apps/desktop/src/main/ai/`.
- **Test scenarios:**
  - Happy path: discovery surfaces the same binary/version set in Settings → AI as before (snapshot parity).
  - Happy path: an App Server connection opens and `initialize` succeeds via the package transport.
  - Edge: `clientInfo.name` reaching Codex is still `"pwrsnap"` (asserts config injection).
  - Error path: no Codex installed → the same Settings error state as before (`CodexCliNotInstalledError` mapped).
  - Integration: the login flow opens the OAuth URL via the injected `shell.openExternal`.
- **Verification:** PwrSnap dev build connects to Codex and runs an enrichment turn end-to-end on `file:` links.

### U2. Wire `agent-client` (thread client + chat controller) behind the `ThreadStore` seam

- **Goal:** Library Chat + Sizzle Reel chat + capture enrichment run on `@pwrdrvr/agent-client`, with PwrSnap's
  SQLite behind the package `ThreadStore`.
- **Dependencies:** U1.
- **Files:** `apps/desktop/package.json` (add `@pwrdrvr/agent-client`),
  `apps/desktop/src/main/ai/thread-store-adapter.ts` (new; wraps `ChatThreadStore` + usage persistence),
  `apps/desktop/src/main/handlers/{library-chat-handlers,sizzle-chat-handlers,codex-handlers}.ts` (build catalogs
  with package `defineTool`, construct the controller from the package), retire local
  `apps/desktop/src/main/ai/{codex-thread-client,codex-client,chat-thread-controller,define-tool}.ts` usage.
- **Approach:** Construct the package `ChatThreadController` with PwrSnap's injected `ThreadStore`, tool catalog
  (built from PwrSnap's allowlists via the package `defineTool`), dispatch (PwrSnap command bus), system-prompt
  builder, and turn-context builder. Enrichment uses the package one-shot client with PwrSnap's `CAPTURE_ENRICHMENT_SCHEMA`
  + prompt passed in (not baked into the package). Subscribers now receive `NormalizedThreadEvent` — adapt the
  renderer event handling accordingly (pairs with U3).
- **Patterns to follow:** the current controller construction in `library-chat-handlers.ts` / `sizzle-chat-handlers.ts`
  — same shape, package-sourced controller.
- **Test scenarios:**
  - Covers parity: a Library Chat turn produces the same user-visible message + tool-call sequence as before.
  - Happy path: a sizzle chat tool call dispatches to the command bus and applies the same project mutation.
  - Happy path: capture enrichment returns the same `CAPTURE_ENRICHMENT_SCHEMA` object for a fixture image.
  - Edge: usage/cost is written through the `ThreadStore` adapter to the same `chat_threads`/usage tables (mock + real).
  - Edge: per-thread turn isolation preserved (two open chats don't bleed).
  - Error path: an un-allowlisted tool is still rejected.
  - Integration: approval flow round-trips through the package controller to the renderer modal.
- **Verification:** all three AI surfaces behave identically in a manual pass; usage rows land in the same tables.

### U3. Swap the renderer chat UI to `@pwrdrvr/agent-chat-react`

- **Goal:** Library + Sizzle chat panels render via the package's presentational components against neutral events.
- **Dependencies:** U2.
- **Files:** `apps/desktop/package.json` (add `@pwrdrvr/agent-chat-react`),
  `apps/desktop/src/renderer/src/features/library/chat/LibraryChatPanel.tsx`,
  `apps/desktop/src/renderer/src/features/sizzle/**/*Chat*.tsx`, retire
  `apps/desktop/src/renderer/src/features/shared/chat/*`.
- **Approach:** Replace imports of the local `shared/chat/*` with the package components; map the renderer's event
  state to the neutral `NormalizedThreadEvent` props. PwrSnap-specific panel chrome (headers, capture context)
  stays in PwrSnap and composes the package components.
- **Patterns to follow:** the existing `shared/chat` consumption in `LibraryChatPanel.tsx`.
- **Test scenarios:**
  - Happy path: the chat panel renders a normalized event stream identically to the prior local components (visual parity).
  - Edge: streaming deltas and tool-call status cards render incrementally.
  - Edge: approval modal callbacks fire with correct ids.
  - `Test expectation:` renderer component tests only — no IPC.
- **Verification:** Library + Sizzle chat panels look and behave as before; old `shared/chat` files are deleted.

### U4. Delete the duplicated in-tree substrate

- **Goal:** Remove the now-dead generic copies so there is one source of truth.
- **Dependencies:** U1, U2, U3 (all green).
- **Files (delete):** `apps/desktop/src/main/codex-app-server/{json-rpc,stdio-transport}.ts`,
  `apps/desktop/src/main/settings/codex-discovery.ts`, `apps/desktop/src/main/ai/{codex-thread-client,codex-client,chat-thread-controller,define-tool,library-tool-catalog-generic-bits}.ts`,
  `apps/desktop/src/renderer/src/features/shared/chat/*`. (Keep all domain files: allowlists, prompts, enrichment-*,
  composer, handlers.)
- **Approach:** Delete only files whose functionality is now fully provided by a package and confirmed by U1–U3.
  Update any lingering imports. Update `CLAUDE.md` notes that reference the in-tree transport/chat substrate to point
  at the packages.
- **Test scenarios:** `Test expectation: none — deletion`. Verification is the full suite + typecheck staying green.
- **Verification:** `pnpm -w typecheck` + PwrSnap test suite green with the files removed; grep finds no imports of
  deleted modules.

### U5. Switch `file:` links to `@pwrdrvr/*@next`

- **Goal:** Consume the published prereleases instead of local file links.
- **Dependencies:** master plan U10 (prereleases published); U4.
- **Files:** `apps/desktop/package.json`, root lockfile.
- **Approach:** Replace each `file:` range with the `@next` dist-tag range; `pnpm install`; re-run the U1–U3
  verifications against the published packages. Per policy, no `git` ranges — `file:` (local dev) and npm ranges only.
- **Test scenarios:** `Test expectation: none — dependency swap`. Verification is consumption-based.
- **Verification:** PwrSnap CI green on `@pwrdrvr/*@next`; a real Codex turn runs in a packaged dev build.

---

## Risks & Mitigations

- **Behavior drift during the swap.** *Mitigation:* parity-focused test scenarios (U2/U3) compare against current
  user-visible behavior; migrate surface-by-surface (transport → client → UI) so regressions localize.
- **`NormalizedThreadEvent` doesn't carry something PwrSnap rendered.** *Mitigation:* this is the master plan's KTD-2
  stress signal — file it against `agent-core` (U3 there) to widen the shared schema rather than patching in PwrSnap.
- **Native binding / ABI noise during `pnpm install` churn.** *Mitigation:* follow the repo's
  `pnpm rebuild:electron-native` guidance after dependency changes (CLAUDE.md).
- **Deleting too early.** *Mitigation:* U4 gates on U1–U3 all green; deletions are import-checked by typecheck.

---

## Dependencies / Sequencing

`U1` → `U2` → `U3` → `U4` → `U5`. U1–U4 run on `file:` links; U5 swaps to `@next` after the master plan publishes.
The Settings profile-picker UI and ACP agent selection are deferred follow-ups.

---

## Sources & Research

- agent-kit master plan (`docs/plans/2026-06-02-001-feat-agent-kit-monorepo-buildout-plan.md`, agent-kit repo) —
  package boundaries, injection seams, distribution flow.
- PwrSnap extraction origins (this repo): `apps/desktop/src/main/{codex-app-server,ai,settings}/`,
  `apps/desktop/src/renderer/src/features/shared/chat/`, `packages/codex-app-server-protocol/`.
- CLAUDE.md — settings substrate rules, native-binding repair, `bundle_format_version` notes (unaffected here).
