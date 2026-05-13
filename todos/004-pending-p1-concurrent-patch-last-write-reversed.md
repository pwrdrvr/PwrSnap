---
status: pending
priority: p1
issue_id: 004
tags: [code-review, frontend-races, correctness]
pr: 20
agents:
  - julik-frontend-races-reviewer
  - architecture-strategist
---

# Concurrent `patch()` resolutions can reverse last-write-wins

## Problem Statement

`apps/desktop/src/renderer/src/features/settings/useSettings.ts:88-99`:

```ts
const result = await dispatch("settings:write", p);
if (!mountedRef.current) return;
if (!result.ok) { setError(result.error); throw ...; }
setSettings(result.value);  // ← optimistic
```

User double-clicks two `Use` buttons in AI Providers
(`AIProvidersPage.tsx:156-159`). Two `settings:write` dispatches in
flight. Main's `writeQueue` serializes correctly so A-then-B is the
disk order. But the renderer's `setSettings(result.value)` runs in
microtask order of resolution — if B resolves first (server-merged
state is correct: A then B) and A's promise resolves second,
`setSettings(A.value)` clobbers `setSettings(B.value)`. The user sees
their second click vanish a frame later.

Same trap in `refreshCodex` (`useSettings.ts:101-113`): mount-fetch
fires `refreshCodex(false)`, user clicks Refresh which fires
`refreshCodex(true)`. If the cache-friendly mount fetch finishes
later (slow disk + warm `--version` spawn), it clobbers the fresher
Refresh result.

Compounding issue: the optimistic `setSettings(result.value)` is also
redundant with the broadcast (`events:settings:changed` always fires
after a write, payload includes the same `settings`). Two state
sources race each other.

## Findings

- **Severity:** P1.
- **Files:**
  - `apps/desktop/src/renderer/src/features/settings/useSettings.ts`
  - `apps/desktop/src/renderer/src/features/settings/pages/AIProvidersPage.tsx`

## Proposed Solutions

### Option A — Monotonic request-id (recommended)
Stamp every mutating call and drop late resolutions:

```ts
const writeSeq = useRef(0);
const patch = useCallback(async (p) => {
  const seq = ++writeSeq.current;
  const result = await dispatch("settings:write", p);
  if (!mountedRef.current) return;
  if (seq !== writeSeq.current) return;        // newer call in flight
  if (!result.ok) { setError(result.error); throw ...; }
  setSettings(result.value);
}, []);
```

Apply to `patch`, `refreshCodex`, `replaceSecret`, `clearSecret`.

- **Pros:** ~20 LOC total. Kills the entire class.
- **Cons:** Extra `useRef` per callback.
- **Effort:** Small.
- **Risk:** Low.

### Option B — Drop optimistic set, rely on broadcast (also recommended)
Remove `setSettings(result.value)` after each write. The broadcast in
`settings-handlers.ts:165` is already awaited before the handler
returns, so by the time the dispatch resolves, the broadcast has
fired and the subscriber has updated state.

- **Pros:** One source of truth. ~5 lines removed.
- **Cons:** A future write whose broadcast somehow doesn't reach the
  same window would leave state stale (but broadcasts go to *every*
  window via `BrowserWindow.getAllWindows`, so a sibling-only race is
  not possible).
- **Effort:** Tiny.
- **Risk:** Low.

## Recommended Action

Combine both: drop optimistic sets (Option B simplifies the surface),
then add request-id stamping for `refreshCodex` and the secret ops
(which return their own status, not a broadcast). The broadcast handles
`patch()` cleanly without seq numbers if optimistic sets are gone.

## Affected Files

- `apps/desktop/src/renderer/src/features/settings/useSettings.ts` (drop
  optimistic sets, add seq for refreshCodex + replaceSecret + clearSecret)

## Acceptance Criteria

- [ ] No `setSettings(result.value)` after a `settings:write` dispatch
  resolves.
- [ ] `refreshCodex` ignores its resolution if a newer call has been
  issued (`writeSeq` ref bumped).
- [ ] `replaceSecret` and `clearSecret` likewise.
- [ ] Unit test: two parallel `patch()` calls, second resolves first,
  first resolves second; assert final state matches the second call's
  intent.
