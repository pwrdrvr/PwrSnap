---
status: pending
priority: p2
issue_id: 006
tags: [code-review, frontend-races]
pr: 20
agents:
  - julik-frontend-races-reviewer
---

# Broadcast can arrive before initial-load `setSettings`, leaving stale state

## Problem Statement

`apps/desktop/src/renderer/src/features/settings/useSettings.ts:46-86`
subscribes synchronously in the same `useEffect`, but `initialLoad()`
is `void`-d and awaits two parallel dispatches. If a sibling window
writes during that window:

1. Subscriber fires `setSettings(event.settings)` (newer state).
2. `initialLoad` resolves with the disk read (now-older state).
3. `setSettings(oldRead)` overwrites the broadcast.

User sees pre-write state until the next event arrives. Rare, but
exactly the cross-window race the broadcast exists to solve.

## Findings

- **Severity:** P2.
- **Files:** `useSettings.ts:40-86`
- **Conditions:** two open Settings windows + simultaneous user input,
  or hotkey that mutates settings while another window opens.

## Proposed Solutions

### Option A — `loaded` ref (recommended)
```ts
const loaded = useRef(false);
// in subscriber:
loaded.current = true;
setSettings(evt.settings);
setSecrets(evt.secrets);
// in initialLoad, after Promise.all:
if (loaded.current) return;  // broadcast already populated
loaded.current = true;
setSettings(...); setSecrets(...);
```

- **Pros:** Tiny. Correct.
- **Effort:** Tiny.
- **Risk:** None.

### Option B — Replace `Promise.all + setSettings` with a single broadcast trigger
On mount, dispatch a no-op verb that just re-emits the current
broadcast. Renderer state stays purely event-driven.

- **Pros:** One state path.
- **Cons:** New verb just for this; broadcast payload must include
  secrets which today it does but adds bus surface.
- **Effort:** Small.
- **Risk:** Low.

## Recommended Action

Option A. Pairs naturally with todo #004's cleanup of optimistic sets.

## Affected Files

- `apps/desktop/src/renderer/src/features/settings/useSettings.ts`

## Acceptance Criteria

- [ ] `loaded` ref guards initial-load `setSettings` against broadcast
  arrival.
- [ ] Unit test: dispatch a fake broadcast during the `Promise.all`,
  assert hook state reflects the broadcast not the initial read.
