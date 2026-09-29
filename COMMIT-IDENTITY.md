# 提交署名与头像

本项目**自 2026-09-29 起只有一个署名身份**：

---

## 1. 唯一身份

| 身份 | name | email | 用于 |
|---|---|---|---|
| **全部提交** | `蓝色大肥鱼` | `wang.20306@osu.edu` | 维护者的提交 + AI 助手的提交 |

**为什么现在只有一个**：维护者在 2026-09-29 明确要求
「把之前的内容都改成这个，force 一下，清理掉历史」——
即**放弃"人写的 / AI 写的"两分**，并把**全部 23 个提交**（含早期手写提交）
用 `git filter-branch` 重写成上面这一个署名，再 force-push 覆盖远端。
重写记录与代价见 §5。

⚠️ **头像与显示名**：`wang.20306@osu.edu` 已实测绑定在该仓库所属的 GitHub 账号 `wzqvip`
（id `30136639`，它也是该账号的公开资料邮箱），所以提交列表里显示的是
`avatars.githubusercontent.com/u/30136639` 这张真实头像。
⚠️ 但**名字不是 `蓝色大肥鱼`，而是账号 login `wzqvip`** —— 头像和显示名被同一个开关
（email 是否绑定账号）绑在一起，见 §3.2.1。
机制与实测证据见 §3。

### 1.1 身份变更历史

| 阶段 | email | 圆形头像 | 原因 |
|---|---|---|---|
| 早期 | `bluefatfish@users.noreply.github.com` | ❌ 默认 identicon | 该 noreply 地址未绑定任何账号 |
| 中期 | `wangziqi2002vip@163.com` | ✅ 维护者头像 | 换成账号上已验证的邮箱 |
| 2026-09-29 | `wang.20306@osu.edu` | ✅ 同一个头像 | 先用于 AI 提交，随后**重写全部历史**统一到它 |

> 上表是**过程记录**。重写之后，本仓库里已经没有任何用前两个邮箱署名的提交了
> （旧 SHA 也随之失效，见 §5）。

---

## 2. 怎么用（不污染全局配置）

**不要**用 `git config user.name` 去改 —— 那会污染你所有仓库的身份。
用**环境变量**方式，只对当前进程生效（`scripts/git-ai.ps1` 已封装）：

```powershell
# 把提交信息写进文件（中文与特殊字符不会被 shell 解析），然后：
.\scripts\git-ai.ps1 -MessageFile .git/MSG.txt

# 等价写法（透传给 git）
.\scripts\git-ai.ps1 commit -F .git/MSG.txt

# 透传任意其它 git 命令（此时只设置署名，不做别的事）
.\scripts\git-ai.ps1 push origin main
```

手动等价写法：

```powershell
$env:GIT_AUTHOR_NAME='蓝色大肥鱼'
$env:GIT_AUTHOR_EMAIL='wang.20306@osu.edu'
$env:GIT_COMMITTER_NAME='蓝色大肥鱼'
$env:GIT_COMMITTER_EMAIL='wang.20306@osu.edu'
git commit -F .git/MSG.txt
```

> 关键点：`GIT_AUTHOR_*` / `GIT_COMMITTER_*` **优先于** config，
> 且只影响当前进程 —— **全局 `user.name`（Taco）不受影响**。
>
> ⚠️ 反过来要注意：维护者**手写**提交若仍走全局身份（`Taco <163>`），
> 新提交就会重新出现第二种署名，历史又变得不统一。
> 本文件不替他改全局配置 —— 要不要连手写提交也用这个身份，由他决定。

### 2.1 ⚠️ 重写历史时必须也设置这两个变量（已踩过）

`rebase` / `amend` / `filter-branch` 这类操作会**生成新提交**，而新提交的
**committer 取自当前 git config** —— 只保住 author 是不够的。本项目实测踩过一次：

```text
一次 git rebase -i 之后:
  author    = 蓝色大肥鱼 <wang.20306@osu.edu>   ← 被正确保留
  committer = Taco <wangziqi2002vip@163.com>    ← 被全局身份覆盖
结果:整个历史的署名又变成两种
```

