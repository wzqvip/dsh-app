# 第三方依赖与致谢

本项目自身代码为 MIT（见 [LICENSE](LICENSE)）。

> ⚠️ **`LICENSE` 只覆盖本仓库的源代码。**
> 本项目**依赖或复用**的第三方项目与素材各自遵循其条款，列于本文件。
> 其中包含**禁止商用**与**强制署名**的要求 —— **分发本项目前请完整阅读本文件。**
> 分发本项目（尤其是打包了第三方素材时）**必须保留本文件与下列声明**。

## 本项目自身的定位（2026-09-29 维护者拍板）

> **本项目完全免费开源，不做任何商业用途。**
> 代码以 MIT 发布；所有功能免费；不设付费项、不做商业授权、不接商业分发。
> 任何基于本项目的分发、展示或介绍，都必须保留本文件中的全部署名与素材声明。

---

## 0. 本仓库内的 vendor（内联复用）代码

除"依赖"外，本仓库**还内联复用**了部分第三方**代码**。规则如下：

| 项 | 规则 |
|---|---|
| **只 vendor 代码** | 源码 + 构建脚本；**绝不 vendor 素材**（立绘 / 动画 / 表情包 / 字体） |
| **保留原始许可** | 每个被 vendor 的目录内必须原样保留其 `LICENSE` 与版权头 |
| **记录出处与版本** | 在本文件与 [AGENTS.md](AGENTS.md) 中记录上游地址、版本、vendor 日期 |
| **素材另行获取** | 需要素材时从**已安装的上游 npm 包**读取，不复制进本仓库 |

### 0.1 PC2005-cloud/dsh-pet（代码已 vendor）

- 上游：<https://github.com/PC2005-cloud/dsh-pet>
- 上游许可：**MIT** · `Copyright (c) 2026 PC2005-cloud`
- vendor 范围：**仅代码**（`src/`、`runtime/`、构建脚本），**不含 `assets/`**
- 落位：见 [AGENTS.md](AGENTS.md) §4 的 vendor 清单（随实施更新）
- 我们做的改动：整体改造为独立插件、加入设置 GUI、重命名标识。
  **改动后的衍生代码仍受 MIT 约束，并继续署名上游。**

⚠️ **素材例外（硬约束）**：`dsh-pet` 的**素材**（动画 / 提示词 / 源视频 / 表情包）
**允许开源使用、禁止商用**，且二创**必须在任何介绍、展示、分发处附上原作者地址**。
因此本仓库**不复制**其素材，运行时从已安装的 `dsh-pet` 包读取。

---

## 1. 宿主平台

### DeepSeek Harness (`@deepseek-ai/*`)

- 来源：<https://github.com/deepseek-ai/deepseek-harness>
- 许可：**MIT**
- 用途：本项目运行其上的宿主平台。所有 `@deepseek-ai/dsh-*` 包均为 MIT。
- 本项目**不修改**其源码，仅通过官方插件机制扩展。

---

## 2. 桌面常驻层 / 桌宠载体

### PC2005-cloud/dsh-pet

- 来源：<https://github.com/PC2005-cloud/dsh-pet>
- npm：`dsh-pet`
- 用途：提供桌面常驻小窗、网页浮层（`shell.overlay`）、状态动画、气泡对话、系统通知。
  本项目**复用其承载能力**，只添加自己的信号采集与提醒逻辑。

#### ⚠️ 许可条款（重要）

| 部分 | 条款 |
|---|---|
| **代码** | **MIT** —— 本项目因此可以在自己的仓库里复用并修改（见 §0.1） |
| **素材**（动画 / 提示词 / 源视频 / 表情包） | **允许开源使用，禁止商用** |
| **二创约定（强制）** | 基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，须附上原作者 GitHub 地址 |

#### 署名要求（本项目必须遵守）

> 本项目在 [README.md](README.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md) 中均已附上原作者地址。
> **任何基于本项目的分发、展示或介绍，也必须保留以下地址：**
>
> **<https://github.com/PC2005-cloud/dsh-pet>**

#### 其他注意

- Safari / WKWebView 不认 webm alpha（渲染为黑底）。macOS 需改用其 Release `assets-mov` 提供的 HEVC-alpha `.mov` 素材。
- 其桌面模式会自动下载 Electron 运行时到 `~/.dsh/electron/`（首次启动）。

---

## 3. 其他可能采用的社区插件

按需选用，各自遵循其许可。截至调研时（2026-09-28）均为 MIT，但**采用前应自行核对其最新许可**。

| 插件 | 用途 | 来源 |
|---|---|---|
| `dsh-auto-collapse` | 折叠工具/思考过程，只留最终正文 | awesome-dsh-plugin |
| `dsh-web-mobile` | 窄屏移动端适配 | awesome-dsh-plugin |
| `@wingsky-1/dsh-lan-proxy` | 局域网访问转发（**含安全权衡，见 plan.md §5**） | awesome-dsh-plugin |
| `@tomowang/dsh-tui` | 终端界面 | awesome-dsh-plugin |

---

## 4. 素材来源（非代码）

### aigengtu.com（梗鲸 · DeepSeek 鲸鱼娘表情包库）

- 来源：<https://aigengtu.com/>
- 用途：**可选**的宠物素材 / 气泡配图来源
- ⚠️ **许可状态：不明确**。该站是社区梗图收集站，图片版权**归属各原作者**（投稿经其 GitHub issue 流程，并附 takedown 模板）。
- **结论**：自用可接受；**商用或公开发布前必须自行确认授权**。
- 技术限制：dsh-pet 播放的是**透明动画 webm**，静态表情图**不能直接**作为动画使用，需经素材链转码或仅作静态贴图。

---

## 5. 插件生态目录

### awesome-dsh-plugin

- 来源：<https://awesome-dsh-plugin.com> / <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- 用途：本项目的插件选型依据（4382 个插件的目录快照）。
- 本项目在 `research/registry-snapshot.json` 保留了该目录的快照用于调研记录。

---

## 6. 声明汇总（分发时请一并保留）

```
本项目的桌面常驻层 / 桌宠载体基于 PC2005-cloud/dsh-pet：
  https://github.com/PC2005-cloud/dsh-pet
其代码为 MIT；素材允许开源使用、禁止商用；
二创作品必须在任何介绍、展示、分发处附上上述地址。
```
