---
status: pending
priority: p1
issue_id: 002
tags: [code-review, security, ipc, validation]
pr: 20
agents:
  - security-sentinel
  - kieran-typescript-reviewer
---

# IPC input validation missing for `settings:*` request shapes

## Problem Statement

The bus passes `req` straight through with a TypeScript cast; the
renderer (and tomorrow's HTTP/MCP transports) are trusted blindly.

Specific holes:

1. **`settings:replaceSecret`** (`settings-handlers.ts:202-223`) —
   `req.name` is forwarded to `secrets.replace(name, value)` without
   checking `name ∈ KNOWN_SECRET_NAMES`. A renderer can pass any string
   and write a `StoredSecret` under any key. The on-disk projection
   filters unknown names on read (`desktop-secret-store.ts:160-165`)
   so the entry is silently discarded next time — but the encrypted
   blob still carries attacker-controlled JSON keys until cleared, and
   any future iteration over the raw object inherits the bad data.

2. **`req.value` in `settings:replaceSecret` is unbounded** — a 100MB
   string is happily encrypted and written. DoS via disk space + slow
   `safeStorage` calls.

3. **`settings:write`** (`settings-handlers.ts:149-167`) trusts the
   patch shape. `desktop-settings-service.ts:377-389` (`mergeSection`)
   iterates `Object.keys(patch)` and skips only `value === undefined`.
   Under `exactOptionalPropertyTypes` the type says `undefined` is
   impossible, but JSON across IPC happily delivers `{ codex: { mode:
   undefined } }`. Worse: `pickStringOrNull` accepts `null` for
   nullable fields, but a renderer that dispatches
   `{ codex: { pinnedPath: null } }` would write `null` over a
   non-nullable `string` field.

4. **`req.force` in `settings:refreshCodexDiscovery` and `req.page` in
   `settings:open`** are not validated as boolean / page-id respectively.

## Findings

- **Severity:** P1.
- **Files:**
  - `apps/desktop/src/main/handlers/settings-handlers.ts:149-243`
  - `apps/desktop/src/main/settings/desktop-settings-service.ts:377-389`
  - `apps/desktop/src/main/settings/desktop-secret-store.ts:161-165`

## Proposed Solutions

### Option A — Per-verb hand-rolled validators (recommended for v1)
Each handler runs a small guard before touching the service:

```ts
bus.register("settings:replaceSecret", async (req) => {
  if (!KNOWN_SECRET_NAMES.includes(req.name as DesktopSettingsSecretName)) {
    return err({ kind: "validation", code: "invalid_secret_name", message: ... });
  }
  if (typeof req.value !== "string" || req.value.length > 64 * 1024) {
    return err({ kind: "validation", code: "invalid_secret_value", message: ... });
  }
  // ... existing logic
});
```

Similar guards for `settings:write` (per-section validator that rejects
`null` over non-nullable fields), `settings:open` (page-id allowlist),
`settings:refreshCodexDiscovery` (boolean check).

- **Pros:** Surgical, fits the existing Result envelope, no new deps.
- **Cons:** Hand-rolled validators duplicate type information.
- **Effort:** Small (~80 LOC).
- **Risk:** Low.

### Option B — Add zod schemas in `@pwrsnap/shared` and parse at handler entry
Already a dep (`zod ^4.0.0` in shared package). Generate from the
existing types, parse `req` before the handler body.

- **Pros:** Single source of validation, scales to future verbs.
- **Cons:** Pulls zod into main bundle if not already there; doubles
  the schema declaration surface.
- **Effort:** Medium.
- **Risk:** Low.

## Recommended Action

Option A for this PR (matches the codebase's current "no validation
library" stance). Revisit zod when the third or fourth verb needs the
same treatment.

## Affected Files

- `apps/desktop/src/main/handlers/settings-handlers.ts`
- `apps/desktop/src/main/settings/desktop-settings-service.ts` (mergeSection
  rejects `null` over non-nullable strings)

## Acceptance Criteria

- [ ] `settings:replaceSecret` rejects unknown names + values >64KB with
  a `Result.err` of `kind: "validation"`.
- [ ] `settings:write` rejects patches with `null` over non-nullable
  string fields.
- [ ] `settings:open` rejects unknown page ids.
- [ ] `settings:refreshCodexDiscovery` rejects non-boolean `force`.
- [ ] One test per validation path. Renderer test that simulates a
  malformed dispatch + asserts `err`.