正确姿势（先设环境变量，再重写）：

```powershell
$env:GIT_AUTHOR_NAME='蓝色大肥鱼';    $env:GIT_AUTHOR_EMAIL='wang.20306@osu.edu'
$env:GIT_COMMITTER_NAME='蓝色大肥鱼'; $env:GIT_COMMITTER_EMAIL='wang.20306@osu.edu'
git rebase -i --root --committer-date-is-author-date
```

**自查（应只输出一行）**：

```powershell
git log --format='%an <%ae>|%cn <%ce>' | Sort-Object -Unique
```

### 验证

```powershell
git log --format='%h | author=%an <%ae>' -5
```

### ⚠️ 两个已踩过的坑

1. **不要内联 `-m "..."`**：中文 + `【】` + `*` 会被 PowerShell 解析，
   报 `pathspec '...' did not match any file(s) known to git`。**必须走 `-F <文件>`**。
2. **第一个位置参数会被绑到 `-MessageFile`**：所以 `git-ai.ps1 push origin main`
   传进来的其实是 `MessageFile='push'`。脚本早期版本会在此**误报错**并让你改用 `git`；
   现已改为**识别出 git 子命令就转发**，文档里那两种写法都能用。

---

## 3. 头像：机制与实测结论

> ⚠️ 本节经历过**三次结论修正**。当前版本每一条都有实测支撑，并附上复现命令。
> 保留修正过程，是为了避免以后有人重走弯路。

### 3.1 GitHub 上的头像有两个**完全不同**的层面

| 层面 | 由什么决定 | 能否自定义 | 验证方式 |
|---|---|---|---|
| **① 作者头像 + 作者显示名**（commit 列表里那个小圆图和旁边的名字） | commit 的 **email** 是否绑定某个 GitHub 账号。绑定 → **头像用该账号的、名字也用该账号的 login**；未绑定 → 头像用默认占位图、名字用 commit 里的 author name | ❌ 不能直接自定义：头像和名字被**同一个开关**（email 是否绑定账号）绑在一起 | 抓 commit 页面 HTML 看 `--author-font-color` 那个元素，见 §3.2.1 |
| **② commit 信息里渲染的图片** | commit 的 **message 内容** | ✅ 可以，但**本项目已放弃**（见 §3.4） | 见 §3.3 |

> 这条 ① 是**修正后**的说法。早先版本只写了"头像"，并断言"名字仍显示 commit 里的
> author name" —— 那是从 API 推的、没验证渲染，**错的**。见 §3.2.1 的实测。

### 3.2 机制实测：email → 账号 → 头像

本仓库**现存全部提交**都是 `蓝色大肥鱼 <wang.20306@osu.edu>`，直接查当前 main：

```powershell
gh api repos/wzqvip/dsh-app/commits/main --jq '{email: .commit.author.email, login: .author.login, avatar: .author.avatar_url}'
# -> {"email":"wang.20306@osu.edu","login":"wzqvip","avatar":"https://avatars.githubusercontent.com/u/30136639?v=4"}
```

"未绑账号的邮箱 → 默认 identicon"这条**对照**，在身份重写之后本仓库已无法复现
（没有那样的提交了），但可以在全站历史里复现：

```powershell
gh api "/search/commits?q=author-email:wang.20306@osu.edu" --jq '{total: .total_count, accounts: ([.items[].author.login] | unique)}'
# -> {"total":28, "accounts":["wzqvip"]}
gh api "/search/commits?q=author-email:wangziqi2002vip@163.com" --jq '{total: .total_count, accounts: ([.items[].author.login] | unique)}'
# -> {"total":2003, "accounts":["wzqvip"]}
```

**结论**：这个 email 只要绑定在账号上，GitHub 就会把 commit 归给该账号 ——
**头像和显示名都跟着账号走**。名字不是 commit 里的 `蓝色大肥鱼`，而是账号的 login
（`wzqvip`）。这一点与我先前的说法相反，实测见 §3.2.1。

### 3.2.1 实测：GitHub 显示的是**账号 login**，不是 commit 里的名字

