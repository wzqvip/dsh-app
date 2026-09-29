# Restart the dsh web server on a given port. ASCII-only on purpose:
# Windows PowerShell 5.1 reads BOM-less files as ANSI, which mangles
# non-ASCII strings and silently breaks variable expansion (already hit once).
#
# !! WARNING - READ BEFORE USE !!
# This script KILLS the process listening on the port, AND its parent process.
# If you invoke it from a shell whose process tree descends from that server
# (e.g. an AI session served by it), THE SCRIPT WILL KILL ITSELF and never
# reach the start-new-instance step. That already happened once - see
# research/07-restart-findings.md.
# A process cannot reliably restart its own ancestor. Run this only from an
# INDEPENDENT context: another terminal, Task Scheduler, or a launcher that
# is the PARENT of dsh web (not its child).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh.ps1 -Port 3080 -DryRun
#   ... -Port 3080 -ForceFromAncestor   # override the self-kill guard (dangerous)

param(
  [int]$Port = 3080,
  [switch]$DryRun,
  # Bypass the "am I a descendant of the target?" guard
  [switch]$ForceFromAncestor
)

$ErrorActionPreference = 'Continue'

# dsh entry: prefer the current install location, fall back to the npx cache path
$binCandidates = @(
  'C:\Users\WANGZ\node_modules\@deepseek-ai\dsh\lib\bin.js',
  'C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js'
)
$bin = $binCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$log = Join-Path $PSScriptRoot ('..\restart-dsh-{0}.log' -f $Port)
$outLog = Join-Path $PSScriptRoot ('..\restart-dsh-{0}.stdout.log' -f $Port)
$errLog = Join-Path $PSScriptRoot ('..\restart-dsh-{0}.stderr.log' -f $Port)

function W([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
}

W ('=== restart begin (port={0}, dryrun={1}) ===' -f $Port, [bool]$DryRun)
if (-not $bin) { W 'ERROR: no dsh entry point found'; exit 3 }
W ('using bin: ' + $bin)

# 0) self-kill guard
#    A process cannot reliably restart a server it depends on. Two dangerous
#    directions must both be refused:
#      (a) the target is an ANCESTOR of us  -> killing it kills us
#          (this is the common real case: a tool call spawned by the very
#           server that owns the port)
#      (b) we are a DESCENDANT of the target -> same thing, seen the other way
#    Already hit once: research/07-restart-findings.md
$conn0 = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn0 -and -not $ForceFromAncestor) {
  $targetPid = [int]$conn0.OwningProcess

  # (a) walk OUR ancestry: is the target one of our ancestors?
  $cursor = $PID
  $depth = 0
  while ($cursor -and $depth -lt 32) {
    if ($cursor -eq $targetPid) {
      W ('REFUSING: the target listener (PID {0}) is an ANCESTOR of this process (PID {1}, {2} levels up).' -f $targetPid, $PID, $depth)
      W 'Killing it would kill this script (and whatever launched it).'
      W 'Run this from an independent context, e.g. a normal terminal window:'
      W ('  powershell -NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1}' -f $PSCommandPath, $Port)
      W 'Or pass -ForceFromAncestor if you really accept losing the caller.'
      exit 2
    }
    $cursor = (Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $cursor) -ErrorAction SilentlyContinue).ParentProcessId
    $depth++
  }

  # (b) walk the TARGET's ancestry: are we one of its ancestors? (kept for completeness)
  $cursor = $targetPid
  $depth2 = 0
  while ($cursor -and $depth2 -lt 32) {
    if ($cursor -eq $PID) {
      W ('REFUSING: this process (PID {0}) is an ANCESTOR of the target listener (PID {1}).' -f $PID, $targetPid)
      exit 2
    }
    $cursor = (Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $cursor) -ErrorAction SilentlyContinue).ParentProcessId
    $depth2++
  }

  W ('self-kill guard: OK - target PID {0} is neither our ancestor ({1} levels checked) nor our descendant ({2} levels checked)' -f $targetPid, $depth, $depth2)
}

# 1) who holds the port
$conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $oldPid = [int]$conn.OwningProcess
  $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  $started = if ($proc) { $proc.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } else { 'unknown' }
  W ('port {0} held by PID {1} (started {2})' -f $Port, $oldPid, $started)
} else {
  $oldPid = 0
  W ('port {0} is not currently listened on' -f $Port)
}

if ($DryRun) {
  W ('DRY RUN: would kill PID {0} and start a new instance on port {1}' -f $oldPid, $Port)
  W '=== restart end (dry run) ==='
  exit 0
}

# 2) kill the old listener (and its parent supervisor, so it cannot respawn)
if ($oldPid -gt 0) {
  $parentId = (Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $oldPid) -ErrorAction SilentlyContinue).ParentProcessId
  foreach ($target in @($oldPid, $parentId)) {
    if (-not $target) { continue }
    $tp = Get-Process -Id $target -ErrorAction SilentlyContinue
    if ($tp) {
      try {
        Stop-Process -Id $target -Force -ErrorAction Stop
        W ('killed PID {0} ({1})' -f $target, $tp.ProcessName)
      } catch {
        W ('failed to kill PID {0}: {1}' -f $target, $_.Exception.Message)
      }
    }
  }
  Start-Sleep -Seconds 4
}

# 3) wait for the port to be released
for ($i = 1; $i -le 10; $i++) {
  $still = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $still) { W ('port {0} released after {1}s' -f $Port, $i); break }
  Start-Sleep -Seconds 1
}

# 4) start a fresh instance, fully detached
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
$env:NO_COLOR = '1'
$new = Start-Process -FilePath 'node' `
  -ArgumentList @($bin, 'web', '--port', ('{0}' -f $Port), '--no-open') `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
W ('started new instance PID {0}' -f $new.Id)

# 5) verify it listens
$ok = $false
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Seconds 2
  $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { W ('listening on {0} after {1}s (PID {2})' -f $Port, ($i * 2), $c.OwningProcess); $ok = $true; break }
}
if (-not $ok) { W ('ERROR: port {0} not listening after 60s' -f $Port) }

# 6) surface child output + health check
if (Test-Path $outLog) { $s = [string](Get-Content $outLog -Raw); if ($s.Trim()) { W ('child stdout: ' + $s.Trim()) } }
if (Test-Path $errLog) { $e = [string](Get-Content $errLog -Raw); if ($e.Trim()) { W ('child stderr: ' + $e.Trim()) } }
if ($ok) {
  try { Invoke-WebRequest ('http://127.0.0.1:{0}/' -f $Port) -UseBasicParsing -TimeoutSec 10 | Out-Null }
  catch {
    $code = $_.Exception.Response.StatusCode.value__
    W ('health check / -> HTTP {0} (401 means auth is working)' -f $code)
  }
}

W '=== restart end ==='
