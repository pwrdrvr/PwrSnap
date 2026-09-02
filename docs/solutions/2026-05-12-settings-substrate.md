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
                                       │ Store           │    │  safeStorage blob   │
                                       │  snapshot +     │    │  pwrsnap-           │
                                       │  discovery      │    │  secrets.bin        │
                                       └───────┬─────────┘    └─────────────────────┘
                                               │ internal only
                                       ┌───────▼─────────┐
                                       │ SettingsService │
                                       │ JSON persistence│
                                       └─────────────────┘
```

Every transport (ipcMain `cmd` today, HTTP RPC later, MCP later) flows
through one `register()` site per verb. The renderer never holds a
plaintext secret — `getValue()` is main-only and unregistered on the
bus.

## File layout

| Path | What |
|---|---|
| `apps/desktop/src/main/settings/desktop-settings-service.ts` | Internal JSON persistence, immutable snapshot, migrations, quarantine, atomic write queue |
| `apps/desktop/src/main/settings/desktop-settings-store.ts` | Sole production config owner, domain reads/subscriptions, and Codex/ACP discovery publications |
| `apps/desktop/src/main/settings/desktop-secret-store.ts` | `safeStorage`-encrypted blob |
| `apps/desktop/src/main/settings/codex-discovery.ts` | Lifted Phase 0.5 — discovery + `resolveCodexCommand` |
| `apps/desktop/src/main/handlers/settings-handlers.ts` | The six (well, seven counting `settings:open`) bus handlers + the broadcast emitter |
| `apps/desktop/src/renderer/src/features/settings/useSettings.ts` | Renderer hook: read + subscribe + patch + refreshCodex + replace/clearSecret |
| `apps/desktop/src/renderer/src/features/settings/pages/*` | One file per page |
| `packages/shared/src/protocol.ts` | `Settings`, `SettingsPatch`, `SettingsPage`, `DesktopCodexDiscoverySnapshot`, secret types, command map entries |
| `packages/shared/src/ipc.ts` | `EVENT_CHANNELS.settingsChanged` + `SettingsChangedEvent` payload type |

## Persistence rules (load-bearing)

### Hydrate once — hot-path reads use the process snapshot

`getDesktopSettingsStore()` owns one `DesktopSettingsStore` per Electron main
process. Its internal `DesktopSettingsService` is the raw persistence adapter;
production modules are forbidden to import it. The normal startup
storage-location read is the hydration
boundary. Concurrent cold readers coalesce; after hydration, `read()` returns
the same deeply frozen snapshot without opening or parsing
`pwrsnap-settings.json`. Do not construct private production service instances.

`write()` serializes against other mutations, persists atomically, and replaces
the snapshot only after rename succeeds. There is no callable production reload
API: app restart is the boundary for a deliberate out-of-process file edit.
`ENOENT` hydrates defaults for a genuine first launch. Any other read error
rejects and leaves the store unhydrated, so later reads retry and no write can
replace a valid-but-temporarily-unreadable file with defaults plus one patch.
In split mode the Library process adopts the agent's trusted
`events:settings:changed` snapshot so synchronous menu/BrowserWindow consumers
stay current without a file read. Secret plaintext remains outside this store.

`pnpm settings-store:check` is part of `pnpm lint`. It rejects production raw
persistence/discovery imports, direct settings-file references, secondary store
instances, process-role peek reuse, direct binary version probes, peer-snapshot
adoption outside the split relay, and live discovery/test/profile probe
entrypoints outside the explicit Settings handlers. Codex thread-config
selection uses the version already published by store-owned discovery instead
of maintaining a second per-command `--version` cache. This is intentionally
stricter than relying on comments or API naming to keep a future hot path cheap.

The one synchronous exception is process-role resolution's narrow peek of
`experimental.processSplit`: the role is needed before `app.whenReady()`. An
exceptional pre-hydration BrowserWindow uses the system-theme default instead
of opening and parsing the file behind the store. A source-boundary test fails
on any new raw service import or raw settings reader.

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

`DesktopSettingsStore.write()` delegates to the persistence adapter's internal
promise chain so
two parallel `patch()` calls don't interleave. Without this, a
concurrent renderer could merge from the same snapshot and overwrite the
other patch's changes on disk. The queue is per-process; cross-
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

## Installed-agent discovery — store-owned, targeted, single-flight

The store is also the sole production owner of
`discoverCodexCommands()` and `discoverLocalAcpAgentInstances()`. This is an
event-driven publication, not a short TTL:

- Codex keys include configured command, platform/architecture, and relevant
  executable-search environment. Settings, startup, profiles, and runtime
  compatibility checks share the same raw discovery publication; the UI auth
  projection is layered on it without starting a second command scan.
- ACP keys are per provider. Settings' all-provider install scan fills those
  provider rows once; Library, Float-Over, chat, model listing, and capture
  enrichment then reuse the matching row. Changing one provider override
  causes the next read to probe only that provider.
- Concurrent same-key reads or explicit refreshes share one in-flight job.
  Successful rows remain last-known-good if a later explicit refresh fails.
- Automatic startup/UI reads never force. The Settings Refresh button is the
  explicit `force: true` boundary; a process restart is the other revalidation
  boundary. Ordinary settings writes do no discovery.

The renderer still computes the Codex "Using" badge by comparing
`candidate.path === snapshot.resolvedPath`. ACP active-instance mapping is pure
over the stored groups plus the current `selectedPath`, so changing a selection
does not rescan PATH.

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
