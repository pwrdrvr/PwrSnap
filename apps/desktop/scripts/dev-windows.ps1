[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$DevArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$devScript = Join-Path $scriptDirectory "dev.mjs"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$previousInputEncoding = [Console]::InputEncoding
$previousOutputEncoding = [Console]::OutputEncoding
$previousPipelineEncoding = $OutputEncoding
$exitCode = 1

try {
  # Electron writes UTF-8 bytes to its inherited Windows console. Legacy
  # PowerShell consoles otherwise interpret those bytes with the OEM code page.
  [Console]::InputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom

  & $NodePath $devScript "--pwrsnap-windows-utf8-child" @DevArguments
  $exitCode = $LASTEXITCODE
}
finally {
  [Console]::InputEncoding = $previousInputEncoding
  [Console]::OutputEncoding = $previousOutputEncoding
  $OutputEncoding = $previousPipelineEncoding
}

exit $exitCode
