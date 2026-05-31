---
title: Settings substrate — IPC, persistence, secret store
type: solution
date: 2026-05-12
area: desktop
tags: [settings, ipc, safeStorage, atomic-write, codex-discovery, bus]
---

# Settings substrate

How the Settings surface is wired end-to-end, from the tray button to
the on-disk JSON file. Captured so the next person extending Settings
(adding a screen, a new bus verb, a new secret) doesn't re-derive
these choices.

## Topology

```
┌─────────────────────────────┐     "settings:open"     ┌────────────────────┐
│ Tray "⚙️" button             ├────────────────────────►│ command-bus        │
│ ⌘, global shortcut           │                         │ (single registry)  │
│ AI Providers / About / …    │                         └──────────┬─────────┘
└─────────────────────────────┘                                    │
        ▲                                                          ▼
        │ events:settings:changed                  ┌───────────────────────────┐
        │ (settings + secrets payload)             │ settings-handlers.ts      │
        │                                          │   • settings:open         │
┌───────┴─────────────────────┐                    │   • settings:read         │
│ useSettings() hook          │                    │   • settings:write        │
│   • dispatch reads          │                    │   • settings:refreshCodex…│
│   • subscribe to broadcast  │                    │   • settings:secretStatus │
│   • patch / refreshCodex /  │                    │   • settings:replaceSecret│
│     replaceSecret / clearSecret                  │   • settings:clearSecret  │
└─────────────────────────────┘                    └──┬───────────────┬────────┘
                                                      │               │
                                       ┌──────────────▼──┐    ┌───────▼─────────────┐
                                       │ DesktopSettings │    │ DesktopSecretStore  │
                                       │ Service         │    │  safeStorage blob   │
                                       │  pwrsnap-       │    │  pwrsnap-           │
                                       │  settings.json  │    │  secrets.bin        │
                                       └─────────────────┘    └─────────────────────┘
```

Every transport (ipcMain `cmd` today, HTTP RPC later, MCP later) flows
through one `register()` site per verb. The renderer never holds a
plaintext secret — `getValue()` is main-only and unregistered on the
bus.

## File layout

| Path | What |
|---|---|
| `apps/desktop/src/main/settings/desktop-settings-service.ts` | JSON service + legacy-shape catalog + Codex discovery cache |
| `apps/desktop/src/main/settings/desktop-secret-store.ts` | `safeStorage`-encrypted blob |
| `apps/desktop/src/main/settings/codex-discovery.ts` | Lifted Phase 0.5 — discovery + `resolveCodexCommand` |
| `apps/desktop/src/main/handlers/settings-handlers.ts` | The six (well, seven counting `settings:open`) bus handlers + the broadcast emitter |
| `apps/desktop/src/renderer/src/features/settings/useSettings.ts` | Renderer hook: read + subscribe + patch + refreshCodex + replace/clearSecret |
| `apps/desktop/src/renderer/src/features/settings/pages/*` | One file per page |
| `packages/shared/src/protocol.ts` | `Settings`, `SettingsPatch`, `SettingsPage`, `DesktopCodexDiscoverySnapshot`, secret types, command map entries |
| `packages/shared/src/ipc.ts` | `EVENT_CHANNELS.settingsChanged` + `SettingsChangedEvent` payload type |

## Persistence rules (load-bearing)

### Atomic writes — write to tmp + rename

Every persisted write goes through:

```ts
const tmp = `${filePath}.tmp`;
await fs.writeFile(tmp, body);
await fs.rename(tmp, filePath);
```

`rename` is atomic on POSIX filesystems (and good enough on APFS). A
reader either sees the prior file or the new file; never a partial.
**Never use `fs.writeFile(finalPath, ...)` directly** — a crash mid-
write would leave a corrupt JSON the user has to recover by hand.

### Legacy-shape catalog — never throw away a section

Reader keeps an ordered list of `{ shape, parse(raw) → Settings | null }`,
newest first. Today there's one entry (v1). When the shape changes:

1. Add a new `v2` entry at the top.
2. Leave the `v1` entry below it so older files still read.
3. Writes always emit the newest shape.
4. The corruption path (no shape parses) renames the file to
   `pwrsnap-settings.corrupt-<isoTimestamp>.json` and returns
   `defaultSettings()`. Never silently swallow.

