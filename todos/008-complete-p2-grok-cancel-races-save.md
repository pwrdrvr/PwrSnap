---
status: pending
priority: p2
issue_id: 008
tags: [code-review, frontend-races, ux]
pr: 20
agents:
  - julik-frontend-races-reviewer
---

# Grok `Save` races `Cancel`; potential double-write or silent overwrite

## Problem Statement

`apps/desktop/src/renderer/src/features/settings/pages/AIProvidersPage.tsx:376-388`
(`GrokKeyControl.submit`):

```ts
async function submit() {
  setWorking(true);
  try { await onReplace(draft); setEditing(false); setDraft(""); }
  catch (e) { setError(...); }
  finally { setWorking(false); }
}
```

User hits Cancel while the IPC is in flight. Cancel handler (line
423-427) sets `editing=false` and clears `draft` immediately. The
promise then resolves — the secret was written to safeStorage, but
the UI re-rendered without the input subtree. `setWorking(false)`
fires on the unmounted control.

**Real risk:** user types a key, network hiccups for 800ms, panics and
clicks Cancel, sees "Not set" (because Replace collapsed), pastes
again. The first key landed; the second key replaces it. If the panic
key was wrong, their next API call dies and they blame PwrSnap.

## Findings

- **Severity:** P2.
- **Files:** `AIProvidersPage.tsx` `GrokKeyControl` subcomponent
- **Failure mode:** silent secret overwrite.

## Proposed Solutions

### Option A — Disable Cancel while `working` + mounted-ref guard (recommended)
```tsx
<button ... onClick={cancel} disabled={working}>Cancel</button>
```

Plus a mounted-ref guard for the `finally` block.

- **Pros:** Tiny. UX-clear: user knows the save is in flight.
- **Cons:** None.
- **Effort:** Tiny.
- **Risk:** None.

### Option B — Abort the in-flight dispatch on Cancel
Wire an AbortSignal from Cancel through `dispatch` to the handler;
handler short-circuits if aborted.

- **Pros:** True cancellation semantics.
- **Cons:** Bus doesn't support per-request abort signals yet
  (cancellation is keyed on captureId in `command-bus.ts`). Would
  require adding renderer→main abort propagation.
- **Effort:** Medium.
- **Risk:** Medium.

## Recommended Action

Option A for v1. Revisit Option B if/when other secret-set UIs land
and abort semantics are needed.

## Affected Files

- `apps/desktop/src/renderer/src/features/settings/pages/AIProvidersPage.tsx`

## Acceptance Criteria

- [ ] Cancel button is `disabled={working}` while Save is in flight.
- [ ] `setWorking(false)` in `finally` is guarded against unmount.
- [ ] Test: simulate slow `replaceSecret`, click Cancel during —
  assert Cancel is no-op (disabled doesn't fire), the secret state
  after the Save resolves is the user's typed value.
