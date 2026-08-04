[CmdletBinding()]
param(
  [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = Join-Path $scriptDirectory "run-windows.mjs"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$previousInputEncoding = [Console]::InputEncoding
$previousOutputEncoding = [Console]::OutputEncoding
$previousPipelineEncoding = $OutputEncoding
$exitCode = 1

try {
  # Windows PowerShell 5.1 otherwise decodes native stdout with the active
  # legacy console code page. Node and Playwright emit UTF-8.
  [Console]::InputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom

  $runnerArguments = @($runnerPath)
  if ($LogPath) {
    $runnerArguments += @("--log", $LogPath)
  }

  # Keep Playwright bytes out of the PowerShell object pipeline. The Node
  # runner performs the UTF-8 decode and optional UTF-8 tee itself.
  & node @runnerArguments
  $exitCode = $LASTEXITCODE
}
finally {
  [Console]::InputEncoding = $previousInputEncoding
  [Console]::OutputEncoding = $previousOutputEncoding
  $OutputEncoding = $previousPipelineEncoding
}

exit $exitCode
