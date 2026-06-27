# PwrSnap Windows Preview

This guide is for installing, testing, and building the Windows preview of
PwrSnap. The easiest path is the prepared NSIS installer. The source-build path
is here for developers and release operators.

## Current Status

- Windows app shell, still capture, window picker, library, and tray flows are
  available in the preview installer.
- Video recording on Windows uses bundled `PwrSnapFFmpeg.exe` when present.
- If FFmpeg is not bundled, the app can still record when
  `PWRSNAP_FFMPEG_PATH` points at a compatible `ffmpeg.exe`.
- Audio capture is not wired in the Windows FFmpeg backend yet. Current Windows
  recordings are screen video only.
- The real public release still needs final Authenticode signing, update-feed
  validation, and a legally vetted Windows FFmpeg binary source.

## Use The Prepared Installer

From a local package build, the installer is written here:

```powershell
.\apps\desktop\release-stage\dist\PwrSnap-1.0.0-beta.20-windows-x64-setup.exe
```

Install and launch:

```powershell
Get-Process -Name PwrSnap -ErrorAction SilentlyContinue | Stop-Process -Force

$installer = ".\apps\desktop\release-stage\dist\PwrSnap-1.0.0-beta.20-windows-x64-setup.exe"
Start-Process -FilePath $installer -Wait

Start-Process "$env:LOCALAPPDATA\Programs\PwrSnap\PwrSnap.exe"
```

For unattended local QA, run the installer silently:

```powershell
Start-Process -FilePath $installer -ArgumentList "/S" -Wait -WindowStyle Hidden
```

Verify the installed build has bundled FFmpeg:

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\PwrSnap\resources\PwrSnapFFmpeg.exe"
```

If that prints `True`, users do not need to set `PWRSNAP_FFMPEG_PATH` for this
installer.

## Smoke Test Recording

1. Launch PwrSnap from Start Menu or:

   ```powershell
   Start-Process "$env:LOCALAPPDATA\Programs\PwrSnap\PwrSnap.exe"
   ```

2. Start video capture from the configured hotkey or tray action.
3. Select a small region, wait for the HUD, record for a few seconds, then click
   Stop.
4. Confirm the "Recording saved" float-over appears.
5. Open the Library and confirm the new video capture appears.

If the capture does not appear, inspect the log:

```powershell
Select-String -Path "$env:APPDATA\PwrSnap\logs\main.log" `
  -Pattern "recording|ffmpeg|Recording saved|native recorder|failed|error" `
  -CaseSensitive:$false |
  Select-Object -Last 120 |
  ForEach-Object { $_.Line }
```

Useful meanings:

- `starting Windows ffmpeg recorder` - the new Windows path is running.
- `Recording saved` - persistence completed and the Library should show it.
- `native recorder binary not available` - the old macOS-only build is still
  installed. Reinstall the fresh Windows build.
- `ffmpeg_not_available` - the app cannot find bundled FFmpeg or
  `PWRSNAP_FFMPEG_PATH`.
- `Unknown encoder 'h264_mf'` - the FFmpeg build is missing the encoder PwrSnap
  currently uses.
- `latest.yml` 404 - updater feed issue only; it is not a recording failure.

## Build From Source

Run from the repository root:

```powershell
cd C:\path\to\PwrSnap
```

Install prerequisites:

- Windows 10 or Windows 11.
- Git.
- Node.js `v24.14.1`.
- `pnpm@10.33.0` through Corepack.
- Visual Studio Build Tools 2022 with the "Desktop development with C++"
  workload.

Set up Node and dependencies:

```powershell
nvm install 24.14.1
nvm use 24.14.1
corepack enable
corepack prepare pnpm@10.33.0 --activate
corepack pnpm install
```

Build the Windows native helper:

```powershell
corepack pnpm --filter @pwrsnap/desktop build:native
```

Package a preview installer without bundled FFmpeg:

```powershell
corepack pnpm --filter @pwrsnap/desktop package:win
```

Package a preview installer with bundled FFmpeg:

```powershell
$env:PWRSNAP_WINDOWS_FFMPEG_PATH = "$env:USERPROFILE\scoop\apps\ffmpeg\current\bin\ffmpeg.exe"
corepack pnpm --filter @pwrsnap/desktop package:win
```

The output lands in:

```powershell
apps\desktop\release-stage\dist\PwrSnap-1.0.0-beta.20-windows-x64-setup.exe
```

## Test FFmpeg Outside PwrSnap

Install FFmpeg with Scoop:

```powershell
scoop install ffmpeg
```

Find the concrete path:

```powershell
Get-Command ffmpeg | Format-List Source,Path
```

For Scoop, the real binary is normally:

```powershell
$env:USERPROFILE\scoop\apps\ffmpeg\current\bin\ffmpeg.exe
```

Check the capabilities PwrSnap needs:

```powershell
$ff = "$env:USERPROFILE\scoop\apps\ffmpeg\current\bin\ffmpeg.exe"
& $ff -hide_banner -devices | Select-String gdigrab
& $ff -hide_banner -encoders | Select-String h264_mf
```

Both commands should print a matching line.

Run a five-second screen recording outside the app:

```powershell
$ff = "$env:USERPROFILE\scoop\apps\ffmpeg\current\bin\ffmpeg.exe"
$out = "$env:TEMP\pwrsnap-ffmpeg-test.mp4"

