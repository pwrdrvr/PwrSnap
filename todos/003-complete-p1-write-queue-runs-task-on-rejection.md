---
status: pending
priority: p1
issue_id: 003
tags: [code-review, correctness, concurrency]
pr: 20
agents:
  - kieran-typescript-reviewer
  - code-simplicity-reviewer
---

# Write-queue `then(task, task)` runs task on both fulfillment and rejection

## Problem Statement

`desktop-settings-service.ts:252-257` and `desktop-secret-store.ts:197-203`
both serialize writes through:

```ts
const next = this.writeQueue.then(task, task);
this.writeQueue = next.then(() => undefined, () => undefined);
return next;
```

The intent (per inline comment) is "don't poison the queue if a prior
write rejected." But `then(task, task)` is the same handler in both
slots — meaning if write #1 rejects, write #2's `task` runs on the
rejected branch, ignoring write #1's failure entirely. That's roughly
the intent, but the runtime ordering is: write #2 doesn't wait for
write #1's failure to be observed before it grabs the lock and proceeds
against whatever state existed before write #1. Race window is small
but real.

The bigger problem is the double promise chain: `this.writeQueue =
next.then(() => undefined, () => undefined)` discards the actual
result, which means three concurrent writes don't strictly serialize
in the way the comment claims — they fan out two-deep before the lock
re-anchors.

## Findings

- **Severity:** P1 (correctness).
- **Files:**
  - `apps/desktop/src/main/settings/desktop-settings-service.ts:252-257`
  - `apps/desktop/src/main/settings/desktop-secret-store.ts:197-203`
- **Test gap:** the existing "serialized concurrent writes" tests pass
  because they don't include a *rejecting* write in the chain.

## Proposed Solutions

### Option A — Plain `.catch(() => undefined).then(task)` (recommended)
```ts
const next = this.writeQueue.catch(() => undefined).then(task);
this.writeQueue = next.catch(() => undefined);
return next;
```

The caller of `next` still sees rejections; the queue itself only ever
holds a resolved baton. Simple and correct.

- **Pros:** Two-line fix. Provably serializes.
- **Cons:** None.
- **Effort:** Tiny.
- **Risk:** None.

### Option B — Explicit Mutex/Semaphore class
Pull in or write a small `Mutex` helper.

- **Pros:** Reusable for future queues.
- **Cons:** Over-engineering for two call sites.
- **Effort:** Medium.
- **Risk:** Low.

## Recommended Action

Option A. Add a regression test that interleaves a rejecting write
with two successful writes and asserts each was applied in order
exactly once.

## Affected Files

- `apps/desktop/src/main/settings/desktop-settings-service.ts`
- `apps/desktop/src/main/settings/desktop-secret-store.ts`

## Acceptance Criteria

- [ ] Both queue sites use `.catch(() => undefined).then(task)`.
- [ ] New test: three queued writes where the middle one rejects;
  assert first and third both apply, second's rejection bubbles
  to its caller only.
- [ ] Existing concurrent-write tests still pass.
