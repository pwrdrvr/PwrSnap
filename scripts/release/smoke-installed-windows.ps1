<#
.SYNOPSIS
Installs and launches one Windows NSIS artifact, validates the app-owned
packaged-readiness report, then uninstalls it.

.DESCRIPTION
This is the shared preview/release controller contract. The caller supplies an
exact installer path and, for a signed lane, the expected Authenticode
publisher. The controller owns every temporary install/profile/data path under
a new RUNNER_TEMP GUID, sets the app's private smoke environment, launches the
installed PwrSnap.exe, and exits 0 only after the fixed
<userData>/packaged-windows-smoke.json report proves causal readiness and the
application exits cleanly. It always attempts silent uninstall and preserves
only bounded failure diagnostics under
RUNNER_TEMP/pwrsnap-windows-smoke-diagnostics-*.

.PARAMETER InstallerPath
Exact NSIS setup executable to install and launch.

.PARAMETER ExpectedPublisher
Optional certificate Common Name. When set, the installed PwrSnap.exe must
have a valid Authenticode signature from this publisher before launch.

.PARAMETER LaunchTimeoutSeconds
Combined bound for packaged readiness plus graceful application exit.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$ExpectedPublisher = "",

  [ValidateRange(15, 180)]
  [int]$LaunchTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw "RUNNER_TEMP must be set; the installed-app smoke never uses a user profile for temporary state."
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$smokeId = [Guid]::NewGuid().ToString("N")
$smokeRoot = Join-Path $runnerTemp "pwrsnap-windows-smoke-$smokeId"
$diagnosticsRoot = Join-Path $runnerTemp "pwrsnap-windows-smoke-diagnostics-$smokeId"
$installDir = Join-Path $smokeRoot "install"
$userData = Join-Path $smokeRoot "user-data"
$dataRoot = Join-Path $smokeRoot "data-root"
$profileRoot = Join-Path $smokeRoot "profile"
$appData = Join-Path $profileRoot "AppData/Roaming"
$localAppData = Join-Path $profileRoot "AppData/Local"
$tempDir = Join-Path $smokeRoot "temp"
$stdoutPath = Join-Path $smokeRoot "stdout.log"
$stderrPath = Join-Path $smokeRoot "stderr.log"
$reportPath = Join-Path $userData "packaged-windows-smoke.json"
$installedExe = Join-Path $installDir "PwrSnap.exe"
$installedResources = Join-Path $installDir "resources"
$pwrSnapProductCode = "c8b3bdba-25e5-5dbd-b016-8e6ce14b4982"
$pwrSnapFileClass = "PwrSnap Capture Bundle"
$installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()

$environmentNames = @(
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "PWRSNAP_E2E",
  "PWRSNAP_E2E_SKIP_REGION_PREWARM",
  "PWRSNAP_USER_DATA",
  "PWRSNAP_DATA_ROOT",
  "PWRSNAP_PACKAGED_WINDOWS_SMOKE",
  "PWRSNAP_PACKAGED_WINDOWS_SMOKE_ROOT",
  "ELECTRON_RENDERER_URL",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_OVERRIDE_DIST_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PWRSNAP_ASAR_MODULE_ROOT"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Restore-ProcessEnvironment {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
  }
}

function Get-PwrSnapProcesses {
  # A CIM failure is a safety failure, never evidence that no process exists.
  return @(Get-CimInstance Win32_Process -Filter "Name = 'PwrSnap.exe'" -ErrorAction Stop)
}

