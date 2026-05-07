# Desktop Release Runbook

> Closed-source preview. Copyright © 2026 PwrDrvr LLC.
>
> Origin: [docs/plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md](plans/2026-05-04-002-feat-release-infrastructure-dmg-signing-plan.md)

This runbook covers cutting v0.x and v1.x desktop releases. Apple Silicon
(arm64) only; distribution is outside the Mac App Store via signed/notarized
DMG with auto-update through `electron-updater` against the private
`pwrdrvr/PwrSnap` repo. Cross-platform is deferred to Phase 8.

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
4. **GitHub repository secrets** (for the release CI workflow):
   - `CSC_LINK` — `.p12` base64-encoded
   - `CSC_KEY_PASSWORD` — the `.p12` password
   - `APPLE_API_KEY_BASE64` — `.p8` base64-encoded
   - `APPLE_API_KEY_ID` — the Key ID
   - `APPLE_API_ISSUER` — the Issuer ID
   - `RELEASES_PAT` (optional) — fine-grained PAT scoped to `Contents: Read & Write`
     on `pwrdrvr/PwrSnap`. Falls back to `GITHUB_TOKEN` if absent.

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

The `Release Desktop (macOS arm64)` workflow on `macos-15` triggers, runs
`release:check` (tag/version/changelog gate) → typecheck → tests →
`build:native` → `apps/desktop/scripts/release.mjs` which:

1. Builds main/preload/renderer with electron-vite.
2. Runs `pnpm deploy --prod` to materialize a flat `node_modules` tree under
   `apps/desktop/release-stage/`.
3. Seeds the stage with `out/` + `build/` + `electron-builder.yml`.
4. Decodes `APPLE_API_KEY_BASE64` from the env to a temp `.p8` file.
5. Runs `electron-builder --mac --arm64 --publish always` which signs every
   helper bundle individually, signs the main `.app`, submits to Apple's
   notarization service via `notarytool`, staples the ticket, builds the DMG
   and ZIP, generates `latest-mac.yml`, and uploads everything to a GitHub
   Release on `pwrdrvr/PwrSnap`.
6. Runs `verify-asar-contents.mjs` against the packaged `.app` — fails the
   release if forbidden patterns (TS sources, tests, docs, env files,
   workspace `src/` leaks, screenshots) leaked into `app.asar`.

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
APP=apps/desktop/release-stage/dist/mac-arm64/PwrSnap.app

# Identity must be PwrDrvr LLC
codesign -dv --verbose=4 "$APP"

# Gatekeeper-approved (Notarized Developer ID)
spctl -a -vv "$APP"

# Stapled — proves first-launch works offline
stapler validate "$APP"

# All four helpers must NOT contain the string "Electron"
ls "$APP/Contents/Frameworks/" | grep -i electron && echo "FAIL: leaked Electron Helper" || echo "OK"

# Fuses (ASAR integrity must be enabled)
npx --yes @electron/fuses read --app "$APP"
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
