---
status: pending
priority: p2
issue_id: 005
tags: [code-review, architecture, caching]
pr: 20
agents:
  - architecture-strategist
---

# Codex discovery cache returns stale `resolvedPath` after a settings write

## Problem Statement

`apps/desktop/src/main/settings/desktop-settings-service.ts:155-176, 268-317`
caches `DesktopCodexDiscoverySnapshot` for 30 seconds keyed only on
time. The snapshot includes `resolvedPath`, which is computed from
`settings.codex.{mode, pinnedPath}` at snapshot time. If a user pins a
path (`settings:write`), the next renderer read of the snapshot within
30s returns the stale snapshot — `resolvedPath` reflects the *old*
mode/pin.

`AIProvidersPage.tsx:314` uses the resolved path to draw the "Using"
badge. So clicking "Use" on a candidate writes the pin, but the
badge stays on the prior choice until the cache expires.

## Findings

- **Severity:** P2.
- **Files:**
  - `apps/desktop/src/main/settings/desktop-settings-service.ts`
- **User-visible impact:** the "Using" badge lies for up to 30s after
  pin. Refresh button bypasses the cache, so the user can work around
  it — but they shouldn't have to.

## Proposed Solutions

### Option A — Invalidate cache on writes that touch `codex.*` (recommended)
Single line inside the `write()` task closure:

```ts
if (patch.codex !== undefined) this.codexSnapshotCache = null;
```

- **Pros:** Tiny. Correct.
- **Cons:** None.
- **Effort:** Tiny.
- **Risk:** None.

### Option B — Don't cache `resolvedPath`; compute it on every read
Cache only the expensive `discoverCodexCommands` result; recompute
`resolveCodexCommand` on each snapshot request.

- **Pros:** Decouples cache from settings state entirely.
- **Cons:** Slightly more refactor; `resolveCodexCommand` is cheap but
  not free (env lookup, fs.access on resolved path).
- **Effort:** Small.
- **Risk:** Low.

## Recommended Action

Option A — one line, correct semantics, doc'd intent.

## Affected Files

- `apps/desktop/src/main/settings/desktop-settings-service.ts`

## Acceptance Criteria

- [ ] Cache invalidation in `write()` when `patch.codex` is supplied.
- [ ] Unit test: pin a candidate, immediately request discovery
  snapshot, assert `resolvedPath === newlyPinnedPath`.
