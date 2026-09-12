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

## Adjacent, deliberately not changed

- `DesktopSecretStore.clear()` writes an encrypted empty `{}` rather than
  deleting the file, so once any secret has ever been set, every
  `settings:secretStatus` read decrypts. Names and timestamps are not
  secret, so the status map could live outside the ciphertext and leave
  `getValue()` as the only keychain consumer. Not done here; it is a
  behavior change to the secrets file format.
- Dev Electron and the release app share one keychain item because
  `app.setName(APP_NAME)` runs before anything else in bootstrap. Giving
  dev builds a distinct name (or `--use-mock-keychain` under E2E) would
  keep scratch-worktree code hashes off the installed app's access list,
  which is how the dev machine's item ended up in the state described
  above.
