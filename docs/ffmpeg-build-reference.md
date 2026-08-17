# Bundled ffmpeg — where it comes from, and what it is built with

**PwrSnap does not build ffmpeg.** The binary shipped as `PwrSnapFFmpeg`
(`PwrSnapFFmpeg.exe` on Windows) is produced by a separate repo and injected
into the release stage by CI.

> **Build repo:** [pwrdrvr/pwrsnap-ffmpeg-builds](https://github.com/pwrdrvr/pwrsnap-ffmpeg-builds) (private)
> Flags: `scripts/lib/config.mjs` + `buildConfigureArgs()` in `scripts/build-ffmpeg.mjs`
> Guard: `scripts/verify-ffmpeg.mjs`

`apps/desktop/scripts/build-ffmpeg.mjs` used to build a macOS binary locally and
was **deleted 2026-08-17**. It produced a binary with a *different codec set*
than the released one, so preview DMGs and release DMGs shipped different
ffmpegs — see "Why the local builder is gone" below.

## How the binary reaches a release

`.github/workflows/release.yml` pins an exact commit of the build repo and
downloads that run's artifact:

| var | value at time of writing |
|---|---|
| `FFMPEG_BUILD_REPO` | `pwrdrvr/pwrsnap-ffmpeg-builds` |
| `FFMPEG_BUILD_WORKFLOW` | `build.yml` |
| `FFMPEG_BUILD_SHA` | `3d775403a83990a2ad9503d865f5d481d9c0316a` |
| `FFMPEG_BUILD_PROFILE` | `pwrsnap-lgpl-clean-v1` |
| macOS artifact | `ffmpeg-8.1.1-macos-universal` → `release-stage/build/ffmpeg/ffmpeg` |
| Windows artifact | `ffmpeg-8.1.1-windows-x64` → injected by `scripts/package-win.mjs` as `PwrSnapFFmpeg.exe` |

CI verifies the downloaded `manifest.json` (sha256, forbidden flags, required
encoders, required decoders, required devices) before packaging.

The decoder assertion exists because it was missing: encoders and devices were
verified from the start, decoders never were, and a build with **no PNG
decoder** shipped for two months. Every image-backed Sizzle reel failed with
`Decoding requested, but no decoder found for: png`.

> ⚠️ **`FFMPEG_BUILD_SHA` is pinned in three places** — the macOS job and the
> Windows job in `release.yml`, and the macOS preview job in
> `preview-build.yml` — plus the table above. Landing a fix in the build repo
> does nothing until **all** are bumped to the new commit, and if they drift
> apart, releases and preview DMGs ship ffmpegs built from different sources.
> `apps/desktop/scripts/windows-release-config.test.mjs` asserts every pin
> agrees, so drift fails CI instead of shipping.

## Bumping the bundled FFmpeg version

`FFMPEG_VERSION` lives in the **build repo** (`scripts/lib/config.mjs`). PwrSnap
never sees it — only the compiled artifact — so every mention of the version on
this side is a *restatement* of another repository's constant. One of those
restatements has legal weight: `THIRD_PARTY_LICENSES` carries the LGPL-2.1
attribution and the written source offer, and if it names the wrong release, we
are distributing an LGPL binary under a false notice pointing at source we did
not build from.

Bump all of these together:

| what | where |
|---|---|
| `BUNDLED_FFMPEG_VERSION` | `scripts/generate-third-party-licenses.mjs` (then `pnpm licenses:generate` and commit `THIRD_PARTY_LICENSES`) |
| `FFMPEG_VERSION` + `FFMPEG_ARTIFACT_NAME` | `.github/workflows/release.yml` — **both** the macOS and Windows jobs |
| `FFMPEG_ARTIFACT_NAME` | `.github/workflows/preview-build.yml` |
| `FFMPEG_BUILD_SHA` + `FFMPEG_SOURCE_SHA256` | both release jobs and the preview job (see the warning above) |
| the pin table | this file |

Two independent checks catch a partial bump:

- **At PR time** — `apps/desktop/scripts/windows-release-config.test.mjs`
  ("every FFmpeg version pin agrees…") requires the generator constant, every
  workflow `FFMPEG_VERSION`, every artifact name, the table above, and
  `THIRD_PARTY_LICENSES` to name one and the same version.
- **At release time** — `scripts/check-bundled-ffmpeg-notice.mjs` runs in both
  signing jobs and in the preview build, comparing the `version` in the
  downloaded artifact's `manifest.json` against the version the staged
  `THIRD_PARTY_LICENSES` claims, plus the staged `ffmpeg-<version>.tar.xz`. Only
  this one can see across the repo boundary: the PR-time test proves PwrSnap is
  self-consistent, not that it agrees with the binary it is about to ship.

> ⚠️ Bumping the version pins **without** rerunning `pnpm licenses:generate`
> leaves the notice claiming the old release. That was a latent hole until
> 2026-08-17 — it is the same defect class as the hardcoded
> `@img/sharp-darwin-arm64` version, which drifted from `0.34.5` to a shipping
> `0.35.3` with nothing able to notice (fixed in `df421b58` by deriving it from
> the installed `sharp` manifest). Deriving is not possible across repositories,
> so the version is verified instead of derived. See
> [third-party-license-notices.md](third-party-license-notices.md)
> § "How the check can fail open".

## Configure flags — snapshot taken 2026-08-17

Denormalized copy for reference only. **The build repo is authoritative**; if
these disagree, the build repo wins and this file is stale.

Shared base (`buildConfigureArgs`):

```
--prefix=<prefix>
--pkg-config=<disabled shim>     # PKG_CONFIG_MODE = "disabled-shim-v1"
--disable-autodetect
--disable-doc
--disable-debug
--disable-ffplay
--disable-ffprobe
--disable-network
--disable-shared
--enable-static
--enable-zlib                    # added 2026-08-17 — see below
```

Per platform (`PLATFORM_PROFILES`):

| | macOS | Windows |
|---|---|---|
| target | `--target-os=darwin` | `--target-os=mingw32` |
| arch | `--arch=<arm64\|x86_64>` (universal via `lipo`) | `--arch=x86_64` |
| accel | `--enable-audiotoolbox` `--enable-videotoolbox` | `--enable-d3d11va` `--enable-mediafoundation` |
| encoders | `h264_videotoolbox`, `aac` | `h264_mf`, `aac` |
| devices | — | `--enable-indev=gdigrab` |
| other | `--disable-x86asm`, `-mmacosx-version-min=14.0` | `--extra-ldflags=-static` |

These are the only two profiles. A Linux profile existed until 2026-08-17 — see
"Platform status" below.

Required **decoders** are the same on every platform — `png`, `mjpeg`, `h264`,
`aac`, `mp3` — and are verified per build, unlike the encoders above which vary
by platform.

Forbidden everywhere (asserted by `verify-ffmpeg.mjs` against the binary's own
configure line): `--enable-gpl`, `--enable-nonfree`, `--enable-libx264`,
`--enable-libx265`, `--enable-libvidstab`, `--enable-libfdk-aac`.

### Why `--enable-zlib` is load-bearing

`--disable-autodetect` switches off zlib, and ffmpeg selects its PNG codec
*through* zlib:

```
png_decoder_select="inflate_wrapper"   # ffmpeg configure:3236
inflate_wrapper_deps="zlib"            # ffmpeg configure:3046
--disable-zlib   disable zlib [autodetect]   # ffmpeg configure:348
```

Without the explicit `--enable-zlib`, released binaries shipped **with no PNG
decoder**, and every image-backed Sizzle reel failed to render — the compositor
feeds ffmpeg PNGs from the render cache (`resolveImagePath` in
`apps/desktop/src/main/handlers/sizzle-handlers.ts`). Being explicit also makes
configure *hard-fail* when zlib is absent instead of silently dropping the
codec. zlib is permissively licensed and does not affect the LGPL-clean profile.

Do not remove it, and do not add `--disable-autodetect`-style blanket switches
without re-checking `REQUIRED_DECODERS`.

## Why the local builder is gone

Three reasons, in order of how much damage each did:

1. **Two binaries, two codec sets.** Release CI injected the controlled
   artifact; preview builds (`preview-build.yml` → `package:dryrun`) ran the
   local builder, whose flags omitted `--disable-autodetect` and therefore
   *did* have PNG. A Sizzle reel worked in a preview DMG and failed in the
   release DMG built from the same commit.
2. **Dev masks both.** `resolveFfmpegPath`
   (`apps/desktop/src/main/recording/ffmpeg-resolver.ts`) falls back to whatever
   `ffmpeg` is on `PATH` — usually a full homebrew build. So "it works when I
   run the app" says nothing about the bundled binary.
3. It duplicated a whole build profile that had already drifted.

**Consequence to know about:** there is no longer any way to build ffmpeg from
this repo. A local `pnpm release` needs the artifact — set
`PWRSNAP_FFMPEG_PATH` at runtime for dev, or fetch the artifact from the build
repo for local packaging.

## Testing a codec question cheaply

You do not need a full build to answer "does the shipped binary support X".

```bash
# What the shipped binary actually has
/Applications/PwrSnap.app/Contents/Resources/PwrSnapFFmpeg -decoders | grep -w png
```

For a hypothesis about flags, run ffmpeg's `configure` only (no `make`) and read
`ffbuild/config.mak` — disabled items appear as `!CONFIG_X=yes`:

```bash
grep -E "CONFIG_(ZLIB|PNG_DECODER)\b" ffbuild/config.mak
```

## Platform status

| | built in build repo | shipped by PwrSnap |
|---|---|---|
| macOS (universal) | yes | yes |
| Windows (x64) | yes | yes — injected by `scripts/package-win.mjs` |
| Linux (x64) | no — dropped 2026-08-17 | no — there is no `linux:` section in `electron-builder.yml` |

Every platform the build repo builds is packaged by PwrSnap. That is now
enforced, not observed: the build repo's `npm run check` fails if its build
matrix and `PLATFORM_PROFILES` name different platforms, in either direction.

### Why Linux was dropped rather than wired up

The build repo produced an `ffmpeg-8.1.1-linux-x64` artifact on every run that
nothing ever downloaded. It was also unfit for the use it was waiting for: the
profile required `aac` + `mpeg4` and shipped **no H.264 encoder**, because every
common H.264 encoder on Linux needs GPL configuration or a patent-sensitive
external dependency. Video export and Sizzle reel rendering both need H.264, so
wiring that artifact into a Linux package would have failed at runtime while its
green check advertised Linux support that did not exist.

Linux packaging is Phase 8 (see `CLAUDE.md`, "macOS-first … cross-platform
deferred to Phase 8") and starts with the H.264 licensing decision, not with the
build. The restore recipe — profile shape, the `apt-get` line, and the
PwrSnap-side `electron-builder.yml` / `release.yml` wiring — lives in the comment
where the profile used to be in the build repo's `scripts/lib/config.mjs`.

**This did not require a pin bump.** The macOS and Windows profiles are unchanged
by the drop, so there is nothing for PwrSnap to pick up; `FFMPEG_BUILD_SHA` stays
where it is.
