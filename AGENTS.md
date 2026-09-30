# 项目约定（维护者与协作者）

本文件记录**跨会话必须遵守**的项目约定，避免每次重新讨论。

---

## 1. 工作流：每次产出都要落库

**每完成一部分内容，就 `git commit` + `git push`。** 不要攒着。

### 原因

- 规划/设计文档是**活的**，随时可能被推翻或修正 → 有历史才能回溯
- 用户可能换环境继续 → 远端必须有最新状态
- 小步提交让每个 commit 都能独立看懂

### 粒度与信息

- **一次产出一个 commit**：一个文档、一个功能、一次修正各算一次
- Commit 信息用**祈使句**，可带前缀：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`
- **正文写"为什么"**，不要只写"改了什么"
- 中文提交信息是本项目的默认语言

### 每次提交前

```sh
git status --short          # 确认没有意外文件
git add <明确的文件列表>     # 不要习惯性 git add -A
git commit -m "..." 
git push origin main
```

### 检查清单

- [ ] 没有把 `~/.dsh` 的凭据、`.env`、个人配置提交进去
- [ ] 大文件（如 5 MB 的 registry dump）走了 `.gitignore`
- [ ] 文档改动同步了所有受影响的交叉引用（`plan.md` / `todo.md` / `README.md` / `ARCHITECTURE.md`）

---

## 1.5 提交署名：单一身份（2026-09-29 起）

| 身份 | name | email |
|---|---|---|
| **全部提交** | `蓝色大肥鱼` | `wang.20306@osu.edu` |

维护者在 2026-09-29 要求「把之前的内容都改成这个，force 一下，清理掉历史」，
随后又要求「带有改头像相关，不是内容的都清理掉或者合并掉」。于是当天整理了两轮：

1. 用 `git filter-branch` + force-push **统一全部署名**（含早期手写提交）；
2. 把 **15 条「署名/头像」元提交** fixup 成一条文档提交，`git rebase -i --root` + force-push。

**结果：25 → 11 个提交**，全部署名 `蓝色大肥鱼 <wang.20306@osu.edu>`，
log 里只剩正事与文档（文件内容一字未改）。
⚠️ 旧 commit 已不在任何分支上，但 **GitHub 仍会按旧 SHA 直接提供它们**
（实测 commit 页面与 raw URL 均 200）—— 要彻底清除需请 GitHub Support 处理；
其它克隆也应重新 clone。详见 [COMMIT-IDENTITY.md](docs/COMMIT-IDENTITY.md) §5。

**提交时用**（`scripts/git-ai.ps1` 已封装，不碰全局 config）：

```powershell
.\scripts\git-ai.ps1 commit -F .git/COMMIT_MSG_TMP.txt
.\scripts\git-ai.ps1 push origin main
```

⚠️ **绝不用 `git config user.name` 改** —— 那会污染维护者其它仓库的身份。
必须用 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 环境变量（脚本已封装）。

⚠️ **反过来要注意**：维护者**手写**提交若仍走全局身份（`Taco <163>`），
新提交就会重新出现第二种署名、历史重新变得不统一。要不要连手写提交也用这个身份由他决定，
**本文件不替他改全局配置**。

⚠️ **做 `rebase` / `amend` / `filter-branch` 前必须先设 `GIT_AUTHOR_*` 与
`GIT_COMMITTER_*`** —— 重写会生成新提交，committer 取自 git config，只保 author 会让
署名重新变成两种（本项目已踩过）。重写后自查：
`git log --format='%an <%ae>|%cn <%ce>' | Sort-Object -Unique` 应**只有一行**。
详见 [COMMIT-IDENTITY.md](docs/COMMIT-IDENTITY.md) §2.1。

⚠️ **commit 信息含特殊字符时走 `-F <文件>`**，不要内联 `-m "..."`：
中文 + `【】` + `*` 会被 PowerShell 解析，导致 `pathspec did not match` 错误。

⚠️ **头像与显示名由同一个开关决定：commit 的 email 是否绑定 GitHub 账号**。
绑定 → 头像用该账号的，**名字也渲染成该账号的 login**；未绑定 → 名字用 commit 里的
author name，但头像只剩默认占位图。两者**无法只要一半**（commit 对象里既没有头像字段，
名字也不被采用）。所以本项目现在 GitHub 上显示的是 **`wzqvip` + 维护者头像**，
而不是 `蓝色大肥鱼` —— 实测见 [COMMIT-IDENTITY.md](docs/COMMIT-IDENTITY.md) §3.2.1。
✅ **维护者 2026-09-29 已拍板：取头像，接受显示 `wzqvip`** ——
不要再为"显示中文名"去改署名或重写历史。

⚠️ `wang.20306@osu.edu` 已实测关联 `wzqvip`（它也是该账号的公开资料邮箱）；
用未绑定账号的邮箱提交，圆形位置是默认占位图 —— 本项目已踩过。
（曾用"在 commit 信息里注入图片"绕路，实测 HTML 注释被 GitHub 剥离、可见 markdown 又会
污染 `git log` 输出，**已放弃并从脚本移除**。详见 [COMMIT-IDENTITY.md](docs/COMMIT-IDENTITY.md) §3。）

---

## 2. 代码约定（实现阶段适用）

- **不声明 `@deepseek-ai/dsh*` 的 `peerDependencies`** —— 本项目刻意绕开 DSH 的版本闸门
- **不引入消耗额外 token 的默认行为** —— 花钱的能力必须显式开启
- 用户可见文案走 `ctx.locale`，否则 i18n 校验会拒绝
- **不要注册 `root` 槽位**（会 shadow 掉整个 AppFrame）
- 核心层（L1）**不得依赖**承载层（L2）—— 关掉桌宠，功能必须仍可用

### 2.1 PowerShell 脚本：两个会静默咬人的坑

`scripts/*.ps1` 是交给 **Windows PowerShell 5.1**（`powershell.exe`）跑的，不是 pwsh 7。
下面两条都在本项目**各踩过一次**，且症状都在**报错行以外**：

**① 必须存为 UTF-8 with BOM**

5.1 对**无 BOM** 的文件一律按 ANSI 解码 → 中文注释被拆坏 → 字节偏移错位 →
解析器在**完全合法**的行上报 `Unexpected token '}'`。
症状极具误导性：pwsh 7 读同一文件 `0 errors`，只有 5.1 报错。

```powershell
# 写回时显式带 BOM
$t = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($true))
```

自检（必须用 5.1，不能用 pwsh）：

```powershell
powershell.exe -NoProfile -Command "`$e=`$null;`$t=`$null;[void][System.Management.Automation.Language.Parser]::ParseFile('<绝对路径>',[ref]`$t,[ref]`$e); if(`$e.Count){`$e|%{'L'+`$_.Extent.StartLineNumber+': '+`$_.Message}}else{'OK'}"
```

**② 注释里不要写反引号**

`` ` `` 是 PowerShell 的转义字符，在注释中同样被处理，会破坏后续解析。

**③ `[string]$null` 不是空字符串**

```powershell
[string](Get-Content $f -Raw)   # 空文件 → $null → 结果是 [NullString]::Value
$e.Trim()                       # ❌ You cannot call a method on a null-valued expression
```

`restart-dsh.ps1` 因此在 2026-09-29 17:09 那次重启的**收尾阶段**报错
（重启本身已成功，但输出看起来像失败）。正确写法是先做 `$null` 检查。

---

## 3. 文档约定

| 文件 | 职责 | 改它的时机 |
|---|---|---|
| [README.md](README.md) | 给**使用者**看：这是什么、怎么用 | 能力/安装方式变化时 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 给**实现者**看：技术设计、数据流、约束 | 技术方案变化时 |
| [LAUNCHER.md](docs/LAUNCHER.md) | 启动器专属设计 | 启动器方案变化时 |
| [plan.md](plan.md) | **规划**：需求、调研、路线图、风险 | 方向性决策变化时 |
| [todo.md](todo.md) | **可执行清单**：任务、工时、门禁、待验证 | 任务有增删/完成时 |
| [CHANGELOG.md](docs/CHANGELOG.md) | 面向发布的变化记录 | 每次发布前 |
| [NOTICE.md](NOTICE.md) | 第三方许可与署名义务 | 引入/移除依赖时 |

**规则**：
- 方向性决策要**同时**更新 `README`（决策记录表）与 `plan.md`（决策表），避免两处不一致
- `todo.md` 的任务 ID 不可重复使用；插入新任务请**追加编号**，不要重排既有编号（会破坏交叉引用）
- 引用章节用 `§N.M`，改章节号时记得全局搜索修正

---

## 4. 许可与署名（**硬约束**）

- 本项目代码 **MIT**
- ⚠️ **本项目完全免费开源，不做商业用途**（2026-09-29 维护者拍板）：
  不设付费项、不做商业授权、不接商业分发
- ⚠️ **依赖并 vendor 了 `PC2005-cloud/dsh-pet` 的代码**：
  - **代码是 MIT** → 允许复制进本仓库并修改，但**必须原样保留其 `LICENSE` 与版权头**
  - **素材（立绘/动画/提示词/表情包/字体）禁止商用** → **绝不复制进本仓库**，
    运行时从已安装的 `dsh-pet` npm 包读取
  - 二创**必须在任何介绍/展示/分发处署名**：<https://github.com/PC2005-cloud/dsh-pet>
- 详见 [NOTICE.md](NOTICE.md) 与 [CONTRIBUTING.md](docs/CONTRIBUTING.md)

### 4.1 vendor 清单（内联复用第三方代码时在此登记）

| 上游 | 许可 | vendor 范围 | 落位 | 日期 |
|---|---|---|---|---|
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | MIT | **仅代码**（`src/` + `runtime/` + 构建脚本），**不含 `assets/`** | `packages/dsh-efficiency/vendor/dsh-pet/`（实施中） | 2026-09-29 |

**规则**：
- vendor 目录内必须带上游 `LICENSE` 原文
- 记录上游版本号（便于日后对比升级）
- 我们对其做的改动要能看出边界（保留原文件头注释 + 在改动处标明）

### 4.2 包结构决策（2026-09-29）

桌宠能力**并入** `packages/dsh-efficiency`，不再作为独立插件存在：

```
packages/dsh-efficiency/          一个包 = 桌宠 + 提问作答 + 设置 GUI
├── vendor/dsh-pet/               上游代码（MIT，带 LICENSE）
├── src/host/                     宿主半侧（含宠物宿主 + 提问捕获）
├── src/client/                   浏览器半侧
└── src/desktop/                  桌面半身（Electron 主进程 + 渲染层）
```

理由：维护者要求"做成一整个控件"；且合并后设置 GUI 可同时管宠物与效率功能。

⚠️ 例外：**素材仍从已安装的 `dsh-pet` 读**（禁商用，不能进仓库）。

---

## 5. 项目定位（判断需求时用）

> **效率工具：让 agent 的提问主动找到你，而不是让你守着网页。**

判断某个需求该不该做，问三个问题：

1. 这能不能**减少一次上下文切换**？
2. 它是不是**消耗额外 token**？（是 → 必须默认关闭且显式开启）
3. 去掉它，**核心功能还成立吗**？（不成立 → 说明它不该是可选模块）

**主线**：R0 提问触达 · R0b 进度感知（零成本）
**可选**：桌宠形象 · galgame · 显示模式 · 进度气泡
**独立**：局域网/手机（纯 Web 能力，与桌宠无关） · 启动器（分发层）