拿两版 commit 页面里**同一个渲染元素**（CSS 钩子 `--author-font-color`）做 A/B 对比 ——
左边是现在（邮箱已绑定），右边是重写前那批未绑定邮箱的提交（旧 SHA 仍可按链接访问）：

```html
<!-- 现在：email = wang.20306@osu.edu（已绑定 wzqvip） -->
...;--author-font-color:var(--fgColor-default)">wzqvip</a></div><span class="pl-1">committed</span>
<!--                                        ^^^^^^ 是 <a>，链接指向 /wzqvip -->

<!-- 重写前：email = bluefatfish@users.noreply.github.com（未绑定任何账号） -->
...;--author-font-color:var(--fgColor-default)">蓝色大肥鱼</span></div>...
<!--                                        ^^^^^^^^^^ 是 <span>，纯文本、无链接 -->
```

三条旁证：

1. 页面载荷里**三个名字同时在**，GitHub 选了 `login` 去渲染：
   `"login":"wzqvip","displayName":"蓝色大肥鱼","profileName":"Taco"`
2. 服务端渲染的 atom feed 直接输出 `<name>wzqvip</name>`（不是 commit 里的名字）。
3. commit 对象本身没变：`git log --format='%an'` 与 API `.commit.author.name`
   **至今仍是 `蓝色大肥鱼`** —— 变的只是 GitHub 网页。

复现命令：

```powershell
curl.exe -s -o pg.html "https://github.com/wzqvip/dsh-app/commit/<sha>"
Select-String -Path pg.html -Pattern '--author-font-color[^>]*>([^<]{1,40})</' | ForEach-Object { $_.Matches[0].Groups[1].Value }
```

**代价（这是"换邮箱换头像"的固有代价，无法只要一半）**：

| 方案 | GitHub 显示的名字 | 头像 |
|---|---|---|
| 邮箱绑定在账号上（**现状**） | 账号 login（`wzqvip`，带链接） | 该账号头像 ✅ |
| 邮箱不绑定任何账号 | commit 里的 author name（`蓝色大肥鱼`） | 默认占位图 ❌ |
| 另开一个 GitHub 账号专用于该署名 | 那个账号的 login（**英文**，用户名只允许字母数字连字符） | 该账号头像（可上传自定义图）✅ |

> ⚠️ 曾经设想的第三条路是"未绑定邮箱 + 给该邮箱配 Gravatar"。
> **未能证实**：实测未绑定作者的头像 URL 是 GitHub 自己的静态占位图
> （`github.githubassets.com/images/gravatars/gravatar-user-420.png`），
> 而不是按邮箱哈希取 Gravatar；且 Gravatar 的 `?d=404` 现已失效
> （随便一个不存在的邮箱也返回 200 + 同一张 2757 字节默认图），所以"有没有 Gravatar"
> 也没法这样探测。要不要走这条路，必须先实测。

<details>
<summary>附：身份重写<b>之前</b>在本仓库的对照记录（旧 SHA 已失效，仅作过程留痕）</summary>

| 旧 commit | 署名 email | `.author` | 圆形头像 |
|---|---|---|---|
| `464f2f7`（改用 osu.edu 后的首个提交） | `wang.20306@osu.edu` | **wzqvip** | ✅ `.../u/30136639?v=4` |
| `4ca576b` | `wangziqi2002vip@163.com` | **wzqvip** | ✅ 同上 |
| `e4a1188` | `wangziqi2002vip@163.com` | **wzqvip** | ✅ 同上 |
| `51f26c0` | `wangziqi2002vip@163.com` | **wzqvip** | ✅ 同上 |
| `69897f9` / `f1e52fd` / `3e5fa86` … | `bluefatfish@users.noreply.github.com` | `null` | ❌ 默认 identicon |

这些提交**内容仍在**（文件树与提交信息一字未改），只是 SHA 与署名都变了。
</details>

### 3.3 被证伪的技巧①：用 HTML 注释包图片

曾写成 `<!-- avatar: https://.../avatar.png -->`，理由是"注释不出现在 `git log` 输出里"。

