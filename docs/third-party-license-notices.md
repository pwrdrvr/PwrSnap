# Third-party license notices

PwrSnap is MIT-licensed (see [LICENSE](../LICENSE)), and the desktop app
bundles third-party dependencies and font software whose notices must ship
with each release. The committed source of truth is the repo-root
`THIRD_PARTY_LICENSES` file.

## Commands

Regenerate notices after production desktop dependency changes or bundled asset
changes:

```bash
pnpm licenses:generate
```

Check that license policy and generated notices are current:

```bash
pnpm licenses:check
```

`pnpm lint` runs the license check, and `apps/desktop/scripts/release.mjs`
runs it before any expensive build/package work.

## How the check can fail open

Investigated 2026-08-17, after `THIRD_PARTY_LICENSES` was believed to have gone
stale on `main` without CI noticing. `pnpm lint` **is** wired into CI (the
`Lint` and `Windows` jobs in `.github/workflows/ci.yml`), and the `--check` path
does exit non-zero. Three separate defects were found instead, all now fixed and
covered by `scripts/__tests__/`.

### 1. The generator silently degraded on a stale `node_modules`

`pnpm licenses list` reports package paths derived from `pnpm-lock.yaml`. When
`node_modules` has drifted from the lockfile — the usual cause is switching
branches across a dependency bump without reinstalling — those directories do
not exist. The generator used to absorb that quietly: for every unmaterialized
package it substituted the pnpm-reported `homepage` for the manifest
`repository` URL, and generated boilerplate for the package's real license text.

The output looked plausible, so `--check` failed with *"THIRD_PARTY_LICENSES is
out of date. Run `pnpm licenses:generate`"* — blaming the committed file. Doing
what that message says commits the degraded notice. That very nearly shipped: a
regeneration produced from a drifted install replaced the real license texts of
**172 packages** with `No license text file was found…` placeholders (316
`package metadata` markers, versus 3 in the correct file) and rewrote source
URLs (`github.com/lovell/sharp` → `sharp.pixelplumbing.com`, and similar for
`wavesurfer.js`, `@modelcontextprotocol/sdk`, `json-schema-typed`).

The generator now calls `assertPackagesMaterialized` before enriching any
record and fails with an actionable message telling you to run `pnpm install` —
explicitly *not* `pnpm licenses:generate`.

**If `--check` fails, run `pnpm install` first, and only then trust the
verdict.** CI is unaffected because CI always installs from a clean lockfile;
this misfires only on developer machines.

### 2. The check never ran at all on Windows

`generate-third-party-licenses.mjs` guarded its CLI with
`import.meta.url === ` \`file://${process.argv[1]}\`. On Windows `import.meta.url`
is `file:///D:/a/…` while the concatenation yields `file://D:\a\…`, so the guard
was false, `runCli()` never fired, and the script exited **0 without checking
anything**. The Windows CI lane had been reporting a green `licenses:check` for
months on the strength of the *other* script's output.

The same expression also fails on any platform when the checkout path needs
percent-encoding (a space, `#`, `?`, non-ASCII).

The comparison now lives in `scripts/lib/cli-entrypoint.mjs` (`isCliEntrypoint`)
and is shared by all three check scripts. `scripts/__tests__/cli-entrypoint.test.mjs`
asserts each CLI actually prints a verdict when spawned, which is what catches a
guard that fails open. Note that assertion only bites on the Windows lane — on
POSIX the old expression happened to work — so it relies on the `windows` CI job
running `pnpm test`.

### 3. The native platform packages were hardcoded, drifted, and covered only one arch

`sharp` publishes its native code as OS+CPU-specific optional dependencies.
`pnpm licenses list --no-optional` hides them entirely, and dropping
`--no-optional` is not a fix: with optional deps included, the listing reports
only the **host's** slice — two `@img` packages on a macOS arm64 dev machine,
a different set on Linux CI. Either way the notice becomes a function of the
machine that generated it.

The original workaround hardcoded the two macOS arm64 entries as literals. That
produced two separate defects:

**Drift.** A `sharp` bump left the shipped notice claiming
`@img/sharp-darwin-arm64@0.34.5` and `@img/sharp-libvips-darwin-arm64@1.2.4`
while **0.35.3 / 1.3.2** actually shipped — including in the LGPL-3.0 relink
offer, which named the wrong library version. No platform could detect it.

**Missing platforms.** Only the darwin-arm64 pair was listed. `electron-builder.yml`
ships a **universal** macOS dmg/zip and an **x64 Windows** nsis, so the artifacts
also bundle `@img/sharp-darwin-x64`, `@img/sharp-libvips-darwin-x64` and
`@img/sharp-win32-x64` — and two of those are copyleft. `@img/sharp-win32-x64`
is the sharpest case: it has no companion `@img/sharp-libvips-win32-x64` package
because it carries the libvips DLLs itself, which is why its manifest declares
`Apache-2.0 AND LGPL-3.0-or-later`. None of the three had attribution, license
text, or an LGPL relink/source offer.

