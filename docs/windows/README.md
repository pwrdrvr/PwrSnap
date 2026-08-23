# PwrSnap on Windows

This guide covers the supported Windows release, where it stores data, current
limitations, troubleshooting, and source builds. PwrSnap ships for Windows 10
and Windows 11 on x64; there is no Windows Arm64 package yet.

## Release status

| Item | Shipping behavior |
| --- | --- |
| Installer | Interactive, per-user NSIS installer named `PwrSnap-<version>-windows-x64-setup.exe` |
| Default install folder | `%LOCALAPPDATA%\Programs\PwrSnap` |
| Signing | Tagged release installers and the packaged app are Authenticode-signed by PwrDrvr LLC and verified before publication |
| Updates | Packaged releases consume the `latest.yml` metadata published beside each Windows installer |
| Video dependency | Tagged releases bundle the controlled `PwrSnapFFmpeg.exe`; users do not install FFmpeg separately |

Linux builds gate the cross-platform TypeScript build in the release workflow,
but PwrSnap does not distribute a Linux desktop package.

## Install a signed release

1. For the current stable release, open
   [GitHub Releases — Latest](https://github.com/pwrdrvr/PwrSnap/releases/latest).
   For the current 1.1 prerelease line, open the main
   [Releases page](https://github.com/pwrdrvr/PwrSnap/releases); GitHub's
   `latest` route intentionally excludes prereleases.
2. Download `PwrSnap-<version>-windows-x64-setup.exe`. The `.blockmap` and
   `latest.yml` assets are for the updater, not manual installation.
3. Run the installer. It installs for the current user and lets you change the
   destination folder.
4. Launch PwrSnap from the Start menu. The default quick-capture shortcut is
   `Ctrl+Shift+C`; change any global binding under **Settings → Hotkeys**.

The currently published releases predate the workflow's version-free Windows
alias, so do not construct a `releases/latest/download/PwrSnap-windows-x64-setup.exe`
URL yet. Use the Releases page and the versioned filename above.

To verify a downloaded installer before running it:

```powershell
$installer = ".\PwrSnap-<version>-windows-x64-setup.exe"
Get-AuthenticodeSignature $installer |
  Format-List Status,StatusMessage,SignerCertificate
Get-FileHash $installer -Algorithm SHA256
```

`Status` should be `Valid`, and the signer certificate should identify
PwrDrvr LLC. Compare the hash with `PwrSnap-windows-SHA256SUMS` from the same
release. Do not bypass an unknown-publisher warning for a file presented as a
tagged PwrSnap release.

### Development previews

A maintainer can apply the `build-preview` label to a pull request to create a
Windows Actions artifact for development testing. That artifact expires after
14 days and is unsigned. It is not the same as the signed installer on a
GitHub Release and should not be handed to end users.

### winget status

PwrSnap is not currently published in the Windows Package Manager community
repository, so `winget install PwrDrvr.PwrSnap` is not a supported install path
yet. Prepared manifests and the operator submission checklist live in
[winget/README.md](winget/README.md); the repository does not submit them
automatically.

## Updates

Release builds check the selected GitHub release channel at startup and
periodically while PwrSnap is running. Under **Settings → General → Updates**,
choose a release train (Stable or Beta) and an update track (Latest or
Prerelease). **Help → Check for Updates** starts the same check on demand, and
**Restart to Update** installs a completed download.

The Windows updater requires `latest.yml`, the versioned installer, and its
`.blockmap` to remain together on the selected release. `pnpm dev` does not run
production auto-update.

## Where PwrSnap stores data

PwrSnap deliberately separates durable captures from replaceable app state.

| Data | Default location |
| --- | --- |
| Image capture bundles, video files, and chat journals | The Windows Documents known folder under `PwrSnap`, normally `%USERPROFILE%\Documents\PwrSnap` |
| SQLite library database | `%APPDATA%\PwrSnap\pwrsnap.db` |
| Settings and encrypted secrets | `%APPDATA%\PwrSnap\pwrsnap-settings.json` and `%APPDATA%\PwrSnap\pwrsnap-secrets.bin` |
| Regenerable render cache | `%APPDATA%\PwrSnap\render-cache` |
| Main log | Open **Help → Logs** and choose **Reveal**; the normal path is `%APPDATA%\PwrSnap\logs\main.log` |

The Documents known folder may be redirected to OneDrive or another managed
location, so the resolved path is more authoritative than the example above.
Images are stored as `.pwrsnap` bundles, videos as `.mp4`, and chat files under
the active capture root's `Chats` folder. The database indexes those files; it
does not replace them.

If Windows blocks the Documents folder, PwrSnap write-probes the location and
can persist a fallback to `%USERPROFILE%\PwrSnap`. Existing data is not migrated
when the active root changes, so both roots may contain files from the same
library. Do not manually move, rename, or delete capture bundles, the database,
settings, or secrets as a troubleshooting step.

## Current Windows limitations

- Windows releases are x64 only; Arm64 is not packaged.
- Windows video capture records the screen at 30 fps without microphone or
  system audio. Audio controls are not wired to the Windows recorder yet.
- Windows video currently includes the pointer even when the capture-cursor
  setting is off.
- Quick Look extensions and HEIC export are macOS-only.
- Some in-app shortcut labels still render macOS key glyphs. On Windows,
  `CommandOrControl` means `Ctrl` and `Alt` is the Windows Alt key.
- A full-window capture depends on Electron returning the selected window. If
  that path fails, use region capture; the remaining fallback is macOS-only.
- In a Remote Desktop session, Windows clipboard-redirection policy determines
  whether a copy made where PwrSnap is running reaches the other side of the
  session.

## Troubleshooting

### A shortcut does nothing

Open **Settings → Hotkeys** and rebind the command; another app may already own
the global chord. PwrSnap's defaults use `Ctrl` on Windows even if a label still
shows the macOS Command glyph. Check **Help → Logs** for `failed to register`
when a binding still does not work.

### Captures are missing or inaccessible

1. Read the capture-folder banner in the Library; it reports whether PwrSnap is
   using Documents or the home-folder fallback.
2. In **Windows Security → Virus & threat protection → Ransomware protection**,
   check Controlled Folder Access. Allow PwrSnap if it is blocked, and check any
   third-party antivirus rules as well.
3. If Documents is redirected through OneDrive, make the PwrSnap folder locally
   available and allow synchronization to finish.
4. Relaunch PwrSnap and make a small region capture. On multi-monitor or Remote
   Desktop setups, region capture is also the safest diagnostic if a full-window
   capture selects the wrong source.

Leave both `%USERPROFILE%\Documents\PwrSnap` and `%USERPROFILE%\PwrSnap` in
place if the fallback was used. Moving files outside PwrSnap can leave database
paths pointing at the old location.

### Video capture reports that FFmpeg is unavailable

A tagged Windows release includes `resources\PwrSnapFFmpeg.exe`; no PATH entry
or separate FFmpeg install is required. Re-download the versioned installer
from GitHub Releases, verify its Authenticode signature, reinstall, and retry.
An external FFmpeg override is only for local-build diagnostics.

For a recording failure, open **Help → Logs** and search for `recording`,
`ffmpeg`, `h264_mf`, or `failed`. `latest.yml` errors concern the updater and do
not explain a recording failure.

### Launch at login does not start PwrSnap

Turn on **Settings → General → Launch at login**, then confirm PwrSnap is
enabled under **Task Manager → Startup apps**. Login launches are tray-only by
design; the Library window does not open automatically.

### Updates do not appear

Confirm the desired Stable/Beta and Latest/Prerelease choices under
**Settings → General → Updates**, then use **Help → Check for Updates**. The
`pnpm dev` process simulates manual update UI but does not use the production
feed; use a published release to test real updates.

## Build from source

Run these steps on Windows 10 or Windows 11 x64. Install:

- Git.
- Node.js `v24.14.1` (the version pinned in `.nvmrc`).
- `pnpm@10.33.0` (the version pinned in the root `package.json`).
- Visual Studio Build Tools 2022 with the **Desktop development with C++**
  workload.

From the repository root:

```powershell
corepack enable
corepack prepare pnpm@10.33.0 --activate
corepack pnpm install
corepack pnpm --filter @pwrsnap/desktop build:native
corepack pnpm --filter @pwrsnap/desktop package:win
Get-ChildItem .\apps\desktop\release-stage\dist\PwrSnap-*-windows-x64-setup.exe
```

`package:win` creates an unsigned development installer. A plain local package
may omit `PwrSnapFFmpeg.exe`; production release builds do not.

### Optional FFmpeg injection for local packaging

This is a developer-only path for testing Windows recording without the
controlled release artifact. Use a compatible FFmpeg build that exposes the
`gdigrab` input and `h264_mf` encoder:

```powershell
$ffmpeg = (Get-Command ffmpeg).Source
& $ffmpeg -hide_banner -devices | Select-String gdigrab
& $ffmpeg -hide_banner -encoders | Select-String h264_mf
$env:PWRSNAP_WINDOWS_FFMPEG_PATH = $ffmpeg
corepack pnpm --filter @pwrsnap/desktop package:win
```

The packaging-time `PWRSNAP_WINDOWS_FFMPEG_PATH` variable is not an end-user
library or runtime configuration. Clear it after the local package test:

```powershell
Remove-Item Env:PWRSNAP_WINDOWS_FFMPEG_PATH -ErrorAction SilentlyContinue
```

## Release operators

The tagged release workflow in [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
stages a pinned controlled FFmpeg build, validates its manifest, checksum, and
shipped license notice, fails closed when Windows signing is unavailable,
verifies the resulting Authenticode signatures, and publishes Windows only
after the macOS and Linux gates also pass.

Authorized operators should use the
[desktop release runbook](../desktop-release-runbook.md) and
[Windows signing guide](../desktop-windows-signing.md). This user-facing guide
intentionally does not duplicate protected environment, credential, or
artifact-source details.

## Validation checklist

From the repository root:

```powershell
corepack pnpm typecheck
corepack pnpm exec vitest run `
  apps/desktop/src/main/recording/__tests__/recording-service.test.ts `
  apps/desktop/src/main/recording/__tests__/ffmpeg-resolver.test.ts `
  apps/desktop/scripts/windows-release-config.test.mjs
corepack pnpm --filter @pwrsnap/desktop build:native
corepack pnpm --filter @pwrsnap/desktop package:win
$version = (Get-Content apps\desktop\package.json | ConvertFrom-Json).version
corepack pnpm release:check --tag "v$version"
git diff --check
```

Then install the produced `.exe`, make one still capture and one short video,
and confirm both appear in the Library. Headed Windows smoke testing is not
performed by the macOS/Linux CI build gate.
