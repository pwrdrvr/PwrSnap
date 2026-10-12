# Agent rules: Settings substrate

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Settings substrate — every setting + secret goes through one place

**All user-configurable state lives in `DesktopSettingsService` +
`DesktopSecretStore` and travels over the command bus. Don't open a
new IPC channel, don't write a sibling JSON file, don't keep a
plaintext secret on disk.**

Implementation:
[apps/desktop/src/main/settings/desktop-settings-service.ts](../../apps/desktop/src/main/settings/desktop-settings-service.ts) +
[apps/desktop/src/main/settings/desktop-settings-store.ts](../../apps/desktop/src/main/settings/desktop-settings-store.ts) +
[apps/desktop/src/main/settings/desktop-secret-store.ts](../../apps/desktop/src/main/settings/desktop-secret-store.ts) +
[apps/desktop/src/main/handlers/settings-handlers.ts](../../apps/desktop/src/main/handlers/settings-handlers.ts).
Architecture notes:
[docs/solutions/2026-05-12-settings-substrate.md](../../docs/solutions/2026-05-12-settings-substrate.md).

Rules:

- **Single schema in shared.** `Settings` and `SettingsPatch` live in
  [packages/shared/src/protocol.ts](../../packages/shared/src/protocol.ts).
  Renderer + main both import from `@pwrsnap/shared`. **Never
  re-declare** a Settings shape elsewhere.
- **Adding a field is a one-line change.** Extend the right nested
  object (`codex.*`, `ai.*`, `hotkeys.*`, `experimental.*`, etc.), give
  it a default in `defaultSettings()`, fill it from older files in
  `parseV1`. **Don't bump `schemaVersion` for additive changes** —
  bump only when the on-disk shape changes incompatibly. The legacy-
  shape catalog in the service exists for that case; it must remain
  ordered newest-first and corruption must quarantine to
  `pwrsnap-settings.corrupt-<iso>.json` (never silently swallow).
- **Atomic write.** Service writes through `writeFile(tmp) → rename`.
  Never `fs.writeFile` to the final path directly — a crash mid-write
  corrupts the file. Same rule for `pwrsnap-secrets.bin`.
- **One immutable settings snapshot per main process.** Every production
  consumer gets `getDesktopSettingsStore()`; only
  `desktop-settings-store.ts` may import the raw
  `DesktopSettingsService`. The first startup read hydrates + freezes one
  snapshot, concurrent cold reads coalesce, and hot-path `read()` calls never
  reopen or reparse `pwrsnap-settings.json`. Successful writes replace the
  snapshot only after the atomic rename. There is deliberately no callable
  production reload API: app restart is the boundary for an out-of-process
  file edit, while split-mode Library adopts the agent's trusted
  `events:settings:changed` snapshot.
  A non-`ENOENT` hydration error leaves the store empty and rejects; never
  promote fallback defaults into a writable snapshot when a valid settings
  file may only be temporarily unreadable.
  Neither mechanism caches secret plaintext. The synchronous process-role
  peek is the sole raw-read exception because role resolution precedes
  `app.whenReady()`; a pre-hydration BrowserWindow uses the system-theme
  default rather than parsing the file behind the store.
- **Serialized writes.** `DesktopSettingsStore.write()` delegates to the
  internal persistence queue so two concurrent renderer patches don't
  interleave snapshot updates. Use the same pattern in `DesktopSecretStore`. The
  queue uses `.catch(() => undefined).then(task)` so a rejected write
  doesn't run the next task on the rejection branch.
- **Broadcast on every write.** Every successful settings or secret
  write emits `events:settings:changed` with payload
  `{ settings, secrets: Record<DesktopSettingsSecretName, SecretStatus> }`
  to every BrowserWindow. The renderer hook reads once on mount, then
  waits for broadcasts — no polling.
- **`undefined` ≠ `null` ≠ `""`.** `SettingsPatch` is a deep-Partial.
  `undefined` / missing key = leave alone. Explicit value (including
  `false`, `0`, `""`, `null` where the type allows) = write.
  `exactOptionalPropertyTypes` enforces.
- **All secrets via `safeStorage`.** Plaintext credentials are never returned over IPC. A write-only API-key
  input may cross renderer → main once for secure persistence. The renderer only ever sees `SecretStatus = { configured,
  lastSetAt }`. `DesktopSecretStore.getValue()` is the only plaintext
  accessor and is main-only — **never register it on the bus.** Use the
  async Electron API. `isAsyncEncryptionAvailable()` reports encryptor
  initialization and can resolve true without a usable key. The store
  refuses the Linux `basic_text` backend and refuses to write Linux
  ciphertext tagged `v10`, which uses Chromium's built-in key. Storage
  unavailability is reported as `SecretUnavailableError`, mapped by the
  handler to `kind: "settings", code: "secret_unavailable"`. **Never fall
  back to plaintext.** A unit test checks that plaintext never appears in
  `pwrsnap-secrets.bin`.
  The legacy KWallet reader is the only exception to the async API rule.
  When async decryption cannot read Linux `v11` ciphertext on a KWallet
  backend, the store can use Electron's legacy reader to migrate the old
  wallet entry. All encryption uses the async API.
