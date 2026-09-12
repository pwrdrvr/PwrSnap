# The startup keychain prompt came from cookie encryption, not from our secrets

**Symptom:** a copy of PwrSnap installed to `/Applications` as "PwrSnap 2"
asked for the macOS login-keychain password twice, before showing any
window, on a machine that had never given it an API key. It read exactly
like the app was rifling through the user's credentials at launch. (The
third prompt in that sequence, for a folder in Documents, was unrelated
and expected — that one is the TCC captures gate, and it carries our own
`NSDocumentsFolderUsageDescription` copy explaining why.)

The obvious suspect was `DesktopSecretStore`, which is the only thing in
`apps/desktop` that names the keychain. It was not the cause.

## What actually happened

[apps/desktop/electron-builder.yml](../../apps/desktop/electron-builder.yml)
set the `enableCookieEncryption` fuse. That fuse has two consumers inside
Electron, both gated on it:

- `shell/browser/net/network_context_service.cc` sets
  `network_context_params->enable_encrypted_cookies`.
- `shell/browser/net/system_network_context_manager.cc` calls
  `network_service->SetEncryptionKey(OSCrypt::GetRawEncryptionKey())`,
  because "the OSCrypt keys are process bound" and the network service
  runs out of process.

That second one is an **eager** key fetch, performed when the network
service starts — before `app.whenReady()` has produced a window, on every
launch. On macOS the key lives in the login keychain as a generic password
under service `"<productName> Safe Storage"`, account `"<productName> Key"`.
`OSCrypt::Init` is Windows-only in Electron
(`shell/browser/electron_browser_main_parts.cc` guards it with
`BUILDFLAG(IS_WIN)`), so the fuse is the *only* thing that makes macOS
touch the keychain at startup.

PwrSnap has no cookies for it to protect:

- every `BrowserWindow` loads `file://` (packaged) or a `data:` URL; the
  only `loadURL` to an origin is the electron-vite dev server;
- outbound HTTP from main (`auto-updater.ts`, the two OpenAI calls in
  `sizzle/`) goes through Node's global `fetch`, which is undici and has
  no Chromium cookie jar;
- nothing anywhere calls the `session.cookies` API.

Measured on the dev machine: the `Cookies` SQLite file in userData existed,
was created the day the app was first run, and contained **zero rows**. So
the fuse cost a keychain round trip at every launch and protected an empty
database.

## Why it prompts for some binaries and not others

Chromium's `KeychainPassword::GetPassword`
(`components/os_crypt/common/keychain_password_mac.mm`) does one
`SecItemCopyMatching`. On `errSecItemNotFound` it generates a random
password and adds it, silently — the creating app is on the new item's
access list. So:

- **A genuinely fresh install never prompts.** It creates the item.
  "Assume a prompt on first startup and warn about it" is therefore wrong
  in both directions: first startup is the one case that is quiet.
- **A prompt means the item already exists and the requesting binary is
  not on its access list**, which is exactly the "PwrSnap 2" case.

The dev machine's item made this concrete. `security dump-keychain -a`
showed it created by an Electron binary out of a scratch worktree, with an
ad-hoc `cdhash` requirement, and `/Applications/PwrSnap.app` present only
because someone had clicked "Always Allow". Its partition list was
`teamid:T44CNHC4UH` plus that one dev hash. A locally packaged or
ad-hoc-signed copy fails both and prompts — and prompts *again* after every
rebuild, because the code hash changes each time.

## What we changed

`enableCookieEncryption: false`, pinned by
[scripts/check-electron-fuses-policy.mjs](../../scripts/check-electron-fuses-policy.mjs),
which runs in `pnpm lint` (so on every PR) and again from `pnpm
release:check`. The gate gives every pinned fuse a reason, because this
one looks like a setting a security pass should turn *on* — and whoever
does that will not see the regression, since it only appears on a machine
where the keychain item already exists under a different binary identity.

The remaining keychain consumer is `DesktopSecretStore`, and it is now
reached only when the user saves an API key or approves an agent pairing.
Those are moments our own UI can explain before macOS asks.

## Things that cost time here, worth not re-deriving

- **There is no API to predict the prompt.** Nothing in Electron reads an
  existing keychain item's access list without triggering the very dialog
  you are trying to pre-announce, and the dialog's text is fixed by macOS.
  Unlike the TCC folder prompt, there is no `NS*UsageDescription` to write.
  A pre-prompt explanation has to be attached to the *action* the user took
  (saving a key), not to app launch.
- **`safeStorage.isEncryptionAvailable()` is not a probe.** On macOS it is
  `OSCrypt::IsEncryptionAvailable()`, and reaching the answer is what
  fetches the key.
- **`isEncryptionAvailable()` being true tells you nothing about whether
  the user was asked.** The fetch blocks on the dialog and then succeeds.
- The unified log has nothing useful under `securityd` / `SecurityAgent`
  for this; don't spend time there.

## When to revisit

