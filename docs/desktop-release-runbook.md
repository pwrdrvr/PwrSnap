# Desktop Release Runbook

> MIT-licensed (see [LICENSE](../LICENSE)). Copyright © 2026 PwrDrvr LLC.
>
> Origin: [docs/plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md](plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md)

This runbook covers cutting v0.x and v1.x desktop releases. macOS releases
ship as universal Apple Silicon + Intel binaries; distribution is outside
the Mac App Store via signed/notarized DMG with auto-update through
`electron-updater` against the `pwrdrvr/PwrSnap` repo. Cross-
platform (Windows / Linux) is deferred to Phase 8.

All CI-published GitHub Releases are created as **Pre-release** entries by
default, even when the version string has no prerelease suffix. Promotion to
Latest is a separate operator action after the build, assets, updater metadata,
and smoke checks are validated.

---

## One-time setup

These steps need to happen exactly once. They are tracked in the v0.0.1
release infrastructure plan.

1. **Apple Developer Program enrollment** for PwrDrvr LLC.
   - Already done. Team ID: **`T44CNHC4UH`**. Team Name: `PwrDrvr LLC`.
   - **Same team / cert / API key as PwrAgnt** — the Developer ID Application
     certificate signs anything under `PwrDrvr LLC (T44CNHC4UH)`, and the
     App Store Connect API key (Developer access level) can notarize any app
     under the team. Only the bundle id differs (`com.pwrdrvr.pwrsnap` vs
     `com.pwrdrvr.pwragent`), and that lives in `electron-builder.yml`.
2. **Developer ID Application certificate**.
   - Generated in Apple Developer portal → Certificates.
   - Imported into the dev Mac's Keychain.
   - Verify with:
     ```bash
     security find-identity -v -p codesigning
     # expect exactly: "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)"
     ```
   - Exported as a password-protected `.p12` and stored in 1Password.
3. **App Store Connect API key** for notarization.
   - Created in App Store Connect → Users and Access → Integrations → Keys
     with the **Developer** role (least privilege that can notarize).
   - Downloaded the `.p8` file (one-time).
   - Stored in 1Password alongside the Key ID and Issuer ID.
4. **GitHub `apple-signing` Environment**.
   - Create the `apple-signing` environment in `pwrdrvr/PwrSnap`.
   - Add required reviewers and limit approval to **`huntharo`**.
   - Limit the environment to protected release refs/tags (deployment
     branches and tags policy → "Selected" → `v*`) so approval can only
     release a real version tag.
   - Store the Apple signing/notarization secrets on this environment, NOT
     as repository secrets:
     - `CSC_LINK` — `.p12` base64-encoded
     - `CSC_KEY_PASSWORD` — the `.p12` password
     - `APPLE_API_KEY_BASE64` — `.p8` base64-encoded
     - `APPLE_API_KEY_ID` — the Key ID
     - `APPLE_API_ISSUER` — the Issuer ID
     - `FFMPEG_BUILDS_APP_PRIVATE_KEY` — the full PEM private key for the
       read-only FFmpeg build GitHub App
   - Store the non-secret FFmpeg GitHub App Client ID as an environment
     variable:
     - `FFMPEG_BUILDS_APP_CLIENT_ID`
   - The FFmpeg GitHub App must be installed on
     `pwrdrvr/pwrsnap-ffmpeg-builds` with read-only Actions and Contents
     permissions. The signing job uses the one-hour installation token only
     to download the pinned `ffmpeg-8.1.1-macos-universal` artifact.
   - Optional publish secret, also environment-scoped if used:
     `RELEASES_PAT` — fine-grained PAT scoped to `Contents: Read & Write` on
     `pwrdrvr/PwrSnap`. The workflow falls back to `GITHUB_TOKEN` if absent.

   To migrate the existing repo-level secrets into the environment, run
   from your workstation (the `--env apple-signing` flag is what scopes the
   secret to the environment):

   ```bash
   base64 -i ~/Desktop/PwrDrvr-certs/PwrDrvr_DevID_Application.p12 \
     | tr -d '\n' \
     | gh secret set CSC_LINK --repo pwrdrvr/PwrSnap --env apple-signing

   base64 -i ~/Desktop/PwrDrvr-certs/AuthKey_6P2U2WMN9U.p8 \
     | tr -d '\n' \
     | gh secret set APPLE_API_KEY_BASE64 --repo pwrdrvr/PwrSnap --env apple-signing

   gh secret set CSC_KEY_PASSWORD --repo pwrdrvr/PwrSnap --env apple-signing
   gh secret set APPLE_API_KEY_ID  --repo pwrdrvr/PwrSnap --env apple-signing
   gh secret set APPLE_API_ISSUER  --repo pwrdrvr/PwrSnap --env apple-signing
   ```

   Then delete the repo-level copies so the prepare job (which runs without
   environment gating) cannot reach them:

   ```bash
   for s in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY_BASE64 \
            APPLE_API_KEY_ID APPLE_API_ISSUER; do
     gh secret delete "$s" --repo pwrdrvr/PwrSnap
   done
   ```

