# AI 提交署名辅助脚本
#
# 用途：让 AI 产出的提交署名「蓝色大肥鱼 <wang.20306@osu.edu>」。
#
# 原理：
#   1. 署名 —— git 支持用环境变量临时覆盖 author/committer 身份，
#      所以本脚本【不修改】全局或仓库级 git config，不会污染你其它仓库的身份设置。
#   2. 头像 —— commit 对象没有头像字段；GitHub 的圆形头像只由 email 绑定的账号决定。
#      所以本脚本使用【已绑定 wzqvip 账号】的邮箱，GitHub 便会显示该账号的真实头像。
#      ⚠️ 曾用「在 commit 信息里注入图片」的办法自定义头像，【已停用并移除】：
#         HTML 注释会被 GitHub 渲染器整个剥离（无效），可见 markdown 语法虽有效
#         但会污染 `git log` 的纯文本输出，收益不成立。历史实现见提交 bfcfab9。
#
# 用法：
#   .\scripts\git-ai.ps1 -MessageFile .git/MSG.txt     # 提交
#   .\scripts\git-ai.ps1 commit -F .git/MSG.txt        # 同上（透传写法）
#   .\scripts\git-ai.ps1 push origin main              # 透传任意其它 git 子命令
#
# 机制与实测证据详见 COMMIT-IDENTITY.md。

param(
  # commit 信息文件（推荐：中文与特殊字符不会被 shell 解析）
  [string]$MessageFile,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GitArgs
)

$ErrorActionPreference = 'Stop'

# ---- AI 署名（改这里即可换名字/邮箱）----
# ⚠️ email 必须是【已验证在维护者 GitHub 账号上】的地址，否则 GitHub 关联不到账号，
#    圆形头像位置会退回默认 identicon。
#    wang.20306@osu.edu —— 已实测关联到 wzqvip（它也是账号的公开资料邮箱）。
# name 用自定义名，以便区分"人写的"与"AI 写的"。
$AiName  = '蓝色大肥鱼'
$AiEmail = 'wang.20306@osu.edu'

$env:GIT_AUTHOR_NAME     = $AiName
$env:GIT_AUTHOR_EMAIL    = $AiEmail
$env:GIT_COMMITTER_NAME  = $AiName
$env:GIT_COMMITTER_EMAIL = $AiEmail

Write-Host "[AI 署名] $AiName <$AiEmail>" -ForegroundColor Cyan

# ---- 模式 A：第一个位置参数是 git 子命令 → 透传给 git ----
# ⚠️ PowerShell 会把第一个位置参数绑到 -MessageFile，所以 `git-ai.ps1 push origin main`
#    实际是传入 MessageFile='push'。这属于【透传】意图，直接转发给 git（早先版本会误报错）。
$GitSubcommands = @('commit','push','pull','fetch','log','status','add','diff','remote','checkout','switch','restore','branch','tag','stash','reset','rebase','merge','show','rev-parse','ls-files','config')
if ($MessageFile -and $MessageFile -in $GitSubcommands) {
  & git $MessageFile @GitArgs
  exit $LASTEXITCODE
}

# ---- 模式 B：-MessageFile，直接提交 ----
if ($MessageFile) {
  if (-not (Test-Path $MessageFile)) { Write-Error "找不到信息文件: $MessageFile"; exit 1 }

  & git commit -F $MessageFile
  exit $LASTEXITCODE
}

# ---- 模式 C：显式透传（-GitArgs）或无参数时打印用法 ----
if (-not $GitArgs -or $GitArgs.Count -eq 0) {
  Write-Host "用法:" -ForegroundColor Yellow
  Write-Host "  .\scripts\git-ai.ps1 -MessageFile .git/MSG.txt     # 提交" -ForegroundColor Gray
  Write-Host "  .\scripts\git-ai.ps1 push origin main              # 透传其它 git 命令" -ForegroundColor Gray
  exit 1
}

& git @GitArgs
exit $LASTEXITCODE
