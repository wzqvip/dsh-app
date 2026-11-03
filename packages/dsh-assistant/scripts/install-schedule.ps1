<#
.SYNOPSIS
    为 dsh-assistant 安装/卸载 Windows 计划任务（定时主动查看 + 每日摘要）。

.DESCRIPTION
    注册两个任务：
      1. DshAssistant-Poll     每 N 分钟跑一次 `run-assistant.mjs --once`
      2. DshAssistant-Digest   每天 08:00 跑一次 `--digest-only`（本周 DDL 摘要）

    为什么用计划任务而不是常驻进程：
      常驻进程在关机/重启/关终端后就没了，而"定时提醒"最怕的就是**悄悄停了**。
      计划任务由系统托管，重启后仍在，且每轮都是独立进程（状态落磁盘，天然可恢复）。

    为什么两个任务而不是一个：
      提醒要高频看（45 分钟），摘要要固定时刻（早 8 点）。混在一起会让摘要时间漂移。

.PARAMETER Remove
    卸载这两个任务。

.PARAMETER IntervalMinutes
    轮询间隔（分钟），默认 45。

.PARAMETER DigestTime
    每日摘要时间（HH:mm），默认 08:00。

.PARAMETER DryRun
    只打印将要注册的内容，不实际注册。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-schedule.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Remove
#>
param(
    [switch]$Remove,
    [int]$IntervalMinutes = 45,
    [string]$DigestTime = '08:00',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$pollTaskName = 'DshAssistant-Poll'
$digestTaskName = 'DshAssistant-Digest'

# 卸载
if ($Remove) {
    foreach ($name in @($pollTaskName, $digestTaskName)) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($existing) {
            if ($DryRun) {
                Write-Host "[schedule] (dry) 将卸载 $name"
            }
            else {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
                Write-Host "[schedule] 已卸载 $name"
            }
        }
        else {
            Write-Host "[schedule] 不存在，跳过 $name"
        }
    }
    return
}

# 定位 node 与脚本
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$runScript = Join-Path $PSScriptRoot 'run-assistant.mjs'
$workDir = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $runScript)) {
    throw "找不到 $runScript"
}
if (-not (Test-Path $nodeExe)) {
    throw "找不到 node.exe"
}

$commonSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

function Show-Action($label, $argLine) {
    Write-Host "[schedule] $label"
    Write-Host "            程序: $nodeExe"
    Write-Host "            参数: $argLine"
    Write-Host "            目录: $workDir"
}

$pollArgs = '"{0}" --once --interval {1}' -f $runScript, $IntervalMinutes
$digestArgs = '"{0}" --digest-only' -f $runScript

Write-Host "[schedule] node = $nodeExe"
Show-Action '轮询任务' $pollArgs
Show-Action '摘要任务' $digestArgs

if ($DryRun) {
    Write-Host '[schedule] (dry) 未实际注册'
    return
}

# 轮询任务：每 N 分钟
$pollAction = New-ScheduledTaskAction -Execute $nodeExe -Argument $pollArgs -WorkingDirectory $workDir
$pollTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $pollTaskName -Action $pollAction -Trigger $pollTrigger -Principal $principal -Settings $commonSettings -Description 'dsh-assistant: 定时查看 Canvas 并推送新截止/改期/提醒' -Force | Out-Null
Write-Host "[schedule] 已注册 $pollTaskName（每 $IntervalMinutes 分钟）"

# 摘要任务：每天 HH:mm
try {
    $digestAt = [datetime]::ParseExact($DigestTime, 'HH:mm', $null)
}
catch {
    throw "DigestTime 格式应为 HH:mm，收到 $DigestTime"
}
$digestAction = New-ScheduledTaskAction -Execute $nodeExe -Argument $digestArgs -WorkingDirectory $workDir
$digestTrigger = New-ScheduledTaskTrigger -Daily -At $digestAt
Register-ScheduledTask -TaskName $digestTaskName -Action $digestAction -Trigger $digestTrigger -Principal $principal -Settings $commonSettings -Description 'dsh-assistant: 每日早报（未来 7 天截止摘要）' -Force | Out-Null
Write-Host "[schedule] 已注册 $digestTaskName（每天 $DigestTime）"

Write-Host ''
Write-Host '[schedule] 当前状态：'
foreach ($name in @($pollTaskName, $digestTaskName)) {
    $task = Get-ScheduledTask -TaskName $name
    $info = Get-ScheduledTaskInfo -TaskName $name
    Write-Host ("  {0}  State={1}  NextRun={2}" -f $name, $task.State, $info.NextRunTime)
}

Write-Host ''
Write-Host '[schedule] 手动触发一次以验证：'
Write-Host "  Start-ScheduledTask -TaskName $pollTaskName"
Write-Host "  然后看日志： $env:USERPROFILE\.dsh-assistant\run.log"