& $ff -hide_banner -y `
  -f gdigrab `
  -framerate 30 `
  -offset_x 0 `
  -offset_y 0 `
  -video_size 1280x720 `
  -draw_mouse 1 `
  -i desktop `
  -t 5 `
  -an `
  -c:v h264_mf `
  -b:v 8M `
  -pix_fmt yuv420p `
  -movflags +faststart `
  $out

Start-Process $out
```

Pass condition: the command creates a playable MP4 at
`$env:TEMP\pwrsnap-ffmpeg-test.mp4`.

## Set FFmpeg Manually

Use this only when the installer does not bundle `PwrSnapFFmpeg.exe`.

```powershell
[Environment]::SetEnvironmentVariable(
  "PWRSNAP_FFMPEG_PATH",
  "$env:USERPROFILE\scoop\apps\ffmpeg\current\bin\ffmpeg.exe",
  "User"
)
```

Then fully quit PwrSnap and launch it again. Environment changes are only seen
by newly started processes.

Verify:

```powershell
$ff = [Environment]::GetEnvironmentVariable("PWRSNAP_FFMPEG_PATH", "User")
$ff
Test-Path $ff
```

Clear the override when testing a bundled installer:

```powershell
[Environment]::SetEnvironmentVariable("PWRSNAP_FFMPEG_PATH", $null, "User")
```

## Release-Quality Windows Build

For a real signed Windows release, configure the protected GitHub
`windows-signing` environment with:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`
- `FFMPEG_BUILDS_APP_CLIENT_ID`
- `FFMPEG_BUILDS_APP_PRIVATE_KEY`
- optional `RELEASES_PAT`

The FFmpeg GitHub App must be installed on the private
`pwrdrvr/pwrsnap-ffmpeg-builds` repository with read-only Actions and
Contents permissions. The workflow mints a short-lived installation token
inside the protected signing job and uses it only to download the pinned
FFmpeg artifact.

The release workflow downloads the pinned
`ffmpeg-8.1.1-windows-x64` artifact from
`pwrdrvr/pwrsnap-ffmpeg-builds`, verifies `manifest.json`, checks the
binary SHA-256 from that manifest, and then stages `ffmpeg.exe` as
`PwrSnapFFmpeg.exe`.

Local release-mode packaging requires Authenticode credentials and a vetted
FFmpeg path:

```powershell
$env:WIN_CSC_LINK = "C:\secure\cert.p12"
$env:WIN_CSC_KEY_PASSWORD = "<password>"
$env:PWRSNAP_WINDOWS_FFMPEG_PATH = "C:\secure\ffmpeg.exe"

corepack pnpm --filter @pwrsnap/desktop package:win:release
```

Publishing from CI is wired through `.github/workflows/release.yml`.

## Verification Checklist

Run these before handing the installer to testers:

```powershell
corepack pnpm typecheck
corepack pnpm exec vitest run `
  apps/desktop/src/main/recording/__tests__/recording-service.test.ts `
  apps/desktop/src/main/recording/__tests__/ffmpeg-resolver.test.ts `
  apps/desktop/scripts/windows-release-config.test.mjs
corepack pnpm --filter @pwrsnap/desktop build:native
$env:PWRSNAP_WINDOWS_FFMPEG_PATH = "$env:USERPROFILE\scoop\apps\ffmpeg\current\bin\ffmpeg.exe"
corepack pnpm --filter @pwrsnap/desktop package:win
corepack pnpm release:check --tag v1.0.0-beta.20
git diff --check
```

Then install the produced `.exe`, make one still capture, make one video
recording, and confirm both appear in the Library.

## Create A Patch File

To hand the current Windows preview work to another developer as a Git patch:

```powershell
git diff --binary > pwrsnap-windows-preview.patch
```

If the patch must include new untracked files, stage them or add them with
intent-to-add first:

```powershell
git add -N docs/windows/README.md `
  apps/desktop/scripts/windows-release-config.test.mjs `
  apps/desktop/src/main/recording/__tests__/ffmpeg-resolver.test.ts

git diff --binary > pwrsnap-windows-preview.patch
```

Apply on another checkout:

```powershell
git apply pwrsnap-windows-preview.patch
```

The patch contains source and documentation changes only. The built installer
is a generated artifact and should be shared separately.
