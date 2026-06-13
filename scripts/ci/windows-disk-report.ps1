<#
.SYNOPSIS
  Windows CI disk diagnostics — measures free space and the size of
  directories we could safely clear before the Desktop E2E job, to
  estimate how much headroom a pre-E2E cleanup would buy.

.DESCRIPTION
  DIAGNOSTIC ONLY. This script never deletes anything; it only reads
  sizes and prints a report. It exists because a Linux E2E run failed
  with the runner down to 17 MB free, and we want hard numbers (per
  platform) on what a cleanup step would reclaim before committing to
  one. Run it at two points in the job (before install, before E2E) to
  see how much install + build consume and how much headroom remains.

  Directory sizes use `robocopy /l` (list-only) which is dramatically
  faster than Get-ChildItem -Recurse on the runner's large preinstalled
  trees (Android SDK, Visual Studio, …).

.PARAMETER Label
  A short tag printed in the header so the two invocations are
  distinguishable in the log (e.g. "before install", "before E2E").
#>
param(
  [string]$Label = "disk report"
)

$ErrorActionPreference = "Continue"

function Get-DirSizeBytes {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $sink = Join-Path $env:TEMP ("disksink_" + [System.Guid]::NewGuid().ToString("N"))
  # /l list-only (no copy), /e all subdirs, /bytes exact byte counts,
  # /nfl /ndl /nc no per-file/dir/class lines, /np no progress,
  # /r:0 /w:0 no retries. The job-summary footer (which carries the
  # "Bytes :" total) is still printed because we do NOT pass /njs.
  $output = robocopy $Path $sink /l /e /bytes /nfl /ndl /nc /np /r:0 /w:0 2>$null
  $line = $output | Where-Object { $_ -match '^\s*Bytes :' } | Select-Object -First 1
  if (-not $line) { return 0 }
  if ($line -match 'Bytes :\s+([0-9]+)') { return [long]$Matches[1] }
  return 0
}

function Format-GB {
  param([Nullable[long]]$Bytes)
  if ($null -eq $Bytes) { return "       n/a" }
  return ("{0,8:N2} GB" -f ($Bytes / 1GB))
}

Write-Host "================ Windows disk diagnostics: $Label ================"

# 1. Free space per fixed drive.
Write-Host "`n-- Drives --"
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  Write-Host ("  {0}  free {1} / {2}" -f $_.DeviceID, (Format-GB $_.FreeSpace), (Format-GB $_.Size))
}
$systemDrive = "$env:SystemDrive"
# Cast to [long] so later `$freeNow + $reclaimable` stays integer (UInt64
# + Int64 would otherwise promote to [double]).
$freeNow = [long]((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$systemDrive'").FreeSpace)

# 2. Preinstalled runner directories. `clearable` = not needed to install
#    deps, rebuild the native sidecar (which needs MSVC — kept), build the
#    app, and run Electron + Playwright. Sizes for non-clearable rows are
#    reported for context but excluded from the estimate.
$candidates = @(
  @{ name = "Android SDK";        path = $env:ANDROID_SDK_ROOT;                         clearable = $true  }
  @{ name = "Android (ANDROID_HOME)"; path = $env:ANDROID_HOME;                         clearable = $true  }
  @{ name = ".NET (dotnet)";      path = "$env:ProgramFiles\dotnet";                    clearable = $true  }
  @{ name = "SQL Server";         path = "$env:ProgramFiles\Microsoft SQL Server";      clearable = $true  }
  @{ name = "MongoDB";            path = "$env:ProgramFiles\MongoDB";                   clearable = $true  }
  @{ name = "MySQL";              path = "$env:ProgramFiles\MySQL";                     clearable = $true  }
  @{ name = "PostgreSQL";         path = "$env:ProgramFiles\PostgreSQL";                clearable = $true  }
  @{ name = "LLVM";               path = "$env:ProgramFiles\LLVM";                      clearable = $true  }
  @{ name = "Rust (rustup)";      path = (Join-Path $env:USERPROFILE ".rustup");        clearable = $true  }
  @{ name = "Rust (cargo)";       path = (Join-Path $env:USERPROFILE ".cargo");         clearable = $true  }
  @{ name = "Haskell (ghcup)";    path = "C:\ghcup";                                    clearable = $true  }
  @{ name = "Chocolatey";         path = "$env:ProgramData\chocolatey";                 clearable = $true  }
  # Kept — load-bearing for our pipeline, measured for context only.
  @{ name = "Visual Studio (x64)"; path = "$env:ProgramFiles\Microsoft Visual Studio"; clearable = $false }
  @{ name = "Visual Studio (x86)"; path = "${env:ProgramFiles(x86)}\Microsoft Visual Studio"; clearable = $false }
  @{ name = "hostedtoolcache (active Node)"; path = $env:RUNNER_TOOL_CACHE;             clearable = $false }
)

Write-Host "`n-- Preinstalled directories (candidates to clear before E2E) --"
$reclaimable = [long]0
foreach ($c in $candidates) {
  $bytes = Get-DirSizeBytes -Path $c.path
  if ($null -eq $bytes) { continue }  # not present on this image — skip
  $tag = if ($c.clearable) { "[clear]" } else { "[keep ]" }
  Write-Host ("  {0} {1,-26} {2}  {3}" -f $tag, $c.name, (Format-GB $bytes), $c.path)
  if ($c.clearable) { $reclaimable += $bytes }
}

# 3. Our own footprint (already needed once installed/built — reported
#    for context, not counted as reclaimable).
Write-Host "`n-- PwrSnap footprint (context, not reclaimable) --"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pnpmStore = (& pnpm store path 2>$null)
$footprint = @(
  @{ name = "repo node_modules"; path = (Join-Path $repoRoot "node_modules") }
  @{ name = "pnpm store";        path = $pnpmStore }
  @{ name = "electron cache";    path = (Join-Path $env:LOCALAPPDATA "electron\Cache") }
  @{ name = "electron-builder";  path = (Join-Path $env:LOCALAPPDATA "electron-builder\Cache") }
  @{ name = "ms-playwright";     path = (Join-Path $env:LOCALAPPDATA "ms-playwright") }
)
foreach ($f in $footprint) {
  $bytes = Get-DirSizeBytes -Path $f.path
  if ($null -eq $bytes) { continue }
  Write-Host ("  {0,-26} {1}  {2}" -f $f.name, (Format-GB $bytes), $f.path)
}

# 4. The headline estimate.
Write-Host "`n-- Estimate --"
Write-Host ("  Free now on {0}            {1}" -f $systemDrive, (Format-GB $freeNow))
Write-Host ("  Reclaimable (sum of [clear]) {0}" -f (Format-GB $reclaimable))
Write-Host ("  Free after hypothetical cleanup {0}" -f (Format-GB ($freeNow + $reclaimable)))
Write-Host "==================================================================`n"

# Never fail the job on a diagnostics quirk (robocopy sets non-zero exit
# codes even in list mode).
exit 0
