# 以"完全分离"的方式启动重启脚本，然后立刻退出。
#
# 目的：本包装进程不等结果、不占用终端，立即返回；
# 真正的重启由一个独立进程执行，结果写入 restart-dsh.log。
# 这样即使发起方（AI 会话）在重启瞬间被中断，动作也会照常完成。

$ErrorActionPreference = 'Continue'
$target = Join-Path $PSScriptRoot 'restart-dsh.ps1'

Start-Process -FilePath 'powershell' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $target) `
  -WindowStyle Hidden

Write-Output "已分离启动重启流程: $target"
Write-Output "如被中断，请查看日志: $(Join-Path $PSScriptRoot '..\restart-dsh.log')"