**实测结论：完全无效。** GitHub 的 markdown 渲染器会把 HTML 注释**整个剥掉**。

当时的 4 组对照实验（用 `Accept: application/vnd.github.html+json` 取渲染后 HTML 比对）：

| 组 | 写法 | 是否渲染出 `<img>` |
|---|---|---|
| 1 | `![alt](url)` 可见 markdown 图片 | ✅ 是 |
| 2 | `<!-- avatar: url -->` 注释包 URL | ❌ 否（注释被剥离） |
| 3 | `<!-- <img src=...> -->` 注释包 img | ❌ 否（注释被剥离） |
| 4 | `<img src=... width="80">` 可见 HTML | ✅ 是 |

### 3.4 主动停用的方案②：可见 markdown 图片注入

既然注释不行，当时改用**可见**写法：在信息末尾加 `---` + `![avatar](<raw URL>)`。

**现已被主动停用并从脚本中移除**，理由：

1. 圆形头像既然已经能用（§3.2），就不需要"信息里塞图"这个折中；
2. 它会让 `git log` 的纯文本输出变脏（可见语法是能渲染的前提，无法两全）；
3. 它引入了额外维护负担：URL 里的 **SHA 必须指向已包含该图片的提交**，
   否则 raw URL 404（本项目已踩过一次）。

`-NoAvatar` 开关与 `$AvatarUrl` 变量随之删除。历史实现见提交 `bfcfab9`（身份重写后的 SHA；
重写前是 `f1e52fd`），需要时可回滚取回。
仓库里的 `assets/avatar-bluefatfish.png` 仍保留（维护者提供的素材，来源记录见 §4），
但**当前没有任何脚本引用它**。

> 若要恢复该方案，注意两点：① 图片引用必须**可见**（§3.3）；② URL 里的 SHA 用
> **重写后**的 `1a25a30`（加入该图片的那次提交，重写前为 `677b31b`）最稳妥。
> ⚠️ 实测（2026-09-29）：旧 SHA `677b31b` 的 raw URL **目前仍然返回 200** ——
> GitHub 会把不可达的对象继续按 SHA 提供一段时间（见 §5），所以"旧 SHA 一定 404"的说法
> **不成立**，但也不该依赖它：它随时可能被 GC 清掉。

### 3.5 一条容易误判的排查方法（含一次自我更正）

想确认"某个邮箱有没有头像"时，**别用**用户搜索：

```powershell
# ⚠️ 不可靠
gh api "/search/users?q=<email>+in:email"
```

实测（控制组）：

| 查询 | 结果 | 说明 |
|---|---|---|
| `wang.20306@osu.edu in:email` | ✅ 命中 `wzqvip` | 因为它**正是该账号的公开资料邮箱**（`gh api users/wzqvip --jq .email`） |
| `wangziqi2002vip@163.com in:email` | ❌ `total_count: 0` | 但它**确实已绑定** wzqvip（见下） |

> ⚠️ **自我更正**：我最初只测了 163 这一个（未绑定的对照选错了），
> 据此写下"用户搜索按 email 完全无效"。补测 osu.edu 后才发现：
> **这个方法只认"公开资料邮箱"，搜不到不能推断"没绑定账号、没头像"**。

可靠的两条查询：

```powershell
# ① 某个 commit 是否关联到账号（直接看头像来源）
gh api repos/wzqvip/dsh-app/commits/<sha> --jq '.author.login, .author.avatar_url'

# ② 全站搜该邮箱的公开提交，看它们关联到谁
gh api "/search/commits?q=author-email:wang.20306@osu.edu" --jq '{total: .total_count, accounts: ([.items[].author.login] | unique)}'
# -> osu.edu:  total=28    accounts=["wzqvip"]
# -> 163:      total=2003  accounts=["wzqvip"]
```

### 3.6 仍未直接验证的一点（如实标注）

- **commit 页面是否渲染 message 里的 markdown 图片**，我仍未直接看过渲染结果
  （先前的渲染验证是在**文件页面**上用 `contents` API 做的，因为 commit 消息没有公开的
  "渲染后 HTML" API）。现在该方案已停用，这一点**不再影响本项目**。