function Get-PwrSnapRegistryResidue {
  $exactPaths = @(
    "HKCU:\Software\$pwrSnapProductCode",
    "HKCU:\Software\{$pwrSnapProductCode}",
    "HKLM:\Software\$pwrSnapProductCode",
    "HKLM:\Software\{$pwrSnapProductCode}",
    "HKCU:\Software\Classes\.pwrsnap",
    "HKCU:\Software\Classes\$pwrSnapFileClass",
    "HKCU:\Software\Classes\Applications\PwrSnap.exe",
    "HKLM:\Software\Classes\.pwrsnap",
    "HKLM:\Software\Classes\$pwrSnapFileClass",
    "HKLM:\Software\Classes\Applications\PwrSnap.exe"
  )
  $found = @(
    $exactPaths | Where-Object { Test-Path -LiteralPath $_ -ErrorAction Stop }
  )

  $uninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $uninstallRoots) {
    if (-not (Test-Path -LiteralPath $root -ErrorAction Stop)) {
      continue
    }
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
      $normalizedName = $key.PSChildName.Trim([char[]]"{}").ToLowerInvariant()
      $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      if (
        $normalizedName -eq $pwrSnapProductCode -or
        $properties.DisplayName -like "PwrSnap*"
      ) {
        $found += $key.PSPath
      }
    }
  }

  return @($found | Sort-Object -Unique)
}

function Get-PwrSnapShortcutResidue {
  $folders = @(
    [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  $candidates = foreach ($folder in $folders) {
    Join-Path $folder "PwrSnap.lnk"
    Join-Path $folder "PwrSnap\PwrSnap.lnk"
  }
  return @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
}

function Assert-NoExistingPwrSnapInstallation {
  $processes = @(Get-PwrSnapProcesses)
  $registry = @(Get-PwrSnapRegistryResidue)
  $shortcuts = @(Get-PwrSnapShortcutResidue)
  $defaultInstallPaths = @(
    (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Programs\PwrSnap")
    (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) "PwrSnap")
  ) | Where-Object { Test-Path -LiteralPath $_ }
  if (
    $processes.Count -ne 0 -or
    $registry.Count -ne 0 -or
    $shortcuts.Count -ne 0 -or
    $defaultInstallPaths.Count -ne 0
  ) {
    throw (
      "Refusing to run the production-identity installer smoke over an existing PwrSnap " +
      "installation (processes=$($processes.Count), registry=$($registry.Count), " +
      "shortcuts=$($shortcuts.Count), installPaths=$($defaultInstallPaths.Count))."
    )
  }
}

function Remove-SmokeOwnedFileAssociationRemainder {
  $extensionPath = "HKCU:\Software\Classes\.pwrsnap"
  if (-not (Test-Path -LiteralPath $extensionPath -ErrorAction Stop)) {
    return
  }

  # electron-builder's APP_UNASSOCIATE removes the PwrSnap ProgID and its
  # OpenWithProgids value, but deliberately leaves the extension root behind.
  # The preflight above proved that this key did not exist before the smoke.
  # Delete it only when it has the exact inert shape created by this installer;
  # any foreign value or subkey is user state and must make cleanup fail closed.
  $extensionKey = Get-Item -LiteralPath $extensionPath -ErrorAction Stop
  $valueNames = @($extensionKey.GetValueNames())
  $subkeyNames = @($extensionKey.GetSubKeyNames())
  $hasExpectedDefault = (
    $valueNames.Count -eq 1 -and
    $valueNames[0] -eq "" -and
    $extensionKey.GetValue("") -eq $pwrSnapFileClass
  )
  $hasOnlyExpectedSubkey = (
    $subkeyNames.Count -eq 0 -or
    ($subkeyNames.Count -eq 1 -and $subkeyNames[0] -eq "OpenWithProgids")
  )
  if (-not $hasExpectedDefault -or -not $hasOnlyExpectedSubkey) {
    throw "Refusing to remove unexpected .pwrsnap registry state after uninstall."
  }

  $openWithPath = Join-Path $extensionPath "OpenWithProgids"
  if (Test-Path -LiteralPath $openWithPath -ErrorAction Stop) {
    $openWithKey = Get-Item -LiteralPath $openWithPath -ErrorAction Stop
    if (
      @($openWithKey.GetValueNames()).Count -ne 0 -or
      @($openWithKey.GetSubKeyNames()).Count -ne 0
    ) {
      throw "Refusing to remove non-empty .pwrsnap OpenWithProgids state after uninstall."
    }
  }

  Remove-Item -LiteralPath $extensionPath -Recurse -Force -ErrorAction Stop
}

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)

  if ($null -eq $Process -or $Process.HasExited) {
    return
  }
  & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
}

