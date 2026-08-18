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

### 3. The macOS arm64 native versions were hardcoded and drifted

The `@img/sharp-darwin-arm64` and `@img/sharp-libvips-darwin-arm64` entries are
supplemental: they are optional dependencies, so `--no-optional` hides them on
macOS and they are not installed at all on Linux CI. Because they were
hardcoded, a `sharp` bump left the shipped notice claiming
`@img/sharp-darwin-arm64@0.34.5` and `@img/sharp-libvips-darwin-arm64@1.2.4`
while **0.35.3 / 1.3.2** actually shipped — including in the LGPL-3.0 relink
offer, which named the wrong library version. No platform could detect it.

Those versions are now derived at generation time from the installed `sharp`
manifest's own `optionalDependencies` (`resolveMacArm64Versions`). `sharp` is a
plain production dependency, so it is present on every platform and this
resolves identically on macOS and Linux CI. Adding a new supplemental entry?
Derive its version the same way rather than pinning a literal.

### 4. The bundled FFmpeg version could not be derived, and so was unverified

Closed 2026-08-17, before it caused a bad release. The FFmpeg entry is the same
shape of defect as #3 — a hardcoded version in a supplemental record — but the
fix from #3 does not apply: the bundled ffmpeg is not an npm package, so there
is no installed manifest to derive from. It is built by
[pwrdrvr/pwrsnap-ffmpeg-builds](https://github.com/pwrdrvr/pwrsnap-ffmpeg-builds),
which owns `FFMPEG_VERSION` in its own `scripts/lib/config.mjs`, and PwrSnap only
ever sees the compiled artifact.

The version in the notice was therefore a hand-maintained claim about another
repository's constant, restated across the generator, both release jobs, the
preview job, and the reference doc — with nothing able to detect a partial bump.
Because releases pin `FFMPEG_BUILD_SHA`, a bump in the build repo does nothing
until PwrSnap repins; the failure mode was a repin PR that updated the workflows
and forgot to regenerate the notice. Every existing check would still pass: the
workflows only compared the downloaded artifact against their own hardcode.
Shipping that means an LGPL-2.1 attribution naming the wrong upstream release
and a written source offer resolving to source we did not build from.

Since deriving is impossible, the version is **verified** in two places instead:

- `BUNDLED_FFMPEG_VERSION` in the generator is now the single in-repo
  restatement, and `apps/desktop/scripts/windows-release-config.test.mjs`
  requires it to equal every workflow `FFMPEG_VERSION`, every artifact name, the
  pin tables in `docs/ffmpeg-build-reference.md`,
  `docs/desktop-release-runbook.md` and `docs/windows/README.md`, and the
  committed `THIRD_PARTY_LICENSES`. The floors are per source, not a total: a
  single count is satisfied by whichever sources still match, so an arm whose
  regex stops matching contributes nothing and the test stays green.
- `scripts/check-bundled-ffmpeg-notice.mjs` runs inside both signing jobs (and
  the preview build), reconciling the `version` in the downloaded artifact's
  `manifest.json` against the staged `THIRD_PARTY_LICENSES` about to be
  packaged. This is the only check that crosses the repo boundary — the PR-time
  test proves self-consistency, not agreement with the shipping binary. It uses
  node builtins plus `isCliEntrypoint`, and both signing-input tarballs list
  that helper; do not add a third-party import.

  Its first draft hand-rolled the entrypoint guard as
  `process.argv[1].endsWith(<filename>)` to dodge the `scripts/lib` import —
  reintroducing defect #2 above in a new file. That comparison is
  case-sensitive while Windows paths are not, and it is blind to symlink and
  wrapper invocations, so the gate exited 0 having checked nothing while both
  `set -e` and `if ($LASTEXITCODE -ne 0)` read success. Use `isCliEntrypoint`.

  `--source-dir` fails closed: supplied-but-absent, not-a-directory, and
  empty-directory are all errors, and the success line reports how many
  tarballs it reconciled. Callers that stage no source (the Windows job) omit
  the flag rather than passing a path that will never exist — a silent skip is
  how this arm would rot into a no-op that still prints "passed".

Both fail closed: a manifest with no `version`, an unparseable manifest, a
notice with no FFmpeg record, and a notice claiming two different versions are
all errors rather than skips. Recipe for a version bump:
[ffmpeg-build-reference.md](ffmpeg-build-reference.md)
§ "Bumping the bundled FFmpeg version".

**The general rule from #3 and #4:** a supplemental record's version must be
derived from something the build can observe. When it genuinely cannot be —
because the artifact comes from outside this repo — it must be reconciled at
release time against metadata shipped with the artifact. A literal that nothing
checks is the defect, not the literal itself.

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