- **`getValue()` is the ONLY read allowed to decrypt.** On macOS the first
  `safeStorage` call in a process is what can raise the login-keychain
  password dialog, so a status read that decrypts turns "user toggled a
  preference" into "macOS asked for your password" — `broadcastSettingsChanged`
  calls `getAllStatus()` after every settings write. `pwrsnap-secrets.bin` is
  therefore a v2 envelope: a PLAINTEXT `index` of `{ name: { lastSetAt } }`
  next to one encrypted `ciphertext` of `{ name: value }`. Status reads touch
  only the index; an emptied store writes `"ciphertext": null` so clearing the
  last secret encrypts nothing. Do not move status metadata back inside the
  ciphertext, and do not add a new caller of `getValue()` on a path that runs
  without the user having asked for a secret-backed feature. Nothing in the
  index is newly exposed — `SecretStatus` is already broadcast to every
  window, and the `localAgentToken:<clientId>` ids are already cleartext in
  `pwrsnap-settings.json` as `localAgents.grants[].id`. v1 files (one bare
  ciphertext) are still read and rewritten as v2 on first access; an
  undecryptable v1 file is left alone rather than rewritten empty. A rewrite
  must stitch `lastSetAt` back from the index — the payload carries values
  only, so forgetting blanks every surviving timestamp.
  Availability checks initialize the async encryptor and can fetch the
  keychain key, so v2 status reads must avoid them too. When
  `decryptStringAsync()` reports `shouldReEncrypt`, `getValue()` queues a
  rewrite under the current key through the same write queue.
- **E2E runs must not touch the real login keychain.**
  [darwin-keychain-startup-policy.ts](../../apps/desktop/src/main/darwin-keychain-startup-policy.ts)
  appends Chromium's `--use-mock-keychain` under `PWRSNAP_E2E`, so an unsigned
  dev Electron never registers its rebuild-varying cdhash on the access list of
  the item the installed app uses, and never blocks a spec on a password
  dialog. It is deliberately NOT applied to `pnpm dev`: `app.setName` is
  unconditional, so dev shares `userData` — and `pwrsnap-secrets.bin` — with
  the installed app and must share its key.
- **Linux picks its secret store from the session bus, once.** Chromium can
  select `basic_text` on desktops it does not recognize.
  [linux-password-store.ts](../../apps/desktop/src/main/linux-password-store.ts)
  probes the session bus after ready, remembers the selected store in
  `<userData>/linux-password-store`, and relaunches with `--password-store`.
  Later launches append that switch before ready.
  - Decide from `getSelectedStorageBackend()`. Availability checks can
    fetch the keyring key and must stay off the startup path.
  - Preserve an active secure backend, a remembered selection, and an
    operator's `--password-store` or `PWRSNAP_LINUX_PASSWORD_STORE` override.
    A different backend can leave existing credentials unreadable.
  - The remembered selection is a plain startup file. Chromium needs it
    before ready, and renderers cannot change it.
  - E2E skips selection and relaunch.
- **Validate at the bus boundary.** Per-verb validators in
  [apps/desktop/src/main/handlers/settings-validators.ts](../../apps/desktop/src/main/handlers/settings-validators.ts)
  reject unknown secret names, oversize values (>64KB), unknown
  `SettingsPage`, `null` over non-nullable string fields, etc. Add a
  validator when you add a verb.
- **Renderer reads via context, not the hook directly.** `useSettings`
  is called once at the `SettingsApp` root and provided via
  `SettingsContext`. Pages use `useSettingsContext()`. One subscriber,
  one initial fetch per window.
- **Late resolutions are dropped.** `patch / refreshCodex /
  replaceSecret / clearSecret` each carry a monotonic `seq` ref —
  a stale dispatch's resolution doesn't clobber a newer call's state.
  Mirror the pattern if you add a new mutating callback.
- **Window-to-renderer navigation goes through a typed event channel,
  never `executeJavaScript`.** Use `EVENT_CHANNELS.settingsNavigate`
  (or add a new channel) — string interpolation into renderer JS is a
  sandbox crack.
- **Installed-agent discovery is store-owned and event-driven.** Only
  `desktop-settings-store.ts` may import `discoverCodexCommands` or
  `discoverLocalAcpAgentInstances`. Codex publications are keyed by command +
  relevant environment; ACP publications are keyed per provider by enablement,
  override, platform, architecture, and PATH inputs. Automatic reads from
  Library, Float-Over, Settings, chat, model listing, runtime launch, and
  capture enrichment reuse those immutable publications. Same-key concurrent
  refreshes are single-flight. A settings dependency change invalidates only
  its fingerprint; an explicit Refresh passes `force: true`. Never reintroduce
  a TTL/focus-triggered machine scan or direct discovery fallback outside the
  store. In experimental process-split mode, the agent process relays refreshed
  publications over the main-only discovery channel and Library adopts them
  only under a matching dependency fingerprint; do not send raw publications
  to renderer windows or make Library re-probe after Settings Refresh. The
  source-boundary test pins these rules.
- **The lint boundary is executable policy.**
  `pnpm settings-store:check` runs inside `pnpm lint` and rejects production
  imports of raw settings persistence or Codex/ACP discovery, direct references
  to `pwrsnap-settings.json`, extra store construction, reuse of the synchronous
  process-role peek, direct binary version probes, trusted peer-snapshot adoption
  outside the split relay, discovery-publication export/adoption outside the
  split Settings relay, or live refresh/test/profile probes outside their
  explicit Settings handlers. Thread-config selection consumes the Codex
  version already published by the store; it never launches its own `--version`.
  Do not weaken the allowlist to make a new call site compile; add a cached
  store operation or establish a genuinely explicit boundary instead.

What this substrate is **not for**: ephemeral renderer state (sidebar
expanded/collapsed, last-selected capture id), per-capture metadata
(belongs in SQLite + overlays), workspace-scoped caches (belongs in a
per-workspace cache table). When in doubt: if the value should
survive a relaunch *and* a renderer can change it, it belongs in
Settings. If a renderer reads it once and discards on close, it
doesn't.