This pattern is lifted from PwrAgnt's
[`docs/config-file-evolution.md`](file://~/github/PwrAgnt/docs/config-file-evolution.md).
PwrAgnt found out the hard way that monolithic startup migrations
break under downgrade; a path-based, recognize-then-normalize reader
survives version churn for free.

### Serialized writes — one-at-a-time queue

`DesktopSettingsService.write()` awaits an internal promise chain so
two parallel `patch()` calls don't interleave. Without this, a
concurrent renderer could read v1, see writeA's merged result, and
overwrite writeB's changes on disk. The queue is per-process; cross-
process locks are out of scope (single-instance is enforced
elsewhere).

### Deep-merge semantics — `undefined` ≠ `null` ≠ explicit value

`SettingsPatch` is a deep-Partial. Per-field rules:

- `undefined` (or key absent): leave the existing value alone.
- explicit value (including `""`, `0`, `false`, `null`): write it.

`exactOptionalPropertyTypes` is on in `tsconfig.base.json`, so the
type system catches accidental "I meant `undefined` but wrote
`field: undefined` explicitly" mistakes. Use `Partial<>` for the
nested objects too — don't model them as `field: T | undefined`,
which forces every patch to include every leaf.

## Secret store rules

- Encrypted at rest via `safeStorage.encryptString` / `decryptString`.
  Backing file `pwrsnap-secrets.bin` contains opaque encrypted bytes —
  unit test grep-asserts the plaintext never appears on disk.
- `safeStorage.isEncryptionAvailable() === false` (some CI / headless
  envs) → `replace()` throws a typed `SecretUnavailableError`. The
  handler layer translates to `Result<…, PwrSnapError>` with code
  `"secret_unavailable"`. **Never fall back to plaintext.** Renderer
  surfaces an inline error and the user is unblocked from setting the
  key, but no secret leaks to disk.
- `getValue()` is the only plaintext accessor and lives on the store,
  not the bus. Phase 4 Codex / Grok client calls pull it directly from
  main; the renderer never sees it.
- The known set is a `const` tuple (`["grokApiKey"]`). Adding a secret
  = appending to the tuple + extending `DesktopSettingsSecretName` in
  shared protocol.

## Codex discovery — service-cached, renderer-driven

`getCodexDiscoverySnapshot({ force })` wraps
`discoverCodexCommands()` from the lifted module with a 30-second
in-memory cache. Two reasons:

1. **Page mount cost** — AI Providers calls `refreshCodex(false)`
   on every mount; the cache keeps this snappy.
2. **Refresh control** — the page's manual "Refresh" button calls
   `refreshCodex(true)`, which bypasses the cache and re-runs
   discovery (notable on machines where the user just installed Codex
   via brew between page mounts).

The cache is per-main-process and dies with the app. No persistence.
Restart re-discovers. Intentional — discovery is cheap enough that
caching across launches is more complexity than it's worth.

The renderer computes the "Using" badge by comparing
`candidate.path === snapshot.resolvedPath`. The service-side
`resolveCodexCommand()` already does the right precedence (env >
config > path > application + version sort), so the renderer is dumb
about it.

## Broadcast — every write fires `events:settings:changed`

Payload: `{ settings: Settings; secrets: Record<DesktopSettingsSecretName, SecretStatus> }`.

Every write handler (`settings:write`, `settings:replaceSecret`,
`settings:clearSecret`) emits via `webContents.send(EVENT_CHANNELS.settingsChanged, payload)`
to every BrowserWindow after a successful write. Renderers swap state
on receipt — no second read needed.

This is why `useSettings()` doesn't poll. The hook reads once on
mount, then waits for broadcasts. Two open Settings windows stay in
sync.

## Schema growth — add a field, not a screen

To add a new field to Settings:

1. Extend `Settings` in `packages/shared/src/protocol.ts`. Add a leaf
   to the right nested object (`codex.*`, `ai.*`, `hotkeys.*`,
   `experimental.*`) or a new top-level object if it's a new area.
2. Default the new field in `defaultSettings()` (in the service).
3. Update the `v1` catalog entry to fill the field with the default
   when reading an older file that lacks it. **This is not a v2
   bump** — adding a field with a default is a forward-compatible
   change. Bump `schemaVersion` only when the shape changes in a way
   the old code can't read.
4. Surface in the renderer hook via `useSettings()` (it returns the
   whole object — no extra work).
5. Wire to a page via `<Switch>` / `<SegmentedControl>` / etc.

## When a new bus verb is needed

For a totally new operation (not a read/write/secret of existing
state), declare in `Commands` in `protocol.ts`, register in
`settings-handlers.ts`, broadcast on success if it mutates state.
Don't open `apps/desktop/src/main/ipc.ts` — that's the single
`ipcMain.handle("cmd", ...)` dispatcher, generic across all verbs.

## What this slice intentionally doesn't do

- **TOML / human-editable config.** JSON is fine for v1; the user
  isn't expected to hand-edit. Revisit if a future feature wants
  human-editable config (e.g., per-tag routing rules in Phase 4).
- **`electron-store`.** Rolled our own with this catalog pattern so
  we own corruption handling + migration.
- **Hotkey editing.** Phase 1 hotkeys are immutable in code; the UI
  is read-only. `settings.hotkeys.*` exists so the future Edit
  gesture has a place to write.
- **AI consent flow.** `settings.ai.consentAcceptedAt` is in the
  schema; the gate doesn't fire until Phase 4 ships the AI pipeline.

## Pointers

- Source plan: [docs/plans/2026-05-12-001-feat-settings-substrate-and-design-catchup-plan.md](../plans/2026-05-12-001-feat-settings-substrate-and-design-catchup-plan.md)
- Reference (not lifted): `~/github/PwrAgnt/apps/desktop/src/main/settings/desktop-settings-service.ts`,
  `desktop-secret-store.ts`, `~/github/PwrAgnt/docs/config-file-evolution.md`.
- Buildout plan back-pointer: [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](../plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md)
  §"Phase 1 — Settings screen" and §"Phase 4 — Codex discovery + Settings → AI".
