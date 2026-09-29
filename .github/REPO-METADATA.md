# GitHub 仓库元信息

> 用途：GitHub 的 **Description / Topics / Social preview** 存在仓库设置里（不是文件），
> 本文件是**可直接复制粘贴**的文案源，改动后请同步到 GitHub 设置页。
> 设置位置：仓库首页 → ⚙️ **About**（右上角）

---

## Description（仓库简介）

**中文（推荐，与项目语言一致）**

```
效率导向的 DeepSeek Harness 增强：不打开浏览器也能秒回 agent 提问、随时看到进度。桌宠与 galgame 仅为可选交互模块。
```

**英文（备选）**

```
Productivity-first enhancement for DeepSeek Harness: answer your agent's questions and watch progress without opening the browser. Desktop pet and galgame are optional interaction modules.
```

**超短版（用于 Social preview alt 或徽章旁）**

```
让 agent 的问题找到你，而不是让你守着网页。
```

---

## Topics（仓库标签）

GitHub 最多 **20 个** topics。按重要性排序，建议全部填满：

```
deepseek-harness
dsh
dsh-plugin
cordis-plugin
productivity
notification
desktop-pet
electron
ai-agent
human-in-the-loop
approval-workflow
developer-tools
typescript
windows
linux
macos
```

**逐个理由**

| Topic | 理由 |
|---|---|
| `deepseek-harness` / `dsh` | 主生态关键词，决定能不能被搜到 |
| `dsh-plugin` | 插件市场的收录关键词 |
| `cordis-plugin` | DSH 的插件框架名，技术定位 |
| `productivity` | 项目定位（效率工具，不是桌宠） |
| `notification` | 核心能力（提问触达） |
| `human-in-the-loop` / `approval-workflow` | 本质是"人机协同的等待环节" |
| `desktop-pet` | 主要载体，带来桌宠圈的自然流量 |
| `electron` | 启动器与桌面模式的实现栈 |
| `ai-agent` / `developer-tools` | 泛化检索 |
| `typescript` | 技术栈 |
| `windows` / `linux` / `macos` | 三平台发布，便于平台筛选 |

---

## Social preview（社交预览图）

GitHub 设置 → Social preview，建议尺寸 **1280×640**。

建议内容：
- 左侧：项目名 `dsh-app` + 一句话定位
- 右侧：一张**实际运行截图**（agent 提问以角标/气泡出现，旁边是桌宠）
- 底部小字：`DeepSeek Harness · 效率增强`

> ⚠️ 若使用 `dsh-pet` 的截图或素材，**必须署名** <https://github.com/PC2005-cloud/dsh-pet>
> （其素材**禁止商用**，开源展示属允许范围）。详见 [NOTICE.md](NOTICE.md)。

---

## 网站字段（可选）

About 里的 **Website** 可留空，或指向：
- 项目文档（后续可用 GitHub Pages）
- 插件市场页（上架后才有）：<https://awesome-dsh-plugin.com>

---

## 仓库设置检查清单

首次发布后逐项确认：

- [x] **Description** 已填（**已通过 `gh` 设置**，中英双语版）
- [x] **Topics** 已填（**已通过 `gh` 设置**，共 16 个）
- [ ] **Website** —— 暂留空（上架插件市场后再填）
- [ ] **Social preview** —— **需手动上传**（见下）
- [x] **Issues** 已启用
- [x] **Discussions** 已启用
- [ ] **Releases** 已打第一个 tag（`v0.1.0`）并附各平台包
- [x] **License** 已识别为 **MIT**（GitHub API 确认 `licenseInfo.key = mit`）
- [ ] **README** 顶部徽章可用（见下方）

### ⚠️ 两个已踩过的坑（供后续注意）

1. **`LICENSE` 必须是纯净的许可证正文。**
   最初我在 MIT 正文后追加了"依赖与素材条款"说明，导致 GitHub 识别为 `NOASSERTION`（无法识别）。
   已改为：`LICENSE` 只放纯 MIT，附加说明移到 [NOTICE.md](NOTICE.md) 开头。
2. **Topics 上限 20 个**，当前用 16 个，留 4 个余量给后续（如 `pwa`、`live2d`、`terminal`、`local-first`）。

### 当前已设置的仓库信息（`gh` 实测）

```
名称:      wzqvip/dsh-app
可见性:    PUBLIC
默认分支:  main
License:   MIT
Issues:    已启用
Discussions: 已启用

Description:
  效率导向的 DeepSeek Harness 增强：不打开浏览器也能秒回 agent 提问、随时看到进度。
  桌宠与 galgame 仅为可选交互模块。Productivity-first enhancement for DeepSeek Harness.

Topics (16):
  ai-agent, approval-workflow, cordis-plugin, deepseek-harness, desktop-pet,
  developer-tools, dsh, dsh-plugin, electron, human-in-the-loop, linux,
  macos, notification, productivity, typescript, windows
```

---

## README 徽章建议

放到 README 顶部（替换 `<owner>` 为 `wzqvip`）：

```markdown
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-8A2BE2)
![license](https://img.shields.io/github/license/wzqvip/dsh-app?color=orange)
![stars](https://img.shields.io/github/stars/wzqvip/dsh-app?style=social)
![release](https://img.shields.io/github/v/release/wzqvip/dsh-app)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-blue)
```

> 说明：`dsh` 版本徽章是**静态**的（当前测试基线），不是动态拉取 —— 避免上游发版后徽章与文档不一致。

---

## Release 说明模板

打 tag 时使用（`v0.1.0` 起）：

```markdown
## 新增
- 

## 修复
- 

## 已知问题
- 

## 安装
见 [README 快速开始](README.md#快速开始)。

## 校验
SHA256SUMS 附于本 Release。

## 致谢
本项目依赖 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
（代码 MIT；素材允许开源使用、禁止商用；二创须署名）。
```

---

## 待办：需要在 GitHub 网页上手动完成

1. 首页右上 ⚙️ **About** → 填 Description / Topics / Website
2. **Settings → Social preview** → 上传 1280×640 预览图
3. **Settings → Features** → 按需启用 Discussions
4. 打完第一个 tag 后确认 **Releases** 页面
