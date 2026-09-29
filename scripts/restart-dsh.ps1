# 分离式重启 dsh web —— 结果写日志，供人查看
#
# 为什么是"分离式"：承载本对话的进程很可能就是被重启的那个，
# 一旦重启，发起者的回答链路会中断，无法亲自回报结果。
# 所以把动作交给一个独立进程，结果落盘到日志。

$ErrorActionPreference = 'Continue'
$log = "$PSScriptRoot\..\restart-dsh.log"
$bin = 'C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js'
$port = 3080

function W($m) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Add-Content -Path $log -Value $line -Encoding UTF8 }

W "=== 重启开始 ==="

# 1) 找出当前占用目标端口的进程
$conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { W "端口 $port 无人监听，直接启动"; $oldPid = $null }
else {
  $oldPid = $conn.OwningProcess
  $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  W "旧进程 PID=$oldPid  启动时间=$($proc.StartTime)"
}

# 2) 结束旧进程
if ($oldPid) {
  try { Stop-Process -Id $oldPid -Force -ErrorAction Stop; W "已结束旧进程 $oldPid" }
  catch { W "结束旧进程失败: $($_.Exception.Message)" }
  Start-Sleep -Seconds 4
}

# 3) 确认端口已释放
$still = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($still) { W "⚠️ 端口 $port 仍被占用（PID=$($still.OwningProcess)），尝试继续"; Start-Sleep -Seconds 3 }
else { W "端口 $port 已释放" }

# 4) 启动新实例
$outLog = "$PSScriptRoot\..\restart-dsh.stdout.log"
$errLog = "$PSScriptRoot\..\restart-dsh.stderr.log"
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
$env:NO_COLOR = '1'
$p = Start-Process -FilePath 'node' `
  -ArgumentList @($bin, 'web', '--port', "$port", '--no-open') `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
W "已启动新实例 PID=$($p.Id)"

# 5) 等待并校验
$ok = $false
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Seconds 2
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { W "第 $($i*2)s：端口 $port 已监听（PID=$($c.OwningProcess)）"; $ok = $true; break }
}
if (-not $ok) { W "❌ 60 秒内未监听端口 $port" }

if (Test-Path $outLog) { W "新实例 stdout: $((Get-Content $outLog -Raw).Trim())" }
if (Test-Path $errLog) { $e = (Get-Content $errLog -Raw).Trim(); if ($e) { W "新实例 stderr: $e" } }

# 6) HTTP 健康检查
if ($ok) {
  try { Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 10 | Out-Null }
  catch { W "健康检查 / -> HTTP $($_.Exception.Response.StatusCode.value__)（401 = 认证正常）" }
}

W "=== 重启结束 ==="
