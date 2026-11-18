# Agent rules: Release and distribution

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Release / Distribution

- MIT licensed (see [LICENSE](../../LICENSE)). Every workspace `package.json`
  declares `"license": "MIT"`; the policy gate
  [scripts/check-package-license-policy.mjs](../../scripts/check-package-license-policy.mjs)
  fails the build if any package drifts.
- `THIRD_PARTY_LICENSES` is load-bearing release metadata. Do not hand-edit it
  except through `pnpm licenses:generate`, and do not remove the shipped
  notices/changelog resources from packaged builds. See
  [docs/third-party-license-notices.md](../../docs/third-party-license-notices.md).
- macOS and Windows both ship: signed/notarized Apple Silicon and universal DMGs and a
  signed NSIS x64 installer (plus the winget manifests under
  [docs/windows/winget](../../docs/windows/winget)). Linux is not a distribution
  target — the Linux CI job is E2E only. The old "macOS-first, cross-platform
  deferred to Phase 8" framing is history; do not write new platform-
  exclusive copy anywhere a user can read it (see the `description` section
  below for where that bit us).
- electron-builder config at [apps/desktop/electron-builder.yml](../../apps/desktop/electron-builder.yml).
  Hardened runtime + notarization wired (notarize off until Apple Developer
  ID is configured).
- Auto-update wires in Phase 3 via `electron-updater`, mirroring PwrAgnt's
  pattern.

### macOS app icon — ship the Icon Composer `.icon`; actool derives the `.icns`

**`mac.icon` in electron-builder.yml points at `build/icon.icon`, an Icon
Composer package, and nothing in this repo hand-builds a `.icns`.**
electron-builder (≥ 26.15, pinned) compiles the package with Xcode 26's
`actool` into `Contents/Resources/Assets.car` + `CFBundleIconName` — what
macOS 26 draws — and derives the legacy `Contents/Resources/icon.icns` +
`CFBundleIconFile` — what macOS 15 and earlier draw — from the same
source. Each OS reads the format designed for it; one file no longer has
to satisfy both.

Why this is an invariant and not a preference: macOS 26 auto-normalizes a
legacy `.icns` it is handed *instead of* a `.icon`, and how it does so is
not stable across point releases. 1.1.0-alpha.6 shipped only a `.icns`
padded to Apple's 824-in-1024 template (#534 — the right shape for macOS
15). 26.6.1 composited it identically to the full-bleed one before it;
26.6.2 composited it onto a light plate in the Dock and Finder. Same
bytes, two results. With a `.icon` present the `.icns` is never opened on
macOS 26, so the question goes away. Ghostty (MIT) ships exactly this pair
— its actool-made `.icns` is padded like ours was — which is why it never
showed the plate.

Rules:

- **Regenerate with `pnpm --filter @pwrsnap/desktop generate:app-icon`**
  ([generate-app-icon.swift](../../apps/desktop/scripts/generate-app-icon.swift)).
  It writes the package (`icon.json` + a glyph-only `Assets/glyph.png`;
  the tile is the package's `fill`), `icon.png` (full-bleed Windows
  master) and `icon-macos.png` (padded — the development Dock icon, which
  `app.dock.setIcon()` paints literally). Do not add a `.icns` /
  `.iconset` back, and do not point `mac.icon` at one.
- **Every job that packages the mac app needs an actool 26 or newer.**
  electron-builder hard-fails below that, and its Icon Composer
  `AssetCatalogAgent` also requires the macOS 26 host frameworks. The macOS
  packaging jobs therefore use standard GitHub-hosted `macos-26` runners.
  Pointing Xcode 26 at a macOS 15 host crashes the agent with missing
  CoreMedia/MediaToolbox symbols.
  [select-xcode-for-actool](../../.github/actions/select-xcode-for-actool/action.yml)
  checks the host and selects the newest stable installed Xcode with actool
  26 or newer. A Command Line Tools default is insufficient; beta/RC Xcodes
  never package releases. Keep the selection scoped to icon compilation and
  packaging, without changing the runner's global `xcode-select` state.
  [release.yml](../../.github/workflows/release.yml) (both macOS
  jobs) and [preview-build.yml](../../.github/workflows/preview-build.yml) set
  `DEVELOPER_DIR` from it on exactly the steps that run actool — the unit
  tests, so the compile test in
  [app-icon.test.mjs](../../apps/desktop/scripts/app-icon.test.mjs) runs
  instead of skips (that step also sets `PWRSNAP_REQUIRE_ACTOOL=1`, so on
  the release lane the suite fails rather than skips when the probe finds
  no actool 26) — and electron-builder, so the icon compile does not
  move `build:native` (swiftc helpers, the Quick Look extensions) onto a
  different SDK. The sign job has no checkout, so the action rides inside
  the archived signing input. Locally, select an Xcode 26
  (`xcode-select`, or `DEVELOPER_DIR`) before `package:dryrun`.