function Wait-ForProcessExit {
  param(
    [System.Diagnostics.Process]$Process,
    [int]$TimeoutSeconds,
    [string]$Label
  )

  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-ProcessTree -Process $Process
    throw "$Label timed out after $TimeoutSeconds seconds."
  }
  return $Process.ExitCode
}

function Assert-SamePath {
  param(
    [string]$Actual,
    [string]$Expected,
    [string]$Label
  )

  $actualPath = [IO.Path]::GetFullPath($Actual).TrimEnd("\")
  $expectedPath = [IO.Path]::GetFullPath($Expected).TrimEnd("\")
  if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label mismatch: expected $expectedPath, got $actualPath."
  }
}

function Assert-PathWithin {
  param(
    [string]$Actual,
    [string]$Root,
    [string]$Label
  )

  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd("\") + "\"
  $actualPath = [IO.Path]::GetFullPath($Actual)
  if (-not $actualPath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escaped the isolated smoke root: $actualPath."
  }
}

function Copy-BoundedTextTail {
  param(
    [string]$Source,
    [string]$Destination,
    [int]$MaxLines = 200,
    [int]$MaxChars = 65536
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    return
  }
  $lines = @(Get-Content -LiteralPath $Source -Tail $MaxLines -ErrorAction SilentlyContinue)
  $text = $lines -join "`n"
  if ($text.Length -gt $MaxChars) {
    $text = $text.Substring($text.Length - $MaxChars)
  }
  [IO.File]::WriteAllText($Destination, $text + "`n", [Text.UTF8Encoding]::new($false))
}

function Write-FailureDiagnostics {
  param([string]$FailureMessage)

  New-Item -ItemType Directory -Path $diagnosticsRoot -Force | Out-Null
  $boundedMessage = if ($FailureMessage.Length -gt 4096) {
    $FailureMessage.Substring(0, 4096)
  } else {
    $FailureMessage
  }
  [IO.File]::WriteAllText(
    (Join-Path $diagnosticsRoot "failure.txt"),
    $boundedMessage + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  Copy-BoundedTextTail -Source $stdoutPath -Destination (Join-Path $diagnosticsRoot "stdout-tail.log")
  Copy-BoundedTextTail -Source $stderrPath -Destination (Join-Path $diagnosticsRoot "stderr-tail.log")
  Copy-BoundedTextTail -Source $reportPath -Destination (Join-Path $diagnosticsRoot "report-tail.json")

  $logRoots = @($userData, $appData) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
  $logIndex = 0
  foreach ($logFile in @(
    Get-ChildItem -LiteralPath $logRoots -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -in @("main.log", "library.log") } |
      Select-Object -First 8
  )) {
    $logIndex += 1
    Copy-BoundedTextTail `
      -Source $logFile.FullName `
      -Destination (Join-Path $diagnosticsRoot "app-log-$logIndex-$($logFile.Name)")
  }
  Write-Host "Packaged Windows smoke diagnostics: $diagnosticsRoot"
}

function Assert-ValidSignature {
  param(
    [string]$Path,
    [string]$Publisher
  )

  if ([string]::IsNullOrWhiteSpace($Publisher)) {
    return
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne "Valid") {
    throw "Installed PwrSnap.exe Authenticode status is $($signature.Status)."
  }
  $publisherPattern = "(^|,\s*)CN=$([Regex]::Escape($Publisher))(,|$)"
  if ($signature.SignerCertificate.Subject -notmatch $publisherPattern) {
    throw "Installed PwrSnap.exe has unexpected signer: $($signature.SignerCertificate.Subject)."
  }
}

function Assert-InstalledResource {
  param(
    [string]$Path,
    [string]$Label,
    [switch]$RequireLeaf
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label path is missing from the packaged smoke report."
  }
  Assert-PathWithin -Actual $Path -Root $installedResources -Label $Label
  if ($RequireLeaf -and -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing from installed resources: $Path."
  }
}

function Assert-ReadyReport {
  param([object]$Report)

  if ($Report.schemaVersion -ne 1 -or $Report.status -ne "ready") {
    throw "Packaged smoke report was not ready (schema=$($Report.schemaVersion), status=$($Report.status))."
  }
  if (
    $Report.app.name -ne "PwrSnap" -or
    $Report.app.isPackaged -ne $true -or
    $Report.app.platform -ne "win32" -or
    $Report.app.arch -ne "x64" -or
    [string]::IsNullOrWhiteSpace($Report.app.version) -or
    [string]::IsNullOrWhiteSpace($Report.app.electronVersion)
  ) {
    throw "Packaged smoke report has invalid application identity."
  }
  Assert-SamePath -Actual $Report.app.execPath -Expected $installedExe -Label "process.execPath"

  Assert-SamePath -Actual $Report.isolation.smokeRoot -Expected $smokeRoot -Label "smoke root"
  Assert-SamePath -Actual $Report.isolation.userData -Expected $userData -Label "userData"
  Assert-SamePath -Actual $Report.isolation.dataRoot -Expected $dataRoot -Label "data root"
  Assert-SamePath -Actual $Report.isolation.reportPath -Expected $reportPath -Label "report path"
  Assert-PathWithin -Actual $Report.isolation.documents -Root $userData -Label "documents"
  Assert-PathWithin -Actual $Report.isolation.appData -Root $smokeRoot -Label "Electron appData"
  Assert-PathWithin -Actual $Report.isolation.sessionData -Root $smokeRoot -Label "Electron sessionData"
  Assert-PathWithin -Actual $Report.isolation.logs -Root $smokeRoot -Label "Electron logs"
  Assert-PathWithin -Actual $Report.isolation.crashDumps -Root $smokeRoot -Label "Electron crashDumps"
  Assert-PathWithin -Actual $Report.isolation.temp -Root $smokeRoot -Label "Electron temp"
  Assert-PathWithin -Actual $Report.isolation.mainLogPath -Root $smokeRoot -Label "main log"
  Assert-SamePath `
    -Actual $Report.isolation.databasePath `
    -Expected (Join-Path $dataRoot "pwrsnap.db") `
    -Label "database"
  Assert-PathWithin -Actual $Report.isolation.capturesRoot -Root $dataRoot -Label "captures"
  if ($Report.isolation.e2e -ne $true -or $Report.isolation.regionPrewarmSkipped -ne $true) {
    throw "Packaged smoke did not report the required E2E isolation posture."
  }
  foreach ($name in @("APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP")) {
    $profilePath = $Report.isolation.profileEnvironment.PSObject.Properties[$name].Value
    Assert-PathWithin -Actual $profilePath -Root $smokeRoot -Label $name
  }

  if ($Report.main.bootstrapComplete -ne $true) {
    throw "Main-process bootstrap did not complete."
  }
  if (
    $Report.renderer.readyState -ne "complete" -or
    $Report.renderer.stage -ne "library" -or
    $Report.renderer.title -ne "PwrSnap" -or
    $Report.renderer.rootMounted -ne $true -or
    $Report.renderer.libraryMounted -ne $true -or
    $Report.renderer.libraryUiState -ne "ready" -or
    $Report.renderer.libraryUiTotalLive -ne 0 -or
    $Report.renderer.brandVisible -ne $true -or
    $Report.renderer.preloadBridgeReady -ne $true -or
    $Report.renderer.libraryListOk -ne $true -or
    $Report.renderer.windowVisible -ne $true -or
    $Report.renderer.rowCount -ne 0 -or
    $Report.renderer.totalLive -ne 0 -or
    $Report.renderer.trashTotal -ne 0
  ) {
    throw "Renderer/React/preload/IPC readiness evidence is incomplete."
  }
  if (
    $Report.nativeModules.betterSqlite3.quickCheck -ne "ok" -or
    [string]::IsNullOrWhiteSpace($Report.nativeModules.betterSqlite3.sqliteVersion)
  ) {
    throw "better-sqlite3 native query evidence is incomplete."
  }
  Assert-SamePath `
    -Actual $Report.nativeModules.resourcesPath `
    -Expected $installedResources `
    -Label "native module resources"
  Assert-SamePath `
    -Actual $Report.nativeModules.betterSqlite3.databasePath `
    -Expected (Join-Path $dataRoot "pwrsnap.db") `
    -Label "open SQLite database"
  Assert-InstalledResource `
    -Path $Report.nativeModules.betterSqlite3.packagePath `
    -Label "better-sqlite3 package"
  Assert-InstalledResource `
    -Path $Report.nativeModules.betterSqlite3.bindingPath `
    -Label "better-sqlite3 binding" `
    -RequireLeaf
  if (
    $Report.nativeModules.sharp.format -ne "png" -or
    $Report.nativeModules.sharp.width -ne 2 -or
    $Report.nativeModules.sharp.height -ne 2 -or
    $Report.nativeModules.sharp.channels -ne 4 -or
    $Report.nativeModules.sharp.encodedBytes -le 0 -or
    [string]::IsNullOrWhiteSpace($Report.nativeModules.sharp.sharpVersion) -or
    [string]::IsNullOrWhiteSpace($Report.nativeModules.sharp.vipsVersion)
  ) {
    throw "Sharp/libvips encode/decode evidence is incomplete."
  }
  Assert-InstalledResource -Path $Report.nativeModules.sharp.packagePath -Label "Sharp package"
  Assert-InstalledResource `
    -Path $Report.nativeModules.sharp.platformPackagePath `
    -Label "Sharp win32 package"
  Assert-InstalledResource `
    -Path $Report.nativeModules.sharp.bindingPath `
    -Label "Sharp binding" `
    -RequireLeaf
  $libvipsDllPaths = @($Report.nativeModules.sharp.libvipsDllPaths)
  if ($libvipsDllPaths.Count -eq 0) {
    throw "Sharp report did not identify a packaged libvips DLL."
  }
  foreach ($dllPath in $libvipsDllPaths) {
    Assert-InstalledResource -Path $dllPath -Label "Sharp libvips DLL" -RequireLeaf
  }
}

function Get-InstalledPwrSnapProcesses {
  $installRoot = [IO.Path]::GetFullPath($installDir).TrimEnd("\") + "\"
  return @(
    Get-PwrSnapProcesses |
      Where-Object {
        -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
        [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
          $installRoot,
          [StringComparison]::OrdinalIgnoreCase
        )
      }
  )
}

# NSIS uses PwrSnap's stable production ProductCode even when /D points at a
# temporary directory. Never let a developer/self-hosted runner's real install
# be upgraded and then removed by this smoke.
Assert-NoExistingPwrSnapInstallation

New-Item -ItemType Directory -Path @(
  $smokeRoot,
  $userData,
  $dataRoot,
  $profileRoot,
  $appData,
  $localAppData,
  $tempDir
) -Force | Out-Null

$failureMessage = $null
$appProcess = $null
$installAttempted = $false
$installCompleted = $false
$uninstallVerified = $false

try {
  Write-Host "Installing $installer into isolated path $installDir"
  $installAttempted = $true
  $installerProcess = Start-Process `
    -FilePath $installer `
    -ArgumentList @("/S", "/D=$installDir") `
    -PassThru
  $installerExitCode = Wait-ForProcessExit `
    -Process $installerProcess `
    -TimeoutSeconds 120 `
    -Label "NSIS install"
  if ($installerExitCode -ne 0) {
    throw "NSIS installer exited with code $installerExitCode."
  }
  $installCompleted = $true
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
    throw "Installed NSIS payload is missing $installedExe."
  }
  Assert-ValidSignature -Path $installedExe -Publisher $ExpectedPublisher

  [Environment]::SetEnvironmentVariable("APPDATA", $appData, "Process")
  [Environment]::SetEnvironmentVariable("LOCALAPPDATA", $localAppData, "Process")
  [Environment]::SetEnvironmentVariable("USERPROFILE", $profileRoot, "Process")
  [Environment]::SetEnvironmentVariable("HOME", $profileRoot, "Process")
  [Environment]::SetEnvironmentVariable("TEMP", $tempDir, "Process")
  [Environment]::SetEnvironmentVariable("TMP", $tempDir, "Process")
  [Environment]::SetEnvironmentVariable("NODE_ENV", "production", "Process")
  [Environment]::SetEnvironmentVariable("PWRSNAP_E2E", "1", "Process")
  [Environment]::SetEnvironmentVariable("PWRSNAP_E2E_SKIP_REGION_PREWARM", "1", "Process")
  [Environment]::SetEnvironmentVariable("PWRSNAP_USER_DATA", $userData, "Process")
  [Environment]::SetEnvironmentVariable("PWRSNAP_DATA_ROOT", $dataRoot, "Process")
  [Environment]::SetEnvironmentVariable("PWRSNAP_PACKAGED_WINDOWS_SMOKE", "1", "Process")
  [Environment]::SetEnvironmentVariable(
    "PWRSNAP_PACKAGED_WINDOWS_SMOKE_ROOT",
    $smokeRoot,
    "Process"
  )
  foreach ($name in @(
    "ELECTRON_RENDERER_URL",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_OVERRIDE_DIST_PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PWRSNAP_ASAR_MODULE_ROOT"
  )) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }

  Write-Host "Launching installed packaged application: $installedExe"
  $appProcess = Start-Process `
    -FilePath $installedExe `
    -ArgumentList @("--user-data-dir=`"$userData`"") `
    -WorkingDirectory $installDir `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  $appExitCode = Wait-ForProcessExit `
    -Process $appProcess `
    -TimeoutSeconds $LaunchTimeoutSeconds `
    -Label "installed PwrSnap readiness and clean exit"
  if ($appExitCode -ne 0) {
    throw "Installed PwrSnap exited with code $appExitCode."
  }
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Installed PwrSnap exited without writing $reportPath."
  }

  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json -Depth 20
  Assert-ReadyReport -Report $report

  $exitDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $remaining = @(Get-InstalledPwrSnapProcesses)
    if ($remaining.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $exitDeadline)
  if ($remaining.Count -ne 0) {
    foreach ($processInfo in $remaining) {
      & taskkill.exe /PID $processInfo.ProcessId /T /F 2>&1 | Out-Null
    }
    throw "Installed PwrSnap left $($remaining.Count) process(es) running after app.quit()."
  }
  $unexpectedProcesses = @(Get-PwrSnapProcesses)
  if ($unexpectedProcesses.Count -ne 0) {
    throw "A PwrSnap process appeared outside the isolated install; it was not touched."
  }

  Write-Host "Installed PwrSnap runtime handshake passed; verifying NSIS uninstall cleanup."
} catch {
  $failureMessage = $_.Exception.Message
} finally {
  if ($null -ne $appProcess -and -not $appProcess.HasExited) {
    Stop-ProcessTree -Process $appProcess
    if ($null -eq $failureMessage) {
      $failureMessage = "Installed PwrSnap was still running during smoke cleanup."
    }
  }

  # The installer and uninstaller must observe the runner's real per-user NSIS
  # registry/shortcut locations. Only the launched app inherits the isolated
  # profile variables above.
  Restore-ProcessEnvironment

  try {
    $uninstallers = if (Test-Path -LiteralPath $installDir -PathType Container) {
      @(Get-ChildItem -LiteralPath $installDir -Filter "Uninstall*.exe" -File -ErrorAction Stop)
    } else {
      @()
    }
    if ($installCompleted -and $uninstallers.Count -ne 1) {
      throw "Expected exactly one NSIS uninstaller; found $($uninstallers.Count)."
    }
    if ($uninstallers.Count -eq 1) {
      $uninstallerProcess = Start-Process `
        -FilePath $uninstallers[0].FullName `
        -ArgumentList @("/S") `
        -PassThru
      $uninstallerExitCode = Wait-ForProcessExit `
        -Process $uninstallerProcess `
        -TimeoutSeconds 120 `
        -Label "NSIS uninstall"
      if ($uninstallerExitCode -ne 0) {
        throw "NSIS uninstaller exited with code $uninstallerExitCode."
      }
    }

    if ($installAttempted) {
      Remove-SmokeOwnedFileAssociationRemainder
    }

    if ($installAttempted) {
      $uninstallDeadline = [DateTime]::UtcNow.AddSeconds(20)
      do {
        $registryResidue = @(Get-PwrSnapRegistryResidue)
        $shortcutResidue = @(Get-PwrSnapShortcutResidue)
        $installDirectoryRemains = Test-Path -LiteralPath $installDir
        if (
          $registryResidue.Count -eq 0 -and
          $shortcutResidue.Count -eq 0 -and
          -not $installDirectoryRemains
        ) {
          $uninstallVerified = $true
          break
        }
        Start-Sleep -Milliseconds 250
      } while ([DateTime]::UtcNow -lt $uninstallDeadline)

      if (-not $uninstallVerified) {
        throw (
          "NSIS uninstall left production-identity residue " +
          "(installDir=$installDirectoryRemains, registry=$($registryResidue.Count), " +
          "shortcuts=$($shortcutResidue.Count))."
        )
      }
    } else {
      $uninstallVerified = $true
    }

    $installerShaAfterSmoke = (
      Get-FileHash -LiteralPath $installer -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($installerShaAfterSmoke -ne $installerSha256) {
      throw "Installed-app smoke modified the source installer bytes."
    }
  } catch {
    $cleanupMessage = "cleanup failed: $($_.Exception.Message)"
    $failureMessage = if ($null -eq $failureMessage) {
      $cleanupMessage
    } else {
      "$failureMessage; $cleanupMessage"
    }
  }

  if ($null -ne $failureMessage) {
    try {
      Write-FailureDiagnostics -FailureMessage $failureMessage
    } catch {
      Write-Warning "Could not write bounded smoke diagnostics: $($_.Exception.Message)"
    }
  }

  if ($uninstallVerified) {
    try {
      # Exact GUID-owned path under RUNNER_TEMP; never delete a caller-supplied
      # profile or install directory. Deletion happens only after the NSIS
      # uninstall itself proved the payload + production registry state gone.
      Remove-Item -LiteralPath $smokeRoot -Recurse -Force
    } catch {
      $cleanupMessage = "temporary smoke root cleanup failed: $($_.Exception.Message)"
      if ($null -eq $failureMessage) {
        $failureMessage = $cleanupMessage
        try {
          Write-FailureDiagnostics -FailureMessage $failureMessage
        } catch {
          Write-Warning "Could not write bounded smoke diagnostics: $($_.Exception.Message)"
        }
      } else {
        $failureMessage = "$failureMessage; $cleanupMessage"
      }
    }
  }
}

if ($null -ne $failureMessage) {
  throw $failureMessage
}

Write-Host "Installed PwrSnap readiness smoke passed: main + renderer + better-sqlite3 + Sharp/libvips + clean uninstall."
