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

`.github/workflows/release.yml` and the Windows dev provisioner consume the
same `scripts/ffmpeg/release-pin.json`. The dependency repository publishes
immutable releases named `ffmpeg-build-<full-build-harness-commit-SHA>`.
These raw dependency assets are independent of expiring Actions artifacts.

**Activation is currently blocked.** The old build commit
`3d775403a83990a2ad9503d865f5d481d9c0316a` lost its Actions artifacts and
uses a retired macOS runner. The corrected producer must use standard
`macos-26`, with FFmpeg **8.1.1**, source SHA-256
`b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3`, and
profile **pwrsnap-lgpl-clean-v1** unchanged. Its new build-harness commit
becomes the new source identity. The pin file contains a concrete blocker,
not invented digests; both prepare jobs reject it before signing approval.
Do not merge the consumer until publication and digest review are complete.

The producer first requires repository immutable releases to be enabled. It
validates successful owned `build.yml` run/attempt/commit provenance and both
platform outputs, creates a draft at that exact commit, uploads all assets,
checks API digests, then publishes immutable, non-Latest dependency assets.
Existing tags/releases are never overwritten. PR builds cannot publish.

To activate consumption, replace the blocker with the publisher's reviewed
pin object: `buildSha`, `manifestSha256`, and `archives` with SHA-256 values
for **both** `macos-universal` and `windows-x64`. Review these independently
in the PwrSnap PR; never adopt hashes from a download automatically. The
release manifest itself binds exact source identity and run provenance to
both archive hashes, sizes, and every payload file's digest and size.

The consumer requires a published immutable release, its tag pointing directly
at the pinned build commit, an exact asset inventory, API digests matching
independent pins, matching downloaded bytes, then full source/profile/target,
configuration, codec, binary and legal-payload validation. Forbidden flags
come from owned code, never solely from the downloaded manifest's list.
Every platform must supply `manifest.json`, `SOURCE-OFFER.txt`,
`LGPL-NOTICE.txt`, and `source/ffmpeg-8.1.1.tar.xz` with its checksum.
The source archive is hashed as opaque bytes; no source is inspected.
No mutable release or transient-artifact fallback exists.

macOS consumes `ffmpeg-8.1.1-macos-universal.tar.gz`. Apple Silicon packages
extract its ARM64 slice before signing; `ffmpeg-macos-arm64-slice.json`
records original and extracted hashes. Windows consumes
`ffmpeg-8.1.1-windows-x64.tar.gz`. Platform manifests/offers/notices accompany
the PwrSnap release; the identical source archive and checksum are shared.
These changes do not alter any signing requirement.

## Preview dependency retention

PR previews identify the vetted v1.1.19 release payloads by immutable URLs and
SHA-256 pins, but only request release JSON metadata.
`scripts/preview-build-assets.py` restores the installer, manifest, source and
notices through `scripts/build-artifact.py` from the successful tagged release
build. It verifies published size/digest, exact tag commit and workflow provenance.
The signed macOS helper is also checked after extraction; the FFmpeg 8.1.1
profile and source notices are unchanged.

Release artifacts are retained for 90 days. Before a preview pin expires, update
both platforms to a retained vetted release and recompute the installer/helper
pins. Missing or expired artifacts fail the preview; release-download fallback
is prohibited. PR jobs use only the read-only GitHub token, without signing or
private build-repository credentials.

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
| the `ffmpeg-<version>-*-{manifest.json,SOURCE-OFFER.txt,LGPL-NOTICE.txt}` copy targets | both workflows — six shell literals, easy to miss because they are not `env:` values |
| Build commit and independent asset digests | `scripts/ffmpeg/release-pin.json`; review producer source/run and both platforms together |
| `FFMPEG_SOURCE_SHA256` | both release jobs and `scripts/ffmpeg/contract.mjs` |
| Windows dev artifact pin | shared `scripts/ffmpeg/release-pin.json` and `scripts/ffmpeg/contract.mjs` |
| the pin tables | this file, `docs/desktop-release-runbook.md`, `docs/windows/README.md` |

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
this repo. On Windows, `pnpm dev` downloads the exact pinned controlled artifact
on first use, verifies the same independent release and payload pins, and caches it under
`~/.pwrsnap/dev/bin/ffmpeg/<build-sha>/<archive-sha256>/windows-x64/`.
Every reuse verifies the pinned release manifest and full payload, including
source, notices and binary; old caches containing only a self-hashed manifest
are not accepted. It then sets
`PWRSNAP_FFMPEG_PATH` only in the dev child environment. The download uses the
authenticated GitHub CLI because the build repo is private; run
`gh auth login --hostname github.com` or provide an explicit vetted
`PWRSNAP_FFMPEG_PATH` override. Packaged releases still receive the binary only
through the protected release workflow.

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

The build repo produced a Linux x64 artifact on every run that nothing ever
downloaded. It was also unfit for the use it was waiting for: the
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
by the drop. That historical cleanup did not change the consumer pin.
The retention repair above requires a new build identity for its runner change.