Both are now fixed the same way: `SHIPPED_PLATFORM_PACKAGES` enumerates the
slices the release artifacts actually bundle, and `locateShippedPlatformPackages`
reads each one **off disk** — version, license id, description, repository URL
and license text all come from the installed package's own metadata. Nothing is
hardcoded, so a `sharp` bump cannot drift the notice, and a slice that is not
installed throws rather than degrading to a placeholder.

`pnpm-workspace.yaml`'s `supportedArchitectures` (os: darwin + win32 + current,
cpu: x64 + arm64 + current) is what makes this deterministic: it materializes
every shipped slice on every machine, so the generated notice is byte-identical
on macOS and Linux CI. **That determinism is load-bearing** — if you change
`supportedArchitectures`, or add a shipped target to `electron-builder.yml`,
update `SHIPPED_PLATFORM_PACKAGES` to match and re-check that macOS and Linux
still produce identical output.

There is deliberately no Linux slice in that list. Linux is a build gate only
(the "Validate Linux desktop build" job); there is no `linux:` block in
`electron-builder.yml`, so nothing Linux-native is distributed.

Resolution walks `node_modules` upward from `sharp`'s own installed directory,
which is how Node itself resolves a dependency and how pnpm's virtual store is
laid out (a package's dependencies are *siblings* of it inside the same
`node_modules`). It deliberately does not build a
`.pnpm/<name>@<version>` path — that is an internal pnpm layout detail, and some
store directories additionally carry a peer-dependency hash suffix.

The located version is cross-checked against `sharp`'s `optionalDependencies`
pin, because `apps/desktop/scripts/release.mjs` (`injectDarwinPlatformPackages`)
copies the **pinned** version into the packaged app. A disagreement means the
notice would name a version the artifact does not contain, so it throws.

Adding a bundled binary that is not an npm package (today: the CI-injected
FFmpeg executable)? Add it to `buildBundledBinaryRecords`, which is the only
thing exempt from the materialization check — because it is the only thing with
no installed directory to check.

### Weak-copyleft coverage

Three shipped slices carry libvips under LGPL-3.0
(`@img/sharp-libvips-darwin-arm64`, `@img/sharp-libvips-darwin-x64`, and
`@img/sharp-win32-x64`), and the FFmpeg executable is LGPL-2.1. Two wrinkles are
worth knowing:

- The `@img/sharp-libvips-*` packages ship **no license file at all**, so the
  canonical FSF texts are committed under `scripts/license-texts/` and appended
  by `buildWeakCopyleftSection`.
- `@img/sharp-win32-x64` ships a LICENSE file containing **only** the Apache-2.0
  text, despite declaring `Apache-2.0 AND LGPL-3.0-or-later`. Publishing that
  file alone would under-disclose the LGPL half, so `enrichRecord` appends a
  pointer to the weak-copyleft section after the on-disk text.

The canonical FSF text is emitted **once per license** with an explicit
"Applies to" roster, rather than repeated per binary — three copies of the
LGPL-3.0 text would add thousands of lines for no legal benefit.

## Scope

The generated notice covers:

- npm production dependencies for `@pwrsnap/desktop`
- the Electron runtime package, even though Electron is a dev dependency used
  as the packaged runtime
- renderer-emitted Geist Sans and Geist Mono webfont assets from
  `@fontsource/geist-sans` and `@fontsource/geist-mono`

The notice intentionally does not inline Chromium's large generated credits
HTML. It includes Electron's MIT runtime license and points readers to
Chromium/Electron's corresponding generated `LICENSES.chromium.html` credits.

Codex App Server Rust dependency disclosures are maintained by the user's
installed Codex distribution. PwrSnap connects to that local distribution and
does not vendor those Rust crates into this npm notice.

Build-time-only assets that are rendered into images, such as the DMG
background image, do not distribute the font software itself and are not listed
separately unless the font/software files are copied into the packaged app.

## Package license policy

`scripts/check-package-license-policy.mjs` enforces that every workspace
`package.json` declares `"license": "MIT"`:

- root workspace: `MIT`
- `apps/desktop`: `MIT`
- `packages/shared`: `MIT`
- `packages/pwrsnap`: `MIT`

If a new package is added, update the policy script explicitly. Do not rely on
an implicit default.

## Release checks

Packaged apps must include these user-viewable resources under
`Contents/Resources`:

- `THIRD_PARTY_LICENSES`
- `CHANGELOG.md`

`apps/desktop/scripts/verify-asar-contents.mjs` checks those resources after
electron-builder completes. It also keeps markdown and docs out of `app.asar`,
so the notices stay external and directly inspectable.
