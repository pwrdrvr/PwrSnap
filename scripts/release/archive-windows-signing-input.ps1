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
  # Cuts the stable PwrSnap.Setup.exe alias after Authenticode verification,
  # and owns the SHA256SUMS format package-win.mjs writes. The signing job has
  # no checkout, so anything it imports must travel with it too.
  "apps/desktop/scripts/windows-release-artifacts.mjs",
  "scripts/lib/cli-entrypoint.mjs",
  "apps/desktop/scripts/verify-asar-contents.mjs",
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
