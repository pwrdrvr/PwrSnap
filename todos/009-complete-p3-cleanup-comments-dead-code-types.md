---
status: pending
priority: p3
issue_id: 009
tags: [code-review, simplicity, types, hygiene]
pr: 20
agents:
  - kieran-typescript-reviewer
  - code-simplicity-reviewer
---

# Cleanup pass — WHAT-comments, dead surface, type tidying

## Problem Statement

Collected P3 hygiene items from multiple reviewers. Each is small; they
land cleanly as one cleanup PR after the P1/P2 work.

## Findings

### Dead surface

- `SwitchRow` (`components/Switch.tsx:29-42`) — no callers anywhere
  (grep confirmed). Delete.
- `secrets.getFilePath()` (`desktop-secret-store.ts:56-58`) — no
  callers. Delete.
- `secrets.getValue()` (`desktop-secret-store.ts:119-130`) — Phase 4
  consumer, but currently dead. **Keep** per architecture-strategist's
  call: Phase 4 contract, two LOC, removing creates churn.
- No-op marker block `void ((): void => {})()` in
  `settings-handlers.ts:248-250`. Delete.
- `void loading;` in `HotkeysPage.tsx:85` — just don't destructure
  `loading`.

### Type tidying

- `Settings.hotkeys.* | null` arm is dead
  (`packages/shared/src/protocol.ts:131-136`). `Partial<>` already
  encodes "leave alone." Drop `| null`.
- `mergeSection`'s `as`-casts in `desktop-settings-service.ts:382-388`
  — replace with per-section explicit mergers (only four sections).
- `KNOWN_SECRET_NAMES satisfies` (`desktop-secret-store.ts:32`) doesn't
  guarantee exhaustiveness. Replace with a `Record<DesktopSettingsSecretName, true>`-keyed
  array, or add a compile-time exhaustiveness test.
- `SecretMap` re-assert in `useSettings.ts:122-123, 137-138` — drop
  `as SecretMap`.
- `vi.mock("electron")` in `settings-handlers.test.ts:37-50` is
  untyped. Type it: `vi.mock("electron", (): Partial<typeof import("electron")> => ({...}))`.

### React conventions

- `AIProvidersPage.tsx:52-63`: lock down the `refreshCodex` effect dep.
  Either `[]` with eslint-disable + WHY-comment, or strip the dep.
- `useSettings.ts:44, 75, 83`: `mountedRef` is redundant with
  `cancelled` + `unsubscribe`. Remove.

### WHAT-comments to delete

Heavy throughout. Repo convention: "default to writing no comments;
only WHY-comments survive." Trim:
- `desktop-settings-service.ts:1-23, 43-46, 161-167, 178, 365-366`
- `desktop-secret-store.ts:1-15, 25-31, 60-61, 67-69, 79-83, 101-106, 118-125`
- `settings-handlers.ts:1-18, 40-47, 68-73, 246-250`
- `useSettings.ts:1-12`
- `components/*.tsx:1-6` headers (every primitive opens with 3-6 lines
  of "this is a primitive that does X mirrored from design line Y").

**Keep** the WHY-comments: setMinimumSize(0,0) class, atomic-write
rationale, cache-TTL rationale, "plaintext never crosses IPC" notes,
`mergeSection` undefined-vs-present semantics, the "Phase 4 wires the
real test" eslint-disable rationale.

### Optional minor simplifications

- `CodexCandidates` (`AIProvidersPage.tsx:279-307`) has two near-
  identical "no candidate" branches differing only in icon/primary
  text. Collapse to one branch with a derived message.
- `ExperimentalPage.tsx:36-42` spread-conditional for
  `exactOptionalPropertyTypes` — pass `onChange={ready ? handler : undefined}`
  after relaxing the `Switch` prop typing.
- `resolveUsing` helper (`AIProvidersPage.tsx:549-552`) extracted just
  to be testable. Inline back; drop the unit test.

### NOT a finding (deliberate)

- `SHAPE_CATALOG` with one entry today: legacy-shape catalog is a
  load-bearing pattern lifted from PwrAgnt's `config-file-evolution.md`.
  Solution doc (`docs/solutions/2026-05-12-settings-substrate.md`)
  codifies it. The reviewer flagged it as YAGNI; the plan disagrees.
  Keep.

## Recommended Action

One follow-up cleanup PR after P1/P2 work lands. Estimated ~250 LOC
reduction.

## Affected Files

See findings above. Broad sweep across settings/, components/, pages/.

## Acceptance Criteria

- [ ] Dead exports removed (`SwitchRow`, `getFilePath`, marker block).
- [ ] `Settings.hotkeys` no longer carries `| null`.
- [ ] `SHAPE_CATALOG` retained (deliberate); `getValue` retained.
- [ ] WHAT-comments trimmed; WHY-comments retained.
- [ ] `pnpm typecheck` + `pnpm test` green.
