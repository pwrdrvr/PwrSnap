---
title: "feat: Release infrastructure — DMG template, signing, and CI hardening"
type: feat
status: completed
date: 2026-05-04
---

# Release Infrastructure — DMG Template, Signing, and CI Hardening

## Overview

Port the release infrastructure from PwrAgnt into PwrSnap: branded DMG background
generator, code signing / notarization activation, entitlements plist, asar
verification, release metadata checks, and a preview-build workflow. PwrSnap
already has the skeleton (`release.mjs`, `release.yml`, basic `electron-builder.yml`)
but is missing the polish and safety gates that make PwrAgnt shippable.

## Problem Statement / Motivation

PwrSnap can build an unsigned DMG via `package:dryrun`, but:

- The DMG has no branded background — macOS shows a blank window with unlabeled
  icons, making the install experience confusing.
- No entitlements plist exists, so hardened runtime will crash the app on launch
  once signing is enabled (PwrSnap ships `sharp` which dlopens a pre-signed
  `libvips` dylib at runtime, unlike PwrAgnt which has no sharp dep).
- No `verify-asar-contents` guard — forbidden files (TS sources, docs, env,
  screenshots) can silently leak into the bundle.
- No release metadata validation — version/tag/changelog mismatches can slip
  past and produce broken releases.
- No preview-build workflow — reviewers cannot test packaged DMGs from PRs.
- Code signing secrets are not configured in the GitHub repo.
- `icon.icns` does not exist — electron-builder hard-fails without it.

## Proposed Solution

Bring over PwrAgnt's release toolkit, adapting for PwrSnap's brand and native
module requirements, in a phased approach that lets us validate incrementally.

## Technical Approach

### Architecture

All changes are additive files and config — no existing logic changes except
expanding `electron-builder.yml` with the missing sections.

### Implementation Phases

#### Phase 1: Foundation — Icon, Entitlements, Config Completion

**Goal:** `package:dryrun` produces a correct, self-consistent unsigned DMG.

**Tasks:**

- [ ] Create `apps/desktop/build/icon.iconset/` from the PwrSnap mark SVG
  (stacked rectangles, burnt-copper on dark background). Generate all required
  sizes (16, 32, 128, 256, 512 @ 1x and 2x). Run `iconutil -c icns` to produce
  `apps/desktop/build/icon.icns`. Commit the iconset and the icns.