- **本机直连 HTTP 时通时不通**：早先（文件沙箱为受限模式时）`curl` / `Invoke-WebRequest`
  连 `api.github.com` 都返回 `http=000`，只有 `gh` CLI 可用；换成完全访问模式后
  `https://api.github.com/rate_limit` 返回 200，raw URL 也能直连验证。
  所以文档里那类"用 `Invoke-WebRequest -Method Head` 验证 raw URL 是否 200"的步骤
  **能不能跑取决于当前沙箱模式** —— 跑不了时改用 `gh api` 或直接 `curl`。

### 3.7 效果小结

- ✅ commit 列表里显示**维护者自己的圆形头像**
- ⚠️ 但旁边的名字是账号 login **`wzqvip`**（不是 `蓝色大肥鱼`）—— 见 §3.2.1；
  想要中文名回来，就必须放弃头像（换成未绑定账号的邮箱）
- ❌ **不能**把它换成 `assets/avatar-bluefatfish.png` 那张自定义图 —— 除非下面这条路
- 💡 **想同时要"自定义头像 + 想显示的名字"**：唯一正解是给该身份单独一个 GitHub 账号
  （一个 email 只能绑一个账号），把头像上传成那张自定义图，再用该账号的邮箱提交。
  但**显示名会是那个账号的 login（英文）**，GitHub 用户名不允许中文。
  实测 GitHub 上已存在 `wzqvip-debug`（id `56022992`，无公开仓库）—— 是否启用由维护者决定。

**所以本质上是个二选一**：`wzqvip` + 真头像 ⟷ `蓝色大肥鱼` + 占位图。

> ✅ **维护者的决定（2026-09-29）：取头像，接受 GitHub 上显示 `wzqvip`。**
> 即保持"邮箱绑定账号"的方案，**不要再为此调整署名或重写历史**。

---

## 4. 关于素材版权

**维护者自己提供的图**（如 `assets/avatar-bluefatfish.png`）**可以作为项目素材使用** ——
它是**给项目的资产**，不是从第三方站点抓的。

| 情况 | 处理 |
|---|---|
| **你提供的图**（如 `assets/avatar-bluefatfish.png`） | ✅ 可用，已入库并在本文件记录来源（当前不被脚本引用，见 §3.4） |
| **第三方梗图站的图**（如 aigengtu.com） | ❌ **不要入库** —— 版权归原作者、授权状态不明，且与 [NOTICE.md](NOTICE.md) 的约定冲突 |

若这张图是 AI 生成的，版权风险更低，但仍建议在 [NOTICE.md](NOTICE.md) 记录来源与生成方式，
以备将来有人询问。

---

## 5. 历史整理记录（2026-09-29）

维护者在这一天提了两次要求，历史被整理过**两轮**，最终 **25 → 11 个提交**：

### 5.1 第一轮：统一署名（25 个提交）

维护者要求「把项目之前的内容都改成这个，force 一下，清理掉历史」——
即**放弃"人写的 / AI 写的"两分**，把全部提交统一到 `蓝色大肥鱼 <wang.20306@osu.edu>`。

```powershell
# 1) 安全网（仅本地，不推送）
git branch -f backup/pre-identity-rewrite HEAD
git log --reverse --format='%H %an <%ae> %s' > .git/pre-rewrite-log.txt

# 2) 统一 author 与 committer（env-filter 只覆盖身份，
#    作者/提交日期由 filter-branch 从原提交带过来，因此时间戳不变）
git filter-branch -f --env-filter ". .git/ai-ident.sh" -- main

# 3) 覆盖远端
git push --force-with-lease=main:<重写前的 tip> origin main
```

| 项 | 状态 |
|---|---|
| 文件内容 / 提交信息 | **一字未改**（重写前后 `git diff` 为空） |
| 作者日期与提交日期 | **保留** |
| author / committer | 全部 = `蓝色大肥鱼 <wang.20306@osu.edu>` |
| 旧 SHA 在分支上 | ❌ 已不在任何分支/tag 上 |
| 旧 SHA 直链 | ⚠️ **仍然可访问** —— 见 §5.3 |

