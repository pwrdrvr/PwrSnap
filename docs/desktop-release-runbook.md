# Desktop Release Runbook

> MIT-licensed (see [LICENSE](../LICENSE)). Copyright © 2026 PwrDrvr LLC.
>
> Origin: [docs/plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md](plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md)

This runbook covers cutting v0.x and v1.x desktop releases. macOS ships as a
universal Apple Silicon + Intel build outside the Mac App Store; Windows ships
as an Azure Artifact Signed x64 NSIS installer. Linux distribution remains
Phase 8b, but a native Linux desktop build is a required release gate.

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

5. **GitHub `windows-signing` Environment**.
   - Mirror PwrAgent's protected environment and Azure Artifact Signing values.
   - Variables: `WIN_AZURE_SIGN_PUBLISHER_NAME`,
     `WIN_AZURE_SIGN_ENDPOINT`, `WIN_AZURE_SIGN_ACCOUNT`,
     `WIN_AZURE_SIGN_PROFILE`, and `FFMPEG_BUILDS_APP_CLIENT_ID`.
   - Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
     `AZURE_CLIENT_SECRET`, and `FFMPEG_BUILDS_APP_PRIVATE_KEY`.
   - Do not add Azure credentials at repository scope. The protected job is the
     only job that receives them, and it performs no checkout or dependency
     installation. Full setup and failure behavior are in
     [desktop-windows-signing.md](desktop-windows-signing.md).
6. **GitHub repository secrets**.
   - Do **not** keep Apple signing/notarization material as repository secrets
     after the `apple-signing` environment secrets are configured.
   - Optional `RELEASES_PAT` belongs at repository scope because the final
     publication job is intentionally outside both signing environments. It
     must be fine-grained to `Contents: Read & Write` on `pwrdrvr/PwrSnap`.
     The workflow falls back to `GITHUB_TOKEN` when it is absent.
   - Non-release CI secrets (e.g. live smoke-test service keys) may remain at
     the repo level if their workflows require them.

`APPLE_TEAM_ID` is hardcoded in `.github/workflows/release.yml` to `T44CNHC4UH`
since it is not a secret.

---

## Release trains and maintenance branches

`main` carries the active next-version train. Long-lived maintenance branches
carry stable promotions from accepted prereleases and later patch releases for
that major/minor train. Name them `releases/<major>.<minor>`, for example
`releases/1.0` or `releases/1.1`; do not include the patch component.

When an accepted beta must become the first stable release while `main` has
continued onto newer work, create the maintenance branch from the exact signed
beta tag, prepare the stable metadata there, and tag the resulting commit:

```bash
git fetch origin --tags
git switch -c releases/1.0 v1.0.0-beta.<n>
git push -u origin releases/1.0
```

After the stable `v1.0.0` tag is cut, `releases/1.0` remains the only branch
for `v1.0.x` patches. Before `main` moves to the next major/minor train, verify
that the prior train's branch exists; create it from the exact prior release
tag if it does not.

CI runs for pushes to `main` and `releases/**`, and pull requests targeting a
maintenance branch use the same CI workflow. Backport release-workflow fixes to
supported maintenance branches so older trains retain the ability to ship.

---

## Cutting a release (CI path — preferred)

```bash
# 1. Bump the version. Use semver pre-release tags during alpha/beta:
pnpm --filter @pwrsnap/desktop version 0.0.1-alpha.1

# 2. Push the tag (the version command commits and tags automatically).
git push --follow-tags
```

The release workflow separates preparation, signing, and publication:

1. **`prepare`** installs dependencies without signing secrets, checks release
   metadata, typechecks, tests, and creates the macOS signing input artifact.
2. **`sign`** runs inside `apple-signing`, verifies the prepared input, injects
   the pinned macOS FFmpeg artifact, signs/notarizes/packages with
   `--sign-stage-only --no-publish`, and uploads the macOS payload. It does not
   check out source or install dependencies.
3. **`linux-build`** checks out the tag on Ubuntu and runs the desktop build.
   Linux packages are not shipped yet, but a Linux regression blocks release
   creation.
4. **`windows-prepare`** builds a hoisted, self-contained Windows stage without
   signing credentials. It archives the stage and records its SHA-256.
5. **`windows-sign`** runs inside `windows-signing`, verifies the archive,
   injects the pinned Windows FFmpeg artifact, installs `TrustedSigning`, and
   packages via `--sign-stage-only --release --require-signing`. It does not
   check out source or install dependencies. See
   [desktop-windows-signing.md](desktop-windows-signing.md).
6. **`publish-release-assets`** depends on successful Linux, macOS, and Windows
   jobs. Only this job creates the GitHub Pre-release, with changelog notes,
   macOS DMG/ZIP/updater metadata, the stable `PwrSnap.dmg` alias, the signed
   Windows installer/updater metadata, and checksums.

No signing job publishes directly. A macOS or Windows signing failure, an
unapproved environment, or a Linux build failure leaves no partial GitHub
Release behind.

For a non-publishing Windows signing smoke check, apply `ci:windows-signing` to
a same-repository PR after reviewing its head SHA. Temporarily allow that exact
branch in the `windows-signing` environment, approve the protected job, and
remove the branch rule after the `windows-signed-installer-pr` artifact passes
Authenticode and launch validation. The smoke workflow uses the same staged
archive boundary as release CI and never creates a tag or GitHub Release.

Do not approve either signing environment unless the tag, commit, and release
metadata are intended. Approval exposes that environment's credentials to its
bounded packaging step.

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