5. **GitHub repository secrets**.
   - Do **not** keep Apple signing/notarization material as repository secrets
     after the `apple-signing` environment secrets are configured.
   - Non-release CI secrets (e.g. live smoke-test service keys) may remain at
     the repo level if their workflows require them.

`APPLE_TEAM_ID` is hardcoded in `.github/workflows/release.yml` to `T44CNHC4UH`
since it is not a secret.

---

## Cutting a release (CI path — preferred)

```bash
# 1. Bump the version. Use semver pre-release tags during alpha/beta:
pnpm --filter @pwrsnap/desktop version 0.0.1-alpha.1

# 2. Push the tag (the version command commits and tags automatically).
git push --follow-tags
```

The `Release Desktop (macOS universal)` workflow on `macos-15` runs as two
separate jobs so Apple signing/notarization secrets are never present on a
runner that executes untrusted dependency or build code:

1. **`Test and prepare signing input`** — `contents: read`, explicit
   `id-token: none`, checkout with `persist-credentials: false`, no Apple
   secrets. Installs dependencies, runs `release:check` (tag/version/
   changelog gate) → `typecheck` → `test` →
   `PWRSNAP_SKIP_FFMPEG_BUILD=1 apps/desktop/scripts/release.mjs --prepare-only`.
   Archives the prepared stage plus the already-resolved `electron-builder`
   toolchain into the `desktop-release-signing-input` workflow artifact and
   emits its SHA-256 as a job output.
2. **`Sign, notarize, publish`** — gated by the protected `apple-signing`
   environment, with `contents: write` and explicit `id-token: none`. Does
   not check out the repository or run `pnpm install` / postinstall
   lifecycle scripts. Downloads the prepared artifact, verifies the
   SHA-256 against the prepare-job output, expands it, and runs
   `apps/desktop/scripts/release.mjs --sign-stage-only` with the
   environment-scoped Apple secrets. Before packaging, it mints a scoped
   FFmpeg build-repo installation token, downloads the pinned
   `ffmpeg-8.1.1-macos-universal` artifact, verifies `manifest.json` and the
   binary SHA-256, then stages the binary and LGPL source evidence under
   `apps/desktop/release-stage/build/`.

The Windows release job is gated by the protected `windows-signing`
environment. By default it requires `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD`, then runs `package-win.mjs --publish` so
electron-builder publishes the signed NSIS installer and updater metadata. If
the signing certificate is not ready, set the `windows-signing` environment
variable `WINDOWS_UNSIGNED_RELEASE=true`. That temporary mode still verifies
the controlled Windows FFmpeg artifact, runs `package-win.mjs
--unsigned-release`, and uploads only a manually named
`*-unsigned-setup.exe` asset. It intentionally does not upload `latest.yml`, so
unsigned builds are not offered through the Windows updater feed.

The no-secret prepare job:

1. Runs `pnpm licenses:check` so stale `THIRD_PARTY_LICENSES` or package
   license-policy drift stops the release before packaging.
2. Builds the Swift native helpers (`PwrSnapWindowList`) as a universal
   binary.
3. Skips the local FFmpeg compile; the protected signing job injects the
   controlled artifact.
4. Builds main/preload/renderer with electron-vite.
5. Runs `pnpm deploy --prod` to materialize a flat `node_modules` tree under
   `apps/desktop/release-stage/`.
6. Rebuilds the staged `better-sqlite3` for the packaged Electron ABI
   (universal) under `electron-native/`.
7. Seeds the stage with `out/` + `build/` + `electron-builder.yml` +
   `.npmrc` + `THIRD_PARTY_LICENSES` + `CHANGELOG.md`.
8. Archives `apps/desktop/release-stage/` plus the resolved
   `apps/desktop/node_modules` (electron-builder + electron-vite),
   `apps/desktop/electron-builder.yml`,
   `apps/desktop/scripts/{release,verify-asar-contents,rebuild-native-for-electron}.mjs`,
   the root `node_modules`, and the workspace lockfile/config, then uploads
   them with a SHA-256 digest.

