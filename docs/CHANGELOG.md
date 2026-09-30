# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

> **当前状态：规划阶段（未实现）**。下面记录的是**调研与规划**的产出，不是可用的功能。
> 第一个可用版本会以 `v0.1.0` 发布。

---

## [未发布]

### 已完成（调研与规划）

- **效率定位确立**：项目目标定为"让 agent 的提问主动找到你"，桌宠与 galgame 降为可选交互模块
- **源码级调研 5 份**（`research/`）：
  - 插件架构（host/client 契约、slot 总表、RPC 路径、安装与 patch 语义）
  - 嵌入方案（四条集成通道对比、SDK/ACP 协议面、桌面 profile 契约）
  - 局域网安全（三层防线、威胁模型、四套方案排序）
  - 响应式现状（唯一断点、`@media` 普查、403 个 token）
  - 显示模式（全部流事件类型、四个子需求的可行性与挂钩点）
- **插件生态普查**：4382 个社区插件目录，选型依据留档
- **关键发现**：
  - 官方 `ctx.userQuestions` 已有 `askTimed` 超时继续 + 稍后补答机制（**等待人类回答不产生 token**）
  - `tool-ask-user` 默认 `mode: legacy`（阻塞）→ **核心功能的前提是改为 `timed`**
  - 版本闸门可绕过：插件只要不声明 `@deepseek-ai/dsh*` peer 即不受约束
  - 当前 Web GUI **没有框架级响应式**（列宽是 JS 内联样式）
- **文档体系**：README / ARCHITECTURE / LAUNCHER / plan / todo / CONTRIBUTING / SECURITY / NOTICE / LICENSE
- **选定承载层**：`PC2005-cloud/dsh-pet`（自带 Electron 透明置顶窗，依赖而非 fork）

### 决策记录

| 决策 | 结论 |
|---|---|
| 定位 | 效率工具；桌宠/galgame 是可选载体 |
| 仓库 / 包名 | `wzqvip/dsh-app` / 插件包 `dsh-efficiency` |
| 与 `dsh-pet` | 依赖，不 fork |
| 优先级 | 先 R0（提问触达），R0b（进度）用零成本方式 |
| 局域网 / 手机 | 纯 Web 能力，与桌宠无关 |
| 分发 | 只发 GitHub，用户自行构建 |
| 启动器 | 做成 exe，Release 发布，解压即用（Electron，与 dsh-pet 同栈） |
| 上架插件市场 | 等 MVP 跑通 |
| 素材 | 先用 `dsh-pet` 自带素材，只做署名 |
| 许可 | 本项目代码 MIT |

### 尚未开始

- 插件 `dsh-efficiency` 的实现（R0 / R0b）
- 启动器实现
- 响应式与多端
- 桌面宠物打磨与扩展

---

## 关于版本号

- `v0.x` 期间接口与配置可能变动
- 每次发布都会在 Release 说明中列出「新增 / 修复 / 已知问题」
- DSH 上游迭代较快，本项目会声明**测试基线版本**；版本不匹配时**只提示不阻断**
