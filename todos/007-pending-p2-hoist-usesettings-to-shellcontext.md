---
status: pending
priority: p2
issue_id: 007
tags: [code-review, frontend-races, refactor]
pr: 20
agents:
  - julik-frontend-races-reviewer
---

# Hoist `useSettings` to `SettingsApp` + context — one subscriber per window

## Problem Statement

`useSettings` is called by every page (`HotkeysPage`, `AIProvidersPage`,
`AboutPage`, `ExperimentalPage`). Each call:
- registers a new `events:settings:changed` subscriber
- fires its own initial `settings:read` + `settings:secretStatus`
  dispatches on mount

Page switches via the URL hash teardown-then-mount the new page. There's
a window — depending on React's cleanup ordering — where two
subscribers exist, or zero. Two broadcasts → two `setSettings` calls →
one wasted render at best, a state divergence at worst.

This is also a wasted IPC round-trip per page mount: the previous page
just finished reading the same data.

## Findings

- **Severity:** P2.
- **Files:** all four pages + `useSettings.ts`
- **Impact:** double-renders, double-dispatches per page navigation;
  potential for inconsistent state across pages within the same window
  during the teardown→mount gap.

## Proposed Solutions

### Option A — Hoist to `SettingsApp` + React context (recommended)
1. Call `useSettings()` once in `SettingsApp.tsx`.
2. Wrap children in `<SettingsContext.Provider value={...}>`.
3. Replace per-page `useSettings()` with `useContext(SettingsContext)`.

- **Pros:** One subscriber per window. One initial fetch per window.
  Pages stay simple (consume context, no extra args).
- **Cons:** New context module. ~40 LOC of plumbing.
- **Effort:** Small.
- **Risk:** Low. Context is the right tool for "shared state across
  a subtree."

### Option B — Module-level singleton store
Use a small store (Zustand or hand-rolled `useSyncExternalStore`).

- **Pros:** Avoids context lifecycle entirely.
- **Cons:** Pulls in a new dep or a custom store; codebase pattern is
  hooks + lib/pwrsnap.ts, not module-level singletons.
- **Effort:** Medium.
- **Risk:** Low but introduces a new pattern.

## Recommended Action

Option A. Pair with todos #004 + #006 — they all touch `useSettings`.

## Affected Files

- `apps/desktop/src/renderer/src/features/settings/useSettings.ts`
- `apps/desktop/src/renderer/src/features/settings/SettingsApp.tsx`
- `apps/desktop/src/renderer/src/features/settings/pages/*.tsx`
- New: `apps/desktop/src/renderer/src/features/settings/SettingsContext.tsx`

## Acceptance Criteria

- [ ] `SettingsApp` is the single `useSettings()` call site.
- [ ] Pages consume via `useContext`.
- [ ] No regressions in the existing `useSettings.test.ts`.
- [ ] New test: render two pages in sequence, assert exactly one
  `settings:read` dispatch fired (mocked).
