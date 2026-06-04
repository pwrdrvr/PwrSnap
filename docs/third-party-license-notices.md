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