- [ ] Create `apps/desktop/build/entitlements.mac.plist`:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
                         "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
  </plist>
  ```
  **Critical difference from PwrAgnt:** PwrSnap includes
  `disable-library-validation` because of **sharp specifically**, not
  better-sqlite3. PwrAgnt also ships better-sqlite3 (and successfully
  notarizes through 6+ releases) because electron-builder rebuilds and
  re-signs the better-sqlite3 `.node` file with our Developer ID during
  packaging — library validation is satisfied for the SQLite path.

  Sharp is the actual blocker: `sharp.node` dlopens `libvips-cpp.42.x.dylib`
  at runtime, and that dylib is pre-signed by sharp's maintainer (different
  team). Without this entitlement (or a custom afterPack codesign of the
  dylib), the hardened runtime kills the process on first sharp call. See
  the buildout plan §"Bundle Layout & Signing" for the long-term shape
  (afterPack `codesign --force --deep` + drop the entitlement).

- [ ] Add `entitlements` and `entitlementsInherit` to `electron-builder.yml`
  mac section:
  ```yaml
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  ```

- [ ] Add `notarize: true` to `electron-builder.yml` mac section (replaces
  current `notarize: false`). The signing infra in `release.mjs` already
  handles the case where signing env vars are absent (dryrun mode overrides
  with `--config.mac.identity=null --config.mac.notarize=false`).

- [ ] Add `publish` block to `electron-builder.yml`:
  ```yaml
  publish:
    provider: github
    owner: pwrdrvr
    repo: PwrSnap
    private: true
    releaseType: release
  ```

- [ ] Expand `files:` exclusions in `electron-builder.yml` to match PwrAgnt's
  comprehensive list (TypeScript declarations, sourcemaps, test fixtures,
  markdown, docs, env files, workspace source leaks under
  `node_modules/@pwrsnap/*/src/`).

**Success criteria:** `pnpm --filter @pwrsnap/desktop package:dryrun` produces
a valid DMG that opens and runs from Finder (native modules load).

---

#### Phase 2: DMG Branding

**Goal:** The installer DMG shows a professional branded background with an
arrow directing the user to drag to Applications.

**Tasks:**

- [ ] Vendor `Geist-Bold.ttf` at `apps/desktop/build/fonts/Geist-Bold.ttf`
  (same file from PwrAgnt — it's the open-source Vercel Geist font).

- [ ] Create `apps/desktop/scripts/generate-dmg-background.swift` — adapted
  from PwrAgnt's generator with these changes:
  - Wordmark: `"Pwr"` (cream text) + `"Snap"` (accent-colored) instead of
    `"Pwr"` + `"Agent"`.
  - Subtitle: `"screenshots / recordings"` instead of
    `"threads / transcripts"`.
  - Accent color: `#e8743a` (rgb 232, 116, 58) — PwrSnap's burnt copper, not
    PwrAgnt's `#E85A3A`.
  - Canvas: 660x400 (same layout dimensions).
  - Icon positions: appIcon at (170, 230), Applications at (500, 230) — same
    as PwrAgnt.
  - Keep the same rounded-pill container, arrow, and "Drag to Applications"
    instruction.

- [ ] Add `generate:dmg-background` script to `apps/desktop/package.json`:
  ```json
  "generate:dmg-background": "swift ./scripts/generate-dmg-background.swift ./build/dmg-background.png"
  ```

- [ ] Run the generator, commit the output `apps/desktop/build/dmg-background.png`.

- [ ] Complete the `dmg:` section in `electron-builder.yml`:
  ```yaml
  dmg:
    background: build/dmg-background.png
    window:
      width: 660
      height: 400
    iconSize: 112
    iconTextSize: 12
    contents:
      - x: 170
        y: 230
        type: file
      - x: 500
        y: 230
        type: link
        path: /Applications
    writeUpdateInfo: false
  ```

**Success criteria:** `package:dryrun` DMG shows branded background with
correct icon positioning and accent color.

---

#### Phase 3: Safety Gates — Asar Verification & Release Metadata

**Goal:** CI catches asar bloat and version/changelog mismatches before a
release proceeds.

**Tasks:**

- [ ] Create `apps/desktop/scripts/verify-asar-contents.mjs` — adapted from
  PwrAgnt with:
  - Default app path: `release-stage/dist/mac-arm64/PwrSnap.app`
  - Workspace leak patterns: `@pwrsnap/` (not `@pwragent/`)
  - All other forbidden patterns carried over unchanged.

- [ ] Add `verify:asar-contents` script to `apps/desktop/package.json`:
  ```json
  "verify:asar-contents": "node ./scripts/verify-asar-contents.mjs"
  ```

- [ ] Create `scripts/check-desktop-release-metadata.mjs` at repo root —
  copy from PwrAgnt unchanged (it is repo-agnostic; reads
  `apps/desktop/package.json` and `CHANGELOG.md` relative to repo root).

- [ ] Add `release:check` script to root `package.json`:
  ```json
  "release:check": "node ./scripts/check-desktop-release-metadata.mjs"
  ```

- [ ] Create `CHANGELOG.md` at repo root with initial structure:
  ```markdown
  # Changelog

  ## v0.0.1

  - Initial pre-release.
  ```

- [ ] Wire `verify:asar-contents` into `release.mjs` as a post-build step
  (after electron-builder completes, before the "done" message). Fail the
  release if violations are found.

**Success criteria:** `release:check --tag v0.0.1` passes. `verify:asar-contents`
runs automatically during `package:dryrun` and catches any leaked files.

---

#### Phase 4: CI Workflows — Release Hardening & Preview Builds

**Goal:** Release workflow is gated by metadata check; PR authors can get
preview DMGs.

**Tasks:**

- [ ] Update `.github/workflows/release.yml`:
  - Add "Check release metadata" step between "Install" and "Typecheck":
    ```yaml
    - name: Check release metadata
      env:
        RELEASE_TAG: ${{ github.event.inputs.tag || github.ref_name }}
      run: pnpm release:check
    ```
  - Add explicit `build:native` step before the release step to guarantee
    the window-list helper is fresh:
    ```yaml
    - name: Build native helpers
      run: pnpm --filter @pwrsnap/desktop build:native
    ```

- [ ] Create `.github/workflows/preview-build.yml` — adapted from PwrAgnt:
  - Trigger: PR labeled `build-preview`
  - Filter: `@pwrsnap/desktop` (not `@pwragent/desktop`)
  - Artifact name: `PwrSnap-${{ version }}-preview`
  - Add explicit `build:native` step
  - Upload both `*.dmg` and `*.zip`
  - 14-day retention

**Success criteria:** Tagging `v0.0.1` triggers a full release pipeline (fails
only on missing secrets, not missing files). Labeling a PR `build-preview`
produces a downloadable unsigned DMG artifact.

---

#### Phase 5: Code Signing Secrets

**Goal:** The release pipeline signs, notarizes, and publishes for real.

**Tasks:**

- [ ] Configure the following GitHub repo secrets on `pwrdrvr/PwrSnap`:

  | Secret | Description | Source |
  |--------|-------------|--------|
  | `CSC_LINK` | Base64-encoded `.p12` Developer ID Application cert | Same cert as PwrAgnt (team T44CNHC4UH) |
  | `CSC_KEY_PASSWORD` | Password for the .p12 file | Keychain / 1Password |
  | `APPLE_API_KEY_BASE64` | Base64-encoded `.p8` App Store Connect API key | Same key as PwrAgnt |
  | `APPLE_API_KEY_ID` | API key ID (e.g., `XXXXXXXXXX`) | App Store Connect |
  | `APPLE_API_ISSUER` | Issuer UUID from App Store Connect | App Store Connect |
  | `APPLE_TEAM_ID` | `T44CNHC4UH` | Apple Developer Portal |
  | `RELEASES_PAT` | GitHub PAT with `contents:write` on `pwrdrvr/PwrSnap` | GitHub Settings |

- [ ] Verify end-to-end: push a pre-release tag (`v0.0.1-alpha.0`), confirm
  the workflow signs, notarizes, and publishes a GitHub Release with DMG + ZIP
  artifacts.

- [ ] After successful notarization, verify the downloaded DMG opens without
  Gatekeeper warnings on a clean Mac (or test via `spctl --assess`).

**Success criteria:** `v0.0.1-alpha.0` release appears on GitHub with signed,
notarized DMG that installs cleanly.

---

## Alternative Approaches Considered

1. **Skip the Swift DMG generator, just use a static PNG from Figma.** Rejected
   because the procedural approach keeps layout constants (icon positions,
   canvas size) in sync between the script and `electron-builder.yml`, and
   makes future brand tweaks trivial (change a color constant, regenerate).

2. **Omit `disable-library-validation` and re-sign sharp's libvips dylib in an
   afterPack hook.** This is the long-term hardening path documented in the
   buildout plan's "Bundle Layout & Signing" table. Deferred for v0.0.1
   velocity — the entitlement is a standard, notarization-accepted shortcut
   used by most Electron+sharp apps. (better-sqlite3 doesn't need either
   approach; electron-builder already re-signs its `.node` file.)

3. **Use a separate releases repo (like PwrAgnt Phase 2 discusses).** Deferred
   — for now, publish to the same private `pwrdrvr/PwrSnap` repo. The
   distribution channel decision is orthogonal and can change later by editing
   the `publish` block.

## System-Wide Impact

### Interaction Graph

- `release.mjs` orchestrates: electron-vite build → pnpm deploy → seed stage →
  electron-builder. Adding `verify-asar-contents` is a post-build validation
  step — no upstream side effects.
- `release.yml` calls `release:check` (fast metadata validation) before the
  expensive build step — fail-fast pattern.
- `preview-build.yml` is fully independent (different trigger, different job).

### Error & Failure Propagation

- Missing secrets → electron-builder logs a signing error and exits non-zero →
  GHA step fails → workflow fails (no partial release).
- Notarization rejection → electron-builder exits non-zero → same.
- `release:check` failure → workflow stops before build (cheap failure).
- `verify-asar-contents` failure → release.mjs exits non-zero → no publish.

### State Lifecycle Risks

- No persistent state involved. GitHub Releases are the output artifact.
- A failed publish leaves no partial release (electron-builder's GitHub
  provider creates the release atomically with assets uploaded in the same
  API call).

### API Surface Parity

- `electron-builder.yml` is the single config for DMG layout, signing, and
  publish channel — no second source of truth.

### Integration Test Scenarios

1. `package:dryrun` on macOS → unsigned DMG opens, native modules load, branded
   background visible.
2. `package` (signed, no publish) on macOS with signing cert in Keychain →
   `spctl --assess --type execute` passes on the `.app`.
3. Tag push in CI with all secrets → release workflow green, GitHub Release
   created with DMG + ZIP + latest-mac.yml.
4. PR with `build-preview` label → preview workflow produces downloadable DMG
   artifact.
5. `release:check` with mismatched tag/version → exits non-zero with clear
   error message.

## Acceptance Criteria

### Functional Requirements

- [ ] `apps/desktop/build/icon.icns` exists and renders correctly at all sizes
- [ ] `apps/desktop/build/entitlements.mac.plist` includes `disable-library-validation`
- [ ] `apps/desktop/build/dmg-background.png` shows PwrSnap branding with correct accent
- [ ] `electron-builder.yml` has complete `dmg:`, `mac:`, `publish:`, and `files:` sections
- [ ] `pnpm --filter @pwrsnap/desktop package:dryrun` succeeds end-to-end
- [ ] Resulting DMG shows branded installer with arrow and correct icon positions
- [ ] App launched from signed DMG loads `better-sqlite3` (re-signed by electron-builder) and `sharp` (entitlement-permitted libvips dlopen) without crash
- [ ] `pnpm release:check --tag v0.0.1` passes
- [ ] `pnpm --filter @pwrsnap/desktop verify:asar-contents` passes after dryrun
- [ ] `preview-build.yml` triggers on `build-preview` label and uploads DMG artifact
- [ ] `release.yml` includes metadata-check step before build

### Non-Functional Requirements

- [ ] No new runtime dependencies — all additions are build/CI tooling
- [ ] Signing secrets are repo secrets, never committed or logged
- [ ] DMG background regeneration is a developer convenience (committed PNG is source of truth)

### Quality Gates

- [ ] Local `package:dryrun` tested on macOS (Apple Silicon)
- [ ] Preview build tested on at least one PR
- [ ] Signed build verified with `spctl --assess` before cutting first real release

## Dependencies & Prerequisites

- **Apple Developer ID Application certificate** — already provisioned for
  PwrDrvr LLC (team T44CNHC4UH), same cert as PwrAgnt.
- **App Store Connect API key** — same `.p8` as PwrAgnt (one key can notarize
  multiple apps).
- **GitHub PAT with `contents:write`** — for publishing releases to the private
  repo.
- **Geist-Bold.ttf** — open-source font from Vercel, already vendored in PwrAgnt.
- **macOS with Xcode CLI tools** — required for `iconutil` (icon generation)
  and `swift` (DMG background generation). CI runners (`macos-15`) have these.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `disable-library-validation` not sufficient for sharp's libvips dlopen | Low | High (crash on first sharp call) | Test signed build locally before pushing secrets; if it still crashes, investigate afterPack `codesign --force --deep` on the libvips dylib (long-term path anyway) |
| DMG background renders incorrectly on non-Retina | Medium | Low (cosmetic) | Accept 1x limitation (matches PwrAgnt); note for future improvement |
| `pnpm deploy` skips native helper binary | Low | High (app missing window-list) | Explicit `build:native` step in both workflows, before release step |
| Notarization rejected due to new entitlement | Low | Medium (blocks release) | Test with `--no-publish` first; Apple docs confirm `disable-library-validation` is a standard entitlement |

## File Manifest

### New Files

| File | Source | Adaptation Required |
|------|--------|---------------------|
| `apps/desktop/build/icon.iconset/*` | New (from PwrSnap mark SVG) | Generate all sizes |
| `apps/desktop/build/icon.icns` | Generated from iconset | None |
| `apps/desktop/build/entitlements.mac.plist` | PwrAgnt | Add `disable-library-validation` |
| `apps/desktop/build/fonts/Geist-Bold.ttf` | PwrAgnt (copy) | None |
| `apps/desktop/build/dmg-background.png` | Generated | From PwrSnap generator |
| `apps/desktop/scripts/generate-dmg-background.swift` | PwrAgnt | Wordmark, subtitle, accent color |
| `apps/desktop/scripts/verify-asar-contents.mjs` | PwrAgnt | `@pwrsnap/`, `PwrSnap.app` |
| `scripts/check-desktop-release-metadata.mjs` | PwrAgnt (copy) | None (repo-agnostic) |
| `.github/workflows/preview-build.yml` | PwrAgnt | Filter name, artifact name |
| `CHANGELOG.md` | New | Initial stub |

### Modified Files

| File | Changes |
|------|---------|
| `apps/desktop/electron-builder.yml` | Add entitlements, notarize:true, publish block, complete dmg section, expand files exclusions |
| `apps/desktop/package.json` | Add `generate:dmg-background`, `verify:asar-contents` scripts |
| `package.json` (root) | Add `release:check` script |
| `.github/workflows/release.yml` | Add metadata-check step, add build:native step |
| `apps/desktop/scripts/release.mjs` | Add verify-asar-contents post-build step |

## Sources & References

### Internal References

- PwrAgnt DMG generator: `/Users/huntharo/github/PwrAgnt/apps/desktop/scripts/generate-dmg-background.swift`
- PwrAgnt entitlements: `/Users/huntharo/github/PwrAgnt/apps/desktop/build/entitlements.mac.plist`
- PwrAgnt release workflow: `/Users/huntharo/github/PwrAgnt/.github/workflows/release.yml`
- PwrAgnt preview workflow: `/Users/huntharo/github/PwrAgnt/.github/workflows/preview-build.yml`
- PwrAgnt asar verifier: `/Users/huntharo/github/PwrAgnt/apps/desktop/scripts/verify-asar-contents.mjs`
- PwrAgnt metadata check: `/Users/huntharo/github/PwrAgnt/scripts/check-desktop-release-metadata.mjs`
- PwrSnap design system accent: `design/ds/colors_and_type.css` (`--accent: #e8743a`)
- PwrSnap brand mark: `apps/desktop/src/renderer/src/features/shared/BrandMark.tsx`

### External References

- Apple hardened runtime entitlements: https://developer.apple.com/documentation/security/hardened-runtime
- electron-builder code signing docs: https://www.electron.build/code-signing
- electron-builder DMG options: https://www.electron.build/dmg
