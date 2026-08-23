[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Git for Windows' tar follows pnpm workspace junctions. The Windows release
# stage is deliberately hoisted so this virtual-root directory must not exist;
# otherwise archiving can recurse back into the workspace indefinitely.
$workspaceLinkRoot = "apps/desktop/release-stage/node_modules/.pnpm/node_modules"
if (Test-Path -LiteralPath $workspaceLinkRoot) {
  throw "Windows release-stage must not contain $workspaceLinkRoot; archive only the hoisted signing input."
}

$paths = @(
  "apps/desktop/release-stage",
  "apps/desktop/scripts/package-win.mjs",
  "apps/desktop/scripts/sharp-platform-packages.mjs",
  "apps/desktop/scripts/verify-asar-contents.mjs",
  # The signing job has no checkout, so every check it runs must travel with the
  # stage it validates — including anything those checks import. This list is an
  # allowlist, so a missing transitive import is not a lint error here, it is an
  # ERR_MODULE_NOT_FOUND inside the protected job *after* Azure signing has run.
  # verify-asar-contents.mjs has imported cli-entrypoint.mjs since #426, which
  # updated the macOS allowlist in release.yml and missed this one.
  # `windows signing input covers every transitive import` in
  # apps/desktop/scripts/windows-release-config.test.mjs now resolves the
  # imports and fails if this list falls behind again.
  "scripts/lib/cli-entrypoint.mjs",
  "scripts/check-bundled-ffmpeg-notice.mjs",
  "scripts/release/install-trusted-signing.ps1"
)
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required Windows signing input is missing: $path"
  }
}

& tar.exe -czf $ArchivePath @paths
if ($LASTEXITCODE -ne 0) {
  throw "Failed to archive Windows signing input (exit code $LASTEXITCODE)."
}