- **The compile test calls electron-builder's own helper**
  (`app-builder-lib/out/util/macosIconComposer.generateAssetCatalogForIcon`),
  not a copied actool command line, so the two cannot drift.
- **actool's derived `.icns` carries 16, 32, 128 and 256px reps only** —
  the same four Ghostty ships. macOS 15 upsamples the 256px rep for
  Finder's largest icon sizes and Quick Look, where the deleted hand-built
  icns had 512 and 1024. Accepted for now; an `afterPack` hook could
  splice larger reps rendered from `icon-macos.png` if it ever matters.
- **`actool` resolves `--app-icon Icon` by the package's basename.** Fed
  `build/icon.icon` directly it exits 0 and silently writes no `.icns`.
  electron-builder copies the package to `Icon.icon` first; do the same
  if you ever compile by hand, and check the output for the `.icns`.
- **PNG bytes are deterministic per machine, not across macOS versions**
  (±2/255 antialiasing drift). Regenerate when the artwork changes, not to
  "refresh", and don't read a byte diff of `icon.png` as a design change.
- **Verifying an icon change means asking macOS, not eyeballing the PNG.**
  Dock and Finder both draw `NSWorkspace.shared.icon(forFile:)`; render
  that to a bitmap and measure the opaque bounds (recipe in the solutions
  doc). Do it on a machine running the newest macOS you ship to — this
  class of bug is invisible one point release back, and GitHub runners lag
  further. Probe a `.pwrsnap` file as well as the app: the document icon
  (`UTTypeIconFile` / `CFBundleTypeIconFile` in electron-builder.yml) still
  comes from the derived, padded `.icns`, and whether 26.6.2 plates it has
  not been measured — see the solutions doc's open item.

Full investigation, measurements, and the probe recipe:
[docs/solutions/2026-09-05-macos-26-legacy-icon-light-plate.md](../../docs/solutions/2026-09-05-macos-26-legacy-icon-light-plate.md).

### Electron fuses are pinned — including one that is OFF on purpose

Fuses are burned into the packaged binary and **cannot be read back from
the running app**, so no unit test, E2E run, or review of
`apps/desktop/src` can observe a wrong one. The only feedback is a shipped
installer. [scripts/check-electron-fuses-policy.mjs](../../scripts/check-electron-fuses-policy.mjs)
therefore pins the posture and runs in `pnpm lint` (every PR) *and* from
`pnpm release:check`.

**`enableCookieEncryption` must stay `false`, and it is the one entry that
looks backwards.** Enabling it makes Electron fetch the app's Safe Storage
key from the login keychain when the network service starts — before any
window exists, on every launch — which surfaces as a macOS keychain
*password* prompt for any binary not already on that keychain item's access
list (a rebuilt local package, a second install, a dev Electron). PwrSnap
stores no cookies: every window loads `file://` or `data:`, outbound HTTP
from main goes through Node `fetch` (undici, no Chromium cookie jar), and
nothing calls `session.cookies`. So it protected an empty database and cost
the single scariest thing a new user sees. Every other pinned fuse is a
hardening one; do not "restore" this one to match them. Revisit only if a
`BrowserWindow` starts loading a remote origin that sets real cookies —
and note the transition is one-way, so a store encrypted under the fuse
becomes unreadable if it is later turned off.

Full mechanism, the `security dump-keychain` evidence, and why the prompt
cannot be predicted or pre-explained from Electron:
[docs/solutions/2026-09-11-startup-keychain-prompt-cookie-encryption.md](../../docs/solutions/2026-09-11-startup-keychain-prompt-cookie-encryption.md).

### `package.json` `description` is shipped UI on Windows

**It is not inert metadata.** electron-builder reads
`apps/desktop/package.json` → `description` into `AppInfo.description` and
puts it in two places a Windows user actually reads:

- the **NSIS installer's own `FileDescription`** version string — what
  SmartScreen and Explorer's Properties → Details name the program;
- **`APP_DESCRIPTION`**, passed to `CreateShortCut` for the Start Menu and
  desktop `.lnk`s, which is the line Windows 11 renders in the **taskbar
  jump list** above "Pin to taskbar" / "Close window".

1.1 shipped `"Mac-first agentic screen capture tool"` to Windows users
through both. Nothing surfaced it: the app exe's own `FileDescription` is
`productName` (`winPackager.ts`), so the string is invisible everywhere on
macOS and only appears once a `.exe` exists.

Keep it platform-neutral and short enough to read as a one-line label.
[scripts/check-app-metadata-policy.mjs](../../scripts/check-app-metadata-policy.mjs)
enforces that: empty, over 80 characters, carrying any word in
`PLATFORM_WORDS`, or drifting from the root `package.json`'s copy all fail.
It runs in `pnpm metadata:check` — so in `pnpm lint`, so on **every PR** — and
`pnpm release:check` calls the same function so a string that reached `main`
another way still cannot ship. Putting it only in the release gate would have
caught this at tag time, which is the worst moment to find it.
