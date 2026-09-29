@echo off
REM ============================================================
REM  dsh 开发实例（独立环境，不碰生产 ~/.dsh）
REM
REM  为什么需要它：
REM    生产服务若从 npx 缓存（...\_npx\<hash>\...）里跑，
REM    之后任何一次 `npx @deepseek-ai/dsh ...` 都会试图 reify
REM    那个正在被运行的目录，锁被破坏 -> ECOMPROMISED。
REM    本脚本用【裸 node + 稳定安装路径】，全程不经过 npm。
REM
REM  输出会同时写到控制台与 profile 目录下的 dev-instance.log。
REM  停止：关闭本窗口，或按 Ctrl+C。
REM ============================================================

set "DSH_HOME=%USERPROFILE%\dsh-dev"
set "DSH_BIN=C:\Users\WANGZ\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "PORT=3097"
set "NO_COLOR=1"
set "LOGDIR=%DSH_HOME%\logs"
set "LOG=%LOGDIR%\dev-instance.out.log"
set "ERR=%LOGDIR%\dev-instance.err.log"

title dsh DEV instance (port %PORT%)

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1

echo ============================================
echo  dsh DEV instance
echo  DSH_HOME = %DSH_HOME%
echo  entry    = %DSH_BIN%
echo  port     = %PORT%
echo  log      = %LOG%
echo ============================================
echo.

if not exist "%DSH_BIN%" (
  echo [ERROR] dsh entry not found: %DSH_BIN%
  echo         install it first, then retry.
  pause
  exit /b 1
)

REM 前台运行：本窗口即实例。输出用 tee 效果（控制台 + 文件）。
node "%DSH_BIN%" web --port %PORT% --no-open > "%LOG%" 2> "%ERR%"
set "RC=%ERRORLEVEL%"

echo.
echo [dsh dev] exited with code %RC%
echo [dsh dev] last lines of stdout:
powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 12 -ErrorAction SilentlyContinue"
echo.
echo Press any key to close.
pause >nul
