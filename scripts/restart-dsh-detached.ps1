# Launch the restart in a fully detached way, after a delay, then exit.
# ASCII-only: Windows PowerShell 5.1 misreads BOM-less files as ANSI.
#
# The delay exists so the caller (an AI session served by that very server)
# can finish its reply before the server goes down.

param(
  [int]$Port = 3080,
  [int]$DelaySeconds = 20
)

$ErrorActionPreference = 'Continue'
$target = Join-Path $PSScriptRoot 'restart-dsh.ps1'

$cmd = 'Start-Sleep -Seconds {0}; & "{1}" -Port {2}' -f $DelaySeconds, $target, $Port

Start-Process -FilePath 'powershell' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) `
  -WindowStyle Hidden | Out-Null

Write-Output ('detached restart scheduled: port={0}, delay={1}s, script={2}' -f $Port, $DelaySeconds, $target)
Write-Output ('log will be written to: {0}' -f (Join-Path $PSScriptRoot ('..\restart-dsh-{0}.log' -f $Port)))