The environment-gated signing job:

1. Verifies the prepared-artifact SHA-256 against the prepare-job output
   before extracting it.
2. Decodes `APPLE_API_KEY_BASE64` and `CSC_LINK` (if base64) into temp
   files (mode 0600) and re-exports `APPLE_API_KEY` / `CSC_LINK` as paths.
3. Runs `electron-builder --mac --universal --publish always` from the
   downloaded artifact, by invoking the staged
   `node_modules/electron-builder/cli.js` directly through `node`. No
   `pnpm install`, no `npx`, no dependency lifecycle scripts.
   `electron-builder` signs every helper bundle individually, signs the
   main `.app`, submits to Apple's notarization service via `notarytool`,
   staples the ticket, builds the universal DMG + updater ZIP, generates
   `latest-mac.yml`, and uploads everything to a GitHub Release on
   `pwrdrvr/PwrSnap`.
4. Runs `lipo -verify_arch x86_64 arm64` against the main executable, the
   bundled Swift `PwrSnapWindowList` helper, and the `better_sqlite3.node`
   native addon. A single-arch slice slipping through means Intel users
   would launch into an immediate SIGKILL.
5. Runs `verify-asar-contents.mjs` against the packaged `.app` — fails the
   release if forbidden patterns (TS sources, tests, docs, env files,
   workspace `src/` leaks, screenshots) leaked into `app.asar`, or if
   `THIRD_PARTY_LICENSES` / `CHANGELOG.md` are missing from
   `Contents/Resources`.
6. Copies the versioned DMG to `PwrSnap.dmg` and uploads it to the release
   as a stable-name alias. After a later explicit promotion to Latest,
   marketing + docs sites can link to this URL:

   ```text
   https://github.com/pwrdrvr/PwrSnap/releases/latest/download/PwrSnap.dmg
   ```
7. Publishes the matching `CHANGELOG.md` section into the GitHub Release body
   with `gh release edit --notes-file`, then reads the release back and fails
   the workflow if the body is still empty. This replaces electron-builder's
   generated/default notes after all assets are present.
8. Reads the release back and fails if GitHub reports `isPrerelease=false`.
   This catches any regression where electron-builder would create the release
   as Latest before validation.

Do not approve the `apple-signing` environment unless the tag, commit, and
release metadata are the intended release. Approving the wrong run still
exposes the Apple secrets to signing-job code.

Cycle time target: ≤ 12 minutes.

---

## Cutting a release (local path — fallback)

Useful when CI is down or for the very first signed/notarized verification.

```bash
# 1. Source release-time env (do NOT commit this file):
cat > .envrc.release <<'EOF'
export CSC_NAME="Developer ID Application: PwrDrvr LLC (T44CNHC4UH)"
export APPLE_API_KEY=$HOME/Secrets/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
export APPLE_TEAM_ID=T44CNHC4UH
export GH_TOKEN=ghp_xxx_fine_grained_PAT_with_Contents_Read_Write_on_pwrdrvr_PwrSnap
EOF
source .envrc.release

# 2. Run the orchestrator. Three modes:
pnpm --filter @pwrsnap/desktop package:dryrun  # ad-hoc signed, no publish
pnpm --filter @pwrsnap/desktop package         # signed + notarized, no publish
pnpm --filter @pwrsnap/desktop release         # signed + notarized + publish
```

Verify the produced `.app`:

```bash
APP=apps/desktop/release-stage/dist/mac-universal/PwrSnap.app

# Identity must be PwrDrvr LLC
codesign -dv --verbose=4 "$APP"

# Universal: main executable and native sidecar must contain both Apple
# Silicon and Intel slices.
lipo -archs "$APP/Contents/MacOS/PwrSnap"
lipo -archs "$APP/Contents/Resources/PwrSnapWindowList"
lipo -archs "$APP/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/electron-native/better_sqlite3.node"

# Gatekeeper-approved (Notarized Developer ID)
spctl -a -vv "$APP"

# Stapled — proves first-launch works offline
stapler validate "$APP"

# All four helpers must NOT contain the string "Electron"
ls "$APP/Contents/Frameworks/" | grep -i electron && echo "FAIL: leaked Electron Helper" || echo "OK"

# Fuses (ASAR integrity must be enabled)
npx --yes @electron/fuses read --app "$APP"

# User-viewable release documents must ship outside app.asar
test -f "$APP/Contents/Resources/THIRD_PARTY_LICENSES"
test -f "$APP/Contents/Resources/CHANGELOG.md"
```