### 5.2 第二轮：合并「署名/头像」元提交（25 → 11 个提交）

维护者随后要求「带有改头像相关，不是内容的都清理掉或者合并掉」——
因为那 15 条**元提交**（改邮箱、改注入方式、重写文档、渲染对照实验……）
只在折腾署名与头像，不属于项目内容，却占了 log 的六成。

做法：把 15 条元提交全部 `fixup` 进**一条文档提交**
（`docs: 固化提交署名约定并加入署名脚本`），其余 10 条正事/文档提交原样保留。

```powershell
# rebase todo：前 8 条正事 → 署名文档提交 → 15 条元提交全部 fixup → 余下 2 条正事
# ⚠️ 必须先设 GIT_COMMITTER_*，否则 committer 会被全局身份覆盖（见 §2.1）
git rebase -i --root --committer-date-is-author-date
git push --force-with-lease=main:<整理前的 tip> origin main
```

| 项 | 状态 |
|---|---|
| 提交数 | 25 → **11** |
| 最终文件内容 | **一字未改**（整理前后 `git diff` 为空，30 个文件清单一致） |
| 被清理掉的提交 | 15 条元提交（含只用来做对照实验的 `avatar-render-test.md` 增删） |
| 剩下的 11 条 | 1 条 Initial + 8 条规划/调研/治理文档 + 1 条署名文档 + 2 条实测与执行规划 |
| 时间戳 | author 日期保留；committer 日期对齐 author 日期 |

⚠️ 陷阱：`rebase` 生成的新提交，其 **committer 取自当前 git config**。本次第一遍压完就中招
（author 是 AI 身份、committer 变回 `Taco <163>`），修法与自查见 §2.1。

### 5.3 ⚠️ 旧历史在 GitHub 上**仍然可访问**（实测）

**"清理掉历史"只做到了一半，必须说清楚**：force-push 之后旧 commit 不再属于任何分支，
但 GitHub 会把**不可达对象继续按 SHA 提供**。本次实测（2026-09-29）：

| 实测项 | 结果 |
|---|---|
| `gh api repos/wzqvip/dsh-app/commits/91b8f57`（旧 tip） | ✅ 仍返回数据 |
| `https://github.com/wzqvip/dsh-app/commit/91b8f57…` 页面 | ✅ HTTP 200 |
| `https://raw.githubusercontent.com/…/677b31b/assets/avatar-bluefatfish.png` | ✅ HTTP 200 |

也就是说：**知道旧 SHA 的人现在依然能看到旧署名（`Taco`、`bluefatfish`、163 邮箱）的提交。**
要真正抹掉，只有两条路：

1. 向 GitHub Support 提交"移除不可达对象 / 敏感数据"请求（官方推荐做法）；
2. 等 GitHub 自己的 GC —— 时间不可控，**不能当作保证**。

此外：0 fork、无 PR、无 tag 是本次敢重写的前提；**一旦有 fork，对方仓库会永久保留旧历史**。

> ⚠️ 在此之前本项目约定「**不改写历史**」。该约定**自本次起作废**，
> 因为维护者明确要求且当时代价可控（仓库只有他一个使用者、0 fork、无 tag、无 PR）。
> **一旦有协作者或 fork，就不要再这样做了** —— force-push 会让他们的本地历史分叉。
>
> 本地安全网（`backup/pre-identity-rewrite`、`backup/pre-logclean`）在两轮整理都验证通过后
> 已删除，并执行了 `git reflog expire --expire=now --all` + `git gc --prune=now`：
> **旧对象在本地已不可解析**。重写过程的档案仍留在 `.git/` 内（不入库）：
> `pre-rewrite-log.txt`（旧提交清单）、`pre-rewrite-shas.txt`、`identity-rewrite-map.txt`（旧→新 SHA 对照）、
> `ai-ident.sh`（env-filter）。
> 需要找回旧历史时，只能趁 GitHub 还没 GC，用 `git fetch origin <旧 SHA>` 取回。