Only if a `BrowserWindow` starts loading a remote origin that sets cookies
worth protecting — an embedded OAuth flow, say. At that point re-enabling
the fuse is defensible, but the startup prompt comes back with it and
should be handled deliberately rather than rediscovered. Note the fuse
docs' warning that the transition is one-way: turning it on encrypts
cookies on write, and turning it off afterwards leaves that store
unreadable. That warning is why this change was safe to make *now*, with
the cookie store measured empty, and would not be free later.

## The two follow-ups, also done here

Turning the fuse off removed the prompt at *launch*. Two smaller paths could
still reach the keychain sooner than the user would expect, and both are fixed
in the same change.

### Status reads no longer decrypt

`pwrsnap-secrets.bin` used to be one `safeStorage` ciphertext holding
`{ name: { value, lastSetAt } }`. Because the names and timestamps lived
*inside* the ciphertext, `getStatus` / `getAllStatus` had to decrypt — and
`broadcastSettingsChanged` calls `getAllStatus()` after **every** settings
write. So toggling any unrelated preference, or just opening Settings, could
be the first `safeStorage` call in the process and therefore the thing that
raised the password dialog. `clear()` made it permanent: it wrote an encrypted
empty `{}` rather than deleting the file, so once any secret had ever been
set, every status read decrypted forever.

The file is now a v2 envelope with a plaintext index and an encrypted payload:

```jsonc
{ "version": 2,
  "index": { "openaiApiKey": { "lastSetAt": "2026-..." } },
  "ciphertext": "<base64 of encryptString({ name: value })>" }
```

`getValue()` is now the only accessor that decrypts, and an emptied store
writes `"ciphertext": null` so clearing the last secret encrypts nothing.
Writing the first secret, and overwriting the only one, also skip the decrypt.

Nothing in the index is newly exposed. `SecretStatus` (the name plus
`lastSetAt`) is already broadcast to every BrowserWindow on every settings
change, and the `localAgentToken:<clientId>` ids already sit in cleartext in
`pwrsnap-settings.json` as `localAgents.grants[].id`. Values stay encrypted,
and the existing test asserting the plaintext never appears in the file still
passes.

v1 files are still read, and are rewritten as v2 on first access. That one
read has to decrypt — the names are inside the ciphertext — so an upgrading
install pays the old cost exactly once instead of forever. A v1 file that
cannot be decrypted is deliberately left alone rather than rewritten, so a
lost or denied key never turns an unreadable store into an authoritative
empty one.

One trap worth naming: the v2 payload carries values only, so a rewrite has
to stitch each surviving entry's `lastSetAt` back from the index. Miss that
and clearing one of several secrets silently blanks every other timestamp.

### E2E runs use Chromium's mock keychain

An E2E launch drives an unsigned dev Electron whose cdhash changes on every
rebuild. Any spec that exercised `safeStorage` made *that* binary open (or
create) the shared "PwrSnap Safe Storage" item, which is precisely how a
scratch-worktree binary ends up on the access list of the item the installed
app uses. It could also block mid-spec on a password dialog nobody is there to
answer.

`--use-mock-keychain` is Chromium's own answer:
`OSCryptImpl::GetKeychain()` substitutes an in-memory `FakeKeychainV2`, so
`safeStorage` still reports available and still round-trips within the
process. Verified present on the exact Chromium revision Electron 41 ships
(146.0.7680.216). Applied in
[darwin-keychain-startup-policy.ts](../../apps/desktop/src/main/darwin-keychain-startup-policy.ts),
gated on `PWRSNAP_E2E`, alongside the existing userData / documents / home
rebasing.

**It is deliberately not applied to `pnpm dev`.** `app.setName("PwrSnap")`
runs unconditionally, so a dev run shares `userData` — and therefore the same
`pwrsnap-secrets.bin` — with the installed app. A dev process on a mock
keychain would fail to read the user's real secrets and would re-encrypt them
under a key that dies with the process. Separating dev properly means giving
it its own `userData`, which moves real data and is a bigger decision than
this change.

## Adjacent, still not changed

- A decrypt failure still reads as an empty store rather than throwing, so
  `getValue` returns null and the feature degrades. That is the pre-existing
  behavior and it is right for a read.

  WRITES no longer share it. Because a write re-encrypts only what it holds,
  the pre-envelope code silently destroyed every secret it could not decrypt
  — replacing an API key under a denied keychain prompt took the user's
  paired agent tokens with it — and `clear()` returned "removed" for an entry
  that stayed on disk and came straight back as `configured` in the next
  status broadcast. The plaintext index is what finally makes that
  detectable, so `assertPayloadRecovered` compares the two and fails with
  `secret_unavailable` instead. That is recoverable (restore keychain access
  and retry); overwriting was not. Clearing the last secret and overwriting
  the only one still succeed, since neither preserves anything. A v1 file
  keeps the lenient behavior: its names live inside the ciphertext, so there
  is no way to tell "absent" from "undecryptable".
- Dev Electron still shares a keychain item with the release app, for the
  userData reason above.