After launch, spot-check the document surfaces:

- Help → Changelog opens the bundled changelog.
- Help → Third-party Licenses opens the bundled notices.
- Settings → About can open both release notes and third-party notices.

After a local publish, make the GitHub Release body match the changelog entry
and verify the release is still a GitHub Pre-release:

```bash
node scripts/check-desktop-release-metadata.mjs \
  --tag v<version> \
  --notes-file .local/release-v<version>-notes.md
gh release edit v<version> --repo pwrdrvr/PwrSnap --notes-file .local/release-v<version>-notes.md
gh release view v<version> --repo pwrdrvr/PwrSnap --json body --jq '.body | length'
gh release view v<version> --repo pwrdrvr/PwrSnap --json isPrerelease --jq '.isPrerelease'
```

---

## Auto-update on Phase 1

The v0.x / v1.x binary does NOT bake a `GH_TOKEN`. During Phase 1 (solo
dogfooding, just the developer running the binary on their own Mac with access
to the private `pwrdrvr/PwrSnap` repo) the token is read from
`process.env.GH_TOKEN` at runtime. The cleanest one-liner is to launch via
Terminal:

```bash
GH_TOKEN=ghp_fine_grained_PAT open /Applications/PwrSnap.app
```

Or persist it in `~/.zshrc` (or equivalent) so opening from Spotlight / dock
Just Works. A LaunchAgent plist is also possible but is overkill at Phase 1.

The "Check for updates" button (Settings → About once Phase 3 lands) invokes
`autoUpdater.checkForUpdates()` — useful for verifying the feed is reachable
without waiting for the auto-check on next launch.

A future Phase 8 distribution channel migration (public/separate releases repo)
removes the token requirement entirely.

---

## What to do if notarization fails

Apple's notarytool returns a submission ID even when notarization fails.
Fetch the JSON log:

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER"
```

Most-common Electron failures:

| Symptom | Cause | Fix |
|---|---|---|
| "The binary is not signed with a valid Developer ID certificate." | Wrong cert in Keychain or `CSC_LINK` wrong | Re-import `.p12` from 1Password; verify `security find-identity -v -p codesigning` |
| "The signature does not include a secure timestamp." | `--timestamp` flag missing on inner sign | electron-builder ≥ 26 handles this automatically; upgrade builder |
| "The executable does not have the hardened runtime enabled." | Missing `mac.hardenedRuntime: true` | Confirm in `electron-builder.yml` |
| "The entitlement com.apple.security.cs.allow-jit ... is missing on a helper bundle." | `entitlementsInherit` not pointing at the same plist | Confirm `mac.entitlements` and `mac.entitlementsInherit` both reference `build/entitlements.mac.plist` |
| "library validation failed" loading sharp's libvips at runtime | Missing `disable-library-validation` entitlement | PwrSnap requires it because sharp dlopens `libvips-cpp.42.x.dylib` (pre-signed by sharp's maintainer, not our team). Confirm `build/entitlements.mac.plist` includes `com.apple.security.cs.disable-library-validation`. **Note:** `better-sqlite3` alone does NOT need this — PwrAgnt ships it without the entitlement because electron-builder re-signs the `.node` file with our Developer ID during packaging. |
| Hangs on "Waiting for notarization status..." for >30 min | Apple infrastructure congestion | Wait or re-submit; both submissions count against the same successful staple |

---

## Cert custody, rotation, and never-do list

- **Never** rotate the Developer ID Application certificate without coordinating
  a re-install ritual. Squirrel.Mac validates that the new binary's Team ID
  matches the running app's. If you ship a binary signed under a different
  Team ID, every existing user must re-install through a Gatekeeper warning.
  Apple permits multiple Developer ID certs simultaneously — use overlap to
  rotate without forcing re-install.
- **Never** revoke a Developer ID cert unless it is confirmed leaked.
  Revocation invalidates every shipped binary signed with it (existing
  installs stop launching after their staple expires).
- **Never** commit `.p12`, `.p8`, `.envrc.release`, or any `AuthKey_*.p8` to
  the repo. The `.gitignore` blocks these by default.
- The same cert and API key are used for PwrSnap and PwrAgnt. Rotation/revocation
  affects both apps.

---

## Plan / brainstorm references

- Plan: [docs/plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md](plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md)
- Buildout plan: [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md)
