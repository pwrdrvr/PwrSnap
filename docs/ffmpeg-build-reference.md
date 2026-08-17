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
| `FFMPEG_BUILD_SHA` | `a72aa24cd310cb3aa684b2481261cb2d8e313bfd` |
| `FFMPEG_BUILD_PROFILE` | `pwrsnap-lgpl-clean-v1` |
| macOS artifact | `ffmpeg-8.1.1-macos-universal` → `release-stage/build/ffmpeg/ffmpeg` |
| Windows artifact | `ffmpeg-8.1.1-windows-x64` → injected by `scripts/package-win.mjs` as `PwrSnapFFmpeg.exe` |

CI verifies the downloaded `manifest.json` (sha256, forbidden flags, required
encoders/devices) before packaging.

> ⚠️ **`FFMPEG_BUILD_SHA` is pinned in two places** in `release.yml` — the macOS
> job and the Windows job. Landing a fix in the build repo does nothing until
> **both** are bumped to the new commit.

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

| | macOS | Windows | Linux |
|---|---|---|---|
| target | `--target-os=darwin` | `--target-os=mingw32` | `--target-os=linux` |
| arch | `--arch=<arm64\|x86_64>` (universal via `lipo`) | `--arch=x86_64` | — |
| accel | `--enable-audiotoolbox` `--enable-videotoolbox` | `--enable-d3d11va` `--enable-mediafoundation` | — |
| encoders | `h264_videotoolbox`, `aac` | `h264_mf`, `aac` | `aac`, `mpeg4` |
| devices | — | `--enable-indev=gdigrab` | — |
| other | `--disable-x86asm`, `-mmacosx-version-min=14.0` | `--extra-ldflags=-static` | — |

Forbidden everywhere (asserted by `verify-ffmpeg.mjs` against the binary's own
configure line): `--enable-gpl`, `--enable-nonfree`, `--enable-libx264`,
`--enable-libx265`, `--enable-libvidstab`, `--enable-libfdk-aac`.

Required decoders on every platform: `png`, `mjpeg`, `h264`, `aac`, `mp3`.

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
| Linux (x64) | **yes** | **no** — there is no `linux:` section in `electron-builder.yml` |

The Linux artifact is built on every build-repo run and never consumed. Either
wire up Linux packaging or drop the target; see the tracked follow-up.
