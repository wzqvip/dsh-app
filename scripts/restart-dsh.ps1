# Restart the dsh web server on a given port. ASCII-only on purpose:
# Windows PowerShell 5.1 reads BOM-less files as ANSI, which mangles
# non-ASCII strings and silently breaks variable expansion (already hit once).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh.ps1 -Port 3080
#   ... -Port 3098 -DryRun        # exercise the logic without touching 3080

param(
  [int]$Port = 3080,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$bin = 'C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js'
$log = Join-Path $PSScriptRoot ('..\restart-dsh-{0}.log' -f $Port)
$outLog = Join-Path $PSScriptRoot ('..\restart-dsh-{0}.stdout.log' -f $Port)
$errLog = Join-Path $PSScriptRoot ('..\restart-dsh-{0}.stderr.log' -f $Port)

function W([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
}

W ('=== restart begin (port={0}, dryrun={1}) ===' -f $Port, [bool]$DryRun)

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
