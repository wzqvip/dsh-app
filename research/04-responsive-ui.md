# 04 · 响应式 / 自适应 Web GUI 现状测绘

- 被测对象：`dsh` 0.1.7-rc.2（web 客户端插件版本号 `0.2.0-rc.2`）
- 安装根：`C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
- 调查方式：只读。阅读 README / `.d.ts` / `lib/client.js` / `lib/styles/*.css`，并对全部 `@deepseek-ai/*` 包做正则普查。未修改任何文件。
- 所有路径以下列前缀省略：`…\node_modules\@deepseek-ai\`（下称 `<PKG>`）。

---

## 0. 一句话结论

**当前 Web GUI 是"固定三列 + 单一 1024px 折叠阈值"的桌面布局。** 它已经具备相当成熟的**主题 token 体系**（403 个 `--dsw-*`）和一套**组件级容器查询**（8 个插件的 `@container`），

但**完全没有**：
- `env(safe-area-inset-*)` / `viewport-fit=cover`（0 处）
- 抽屉 / 汉堡 / 底部弹层 / 标签栏 / 手势（0 处）
- Service Worker（0 处）、`apple-touch-icon`（0 处）
- 任何 `tui` profile 或终端渲染器（0 处；`ink`/`blessed` 均未安装）
- 折叠屏 `env(viewport-segment-*)` / `screen-spanning`（0 处）

真正可复用的响应式地基只有三样：`computeColumns()` 的几何求解、`ResizeObserver` → CSS 变量的通道、以及 `@container` 容器查询。

---

## 1. 文件级地图（布局 / 样式架构）

### 1.1 外壳与三列

| 角色 | 路径 | 关键内容 |
|---|---|---|
| 三列框架 | `<PKG>\dsh-client-ui-layout\lib\client.js`（694 行 / 31,334 B） | `AppFrame`、`CenterColumn`、`LeftbarColumn`(内联)、`RightbarColumn`、`DragHandle`、`computeColumns`、`createLayoutStore`、`LayoutController`、`ThemePresenter` |
| 几何常量 | `<PKG>\dsh-client-ui-layout\lib\types\client\columns.d.ts` | `CENTER_MIN=400`、`SIDEBAR_MIN=264`、`SIDEBAR_MAX=420`、`SIDEBAR_DEFAULT=280`、`SIDEBAR_COLLAPSED=56`、`SIDEBAR_AUTO_COLLAPSE=1024`、`RIGHTBAR_MIN=300`、`RIGHTBAR_MAX_RATIO=0.7`、`RIGHTBAR_DEFAULT_RATIO=0.45` |
| 布局服务契约 | `<PKG>\dsh-client-ui-layout\lib\types\client\service.d.ts` | `ILayout`、`LayoutController`、`MainPanelId`、`PanelInfo`、`PanelActions` |
| 布局 store | `<PKG>\dsh-client-ui-layout\lib\types\client\stores.d.ts` | `createLayoutStore()`，`layoutInfo` 字段集 |
| 主题呈现器 | `<PKG>\dsh-client-ui-layout\lib\types\client\theme-presenter.d.ts` + `client.js:497-563` | `ThemePresenter`，写 `html[color-scheme]`、`body[data-ds-dark-theme]`、`--dsh-content-font-size`、`<meta name="theme-color">` |
| 左栏 | `<PKG>\dsh-client-ui-sidebar\lib\client.js`、`README.md` | 品牌行 / New Session / 56px rail / `sidebar.*` 座位 |
| 右栏（面板宿主） | `<PKG>\dsh-client-ui-sidebar-right\lib\client.js`、`README.md` | dock 分组、`--dsh-dockkit-*`、fullscreen 呈现 |
| 中栏（对话） | `<PKG>\dsh-client-ui-conversation\lib\client.js`、`README.md` | 头部、composer 座位、`ConversationWidthControls`（宽度拖拽 + `localStorage`） |
| 中栏（消息流） | `<PKG>\dsh-client-ui-chat\lib\client.js`、`README.md` | 滚动区、turn rail、`--dsh-chat-*` |
| 槽位注册表 | `<PKG>\dsh-client-ui-slots\lib\index.js`、`lib\types\index.d.ts`（51,503 B）、`lib\types\renderer.d.ts` | `SlotCore`、`SlotMap`、`SlotFactoryMap`、`renderer.ts` 安装契约 |
| React 渲染器 | `<PKG>\dsh-client-ui-renderer\lib\client.js`、`lib\types\client\registry.d.ts` | `createSlotRenderer()`、`ctx.uiRenderer.mount(container)`、`mountApp` |
| 原子组件 | `<PKG>\dsh-client-ui-primitives\lib\index.js`（523,090 B）+ `lib\*.module.css` + `lib\types\*.d.ts` | `Button`/`Menu`/`Modal`/`Tooltip`/`MarkdownText`… 共 40+ 导出 |
| 主题与 token | `<PKG>\dsh-client-ui-theme\lib\client.js`（101,801 B）、`lib\index.js`、`lib\styles\brand-font.css` | 8 张 token 表**内联**进 `client.js`（见 §4） |
| HTML 外壳 | `<PKG>\dsh-web-frontend\dist\index.html`（18 行） | viewport meta、manifest link、favicon |
| 静态服务 | `<PKG>\dsh-host-frontend-static\lib\index.js` | `serveStatic()`、`renderIndex()`、MIME 表 |
| 索引注入 | `<PKG>\dsh-host-webserver\lib\types\injections.d.ts` | `IndexInjection` 行类型（**插件注入 style/meta 的官方通道**） |
| 浏览器引导 | `<PKG>\dsh-client-modules\lib\...`、`README.md` | `window.__ModuleLoader__`、combo/chunk 打包、**样式随工厂闭包注入** |
| 快捷键 | `<PKG>\dsh-client-shortcuts\README.md` | `desktop:*` / `web:*` 六套 profile，纯键盘 |
| 语言 | `<PKG>\dsh-client-locale\lib\client.js`、`README.md` | `ctx.locale`、`addLanguage`、`register` |

### 1.2 `AppFrame` 的实际 DOM 与内联几何

`<PKG>\dsh-client-ui-layout\lib\client.js:315-368`：

```js
return jsxs("div", {
  ref: frameRef,
  className: AppFrame_module_css_default.frame,
  style: {
    ...document.documentElement.hasAttribute("data-windows-titlebar")
      ? { "--dsh-windows-sidebar-width": `${cols.sidebar}px` } : {},
    gridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`
  },
  "data-sidebar-collapsed": sidebarCollapsed || void 0,
  "data-rightbar-collapsed": cols.rightbar === 0 || void 0,
  "data-rightbar-fullscreen": layoutInfo.rightbarFullscreen || void 0,
  "data-rightbar-instant": layoutInfo.rightbarInstant || void 0,
  "data-dragging": dragging || void 0,
  "data-animating": animating > 0 || void 0,
  ...
```

**列宽完全由 JS 计算后写成内联 `gridTemplateColumns`**——因此 CSS 媒体查询**无法**改变列结构；只有 `data-*` 状态属性可以被 CSS 用来隐藏/变形内容。这是理解整个自适应改造的关键约束。

### 1.3 几何求解（唯一的"响应式"算法）

`<PKG>\dsh-client-ui-layout\lib\client.js:38-47`：

```js
function computeColumns(viewport, sidebar, rightbar, collapsedWidth = 56) {
  const s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, 264, 420);
  const available = viewport - s - 400;
  const r = rightbar === 0 || available < 300 ? 0
      : Math.min(available, clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO));
  return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r };
}
```

### 1.4 唯一的断点：`SIDEBAR_AUTO_COLLAPSE = 1024`

`client.js:10-13` + `236-243`：

```js
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
const SIDEBAR_AUTO_COLLAPSE = 1024;
...
const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;
const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;
const sidebarPreference = sidebarCollapsed ? 0 : layoutInfo.sidebar === 0 ? 280 : layoutInfo.sidebar;
const rightbarPreference = layoutInfo.rightbar ?? viewport * .45;
const darwin = document.documentElement.dataset.platform === "darwin";
const collapsedWidth = darwin || document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56;
const normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference, collapsedWidth);
```

`viewport` 来自 `ResizeObserver`（`client.js:211-235`），写回 `actions.setViewportWidth(width)`。

`setViewportWidth`（`client.js:416-421`）**在跨越 1024 时清空 `narrowExpanded`**：

```js
setViewportWidth: (d, width) => {
  if (d.layoutInfo.viewportWidth === width) return;
  d.layoutInfo.rightbarInstant = false;
  if (d.layoutInfo.viewportWidth < 1024 !== width < 1024) d.layoutInfo.narrowExpanded = false;
  d.layoutInfo.viewportWidth = width;
},
```

`toggleSidebar`（`client.js:411-415`）在窄屏走 `narrowExpanded` 开关（覆盖在被压缩的中栏之上），宽屏走 `sidebar = 0|280`。

> **注意**：`narrow`/`compact`/`mobile` 这类语义**只存在于这 3 处**（`SIDEBAR_AUTO_COLLAPSE`、`narrowExpanded`、局部变量 `narrow`）。没有第二级、第三级断点。

---

## 2. 全部 `@media` 普查（完整、逐条）

对 2,994 个文件（`.css/.js/.ts/.html/.mjs`，排除 `dist/assets/langs/`）扫描。**共 23 种不同 media query 表达式、83 处出现。**

| # | 表达式 | 次数 | 代表文件（行） | 含义 |
|---|---|---|---|---|
| 1 | `(prefers-reduced-motion:reduce)` | 32 | `dsh-client-ui-agent-preset\lib\client.js` | 动效降级 |
| 2 | `(prefers-reduced-motion:reduce)`（无空格变体） | 9 | `dsh-web-frontend\dist\assets\index-DUvMhLle.css` | 动效降级 |
| 3 | `(prefers-reduced-motion: reduce)`（带空格） | 9 | `dsh-client-ui-primitives\lib\ConnectionIndicator.module.css:1` | 动效降级 |
| 4 | **`(pointer:coarse)`** | 5 | `dsh-client-ui-attachment\lib\client.js:27,360,593`；`dsh-client-ui-deliverables\lib\client.js:1292` | **唯一稳定触屏适配**：让 hover 才出现的删除按钮常显 `{opacity:1}` |
| 5 | **`(width<=560px)`** | 4 | `dsh-client-ui-settings-models\lib\client.js:2398,2460,2572`；`dsh-client-ui-workflow-run\lib\client.js:12` | 对话框 padding / 主按钮 100% |
| 6 | `(prefers-reduced-motion:no-preference)` | 3 | `dsh-client-ui-settings-plugin-inventory\lib\client.js` | 动效增强 |
| 7 | **`(width<=760px)`** | 2 | `dsh-client-ui-schedule\lib\client.js:1801`；`dsh-client-ui-trajectory\lib\client.js:3818` | 布局降级 |
| 8 | `(hover:hover)` | 2 | `dsh-client-ui-chat\lib\client.js:1103`；`dsh-client-ui-workspace\lib\client.js:1058` | hover-only 效果门控 |
| 9 | **`(width<=720px)`** | 2 | `dsh-client-ui-user-questions\lib\client.js:203,334` | 卡片 footer 对齐/内边距 |
| 10 | **`(width<=1100px)`** | 2 | `dsh-client-ui-schedule\lib\client.js:1801`；`dsh-client-ui-settings-account\lib\client.js:3358` | `--detail-gutter:20px` 等 |
| 11 | **`(width<=767px)`** | 1 | `dsh-client-ui-plan\lib\client.js:26` | `padding:16px 18px 32px` |
| 12 | **`(width<=680px)`** | 1 | `dsh-client-ui-settings-plugin-inventory\lib\client.js:57` | 卡片列数 2→1 |
| 13 | **`(width<=480px)`** | 1 | `dsh-client-ui-chat\lib\client.js:6334` | 隐藏标签只留图标 |
| 14 | **`(width<=400px)`** | 1 | `dsh-client-ui-schedule\lib\client.js:1801` | 最小宽兜底 |
| 15 | `(prefers-reduced-transparency:reduce)` | 1 | `dsh-client-ui-layout\lib\client.js:73` | macOS 毛玻璃降级 |
| 16 | `(prefers-color-scheme:dark)` | 1 | `dsh-client-ui-theme\lib\index.js:44` | 首屏 pre-plugin 配色 |
| 17 | **`(hover:none),(pointer:coarse)`** | 1 | `dsh-client-ui-sidebar-documentpreview\lib\client.js:4201` | 预览面板在无 hover 设备上常显 |
| 18 | `(hover:none)` | 1 | `dsh-client-ui-shortcuts\lib\client.js:85` | 无 hover 设备 |
| 19 | `(hover:hover) and (prefers-reduced-motion:no-preference)` | 1 | `dsh-client-ui-conversation\lib\client.js:15971` | 鱼形 logo 游动 |
| 20 | `(height>=920px)` | 1 | `dsh-client-ui-settings-account\lib\client.js:3358` | 欢迎页插画 |
| 21 | `(height<=760px)` | 1 | 同上 | 欢迎页插画 |
| 22 | `(width<=1200px)` | 1 | 同上 | `left:calc(73.333vw - 267.5px)` |
| 23 | `(height<=560px)` | 1 | 同上 | 欢迎页插画 |

**归总**：
- **视口宽度断点共 15 处 / 9 个不同值**：`400, 480, 560, 680, 720, 760, 767, 1100, 1200`。全部是**个别对话框/卡片/插画的局部微调**，**没有任何一处改造三列框架**。
- **高度断点仅 3 处**，且只用于一个 onboarding 插画。
- **`pointer:coarse` / `hover:none` 共 7 处**，全部只解决"hover 才可见的控件在触屏上不可达"这一个问题。

### 2.1 关键证据：唯一真正"窄栏自适应"的媒体查询

`<PKG>\dsh-client-ui-chat\lib\client.js:6334`：

```css
@media (width<=480px){
  .Q51KRG_trigger{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}
  .Q51KRG_trigger .Q51KRG_label{display:none}
  .Q51KRG_root+.Q51KRG_root{margin-left:0}
}
```

`<PKG>\dsh-client-ui-attachment\lib\client.js`：

```css
@media (pointer:coarse){.JVDQca_remove{opacity:1}}
```

`<PKG>\dsh-client-ui-sidebar-documentpreview\lib\client.js:4201`：

```css
@media (hover:none),(pointer:coarse){.lyqg2a_panel{opacity:1;pointer-events:auto;transform:translate(-50%)scale(1)}}
```

---

## 3. 容器查询（`@container`）——真正的自适应地基

扫描 `container-type` / `container:` / `@container`：

| 文件 | `container-type` 处数 | `@container` 断点 |
|---|---|---|
| `dsh-client-ui-chat\lib\client.js` | 3 | `@container (width<=900px){.eGxaPq_frame{display:none}}` |
| `dsh-client-ui-conversation\lib\client.js` | 2 | `@container (width<=560px){.uV2eYG_tools,.uV2eYG_modes,.uV2eYG_trailing{gap:8px}}` |
| `dsh-client-ui-trajectory\lib\client.js` | 2 | `@container Y0dWHa_trajectory-table (width<=620px)` |
| `dsh-client-ui-deliverables\lib\client.js` | 1 | `@container (width<=620px)` |
| `dsh-client-ui-settings-plugin-inventory\lib\client.js` | 1 | `@container qSYn7G_plugin-inventory (width<=520px)` |
| `dsh-client-ui-sidebar\lib\client.js` | 1 | （无 `@container`，仅容器） |
| `dsh-client-ui-agent-preset\lib\client.js` | 0 | `@container (width<=540px)` |
| `dsh-client-ui-permission-presets\lib\client.js` | 0 | `@container (width<=460px)` |
| `dsh-experimental-client-ui-agent-team\lib\client.js` | 0 | `@container (width<=480px)` |

**含义**：中栏变窄时，chat 的 turn rail（`@container (width<=900px)` 隐藏）和 composer 工具行（`<=560px` 收紧 gap）**已经会自适应**。这是把响应式下沉到"列宽"而非"视口宽"的现有先例——**改造应沿用这个范式**（对 `sidebarCol` / `centerCol` / `rightbarCol` 声明 `container-type: inline-size`，而非增加全局媒体查询）。

---

## 4. 主题 / Token 体系

### 4.1 规模

在 `<PKG>\dsh-client-ui-theme\lib\client.js`（101,801 字符）中：

- `--dsw-*` **定义出现 601 次**
- **唯一 token 名 403 个**

### 4.2 定义位置（选择器）

token 定义所在的选择器（正则提取）为：

```
:root                                  ← 浅色基准调色板
body                                   ← 材质别名（settings-card / menu 等）
body[data-ds-dark-theme]               ← 深色基准调色板
body,body *                            ← 字体/内容尺度
*,:before,:after                       ← --dsw-corner-shape (superellipse)
html[data-platform=darwin] body        ← macOS 专用覆盖
html[data-platform=darwin] body[data-ds-dark-theme]
html[data-input-modality=pointer] body :focus-visible:not(:read-write)
:focus-visible
body[data-ds-dark-theme] [data-menu-material]
```

外加组件私有选择器（`.bVCLcG_*` 字号步进器、`._8HJdBW_*` 主题立方）。

> **重要**：README 宣称的 8 张表（`base.css`、`corner-shape.css`、`design-platform.css`、`focus.css`、`onboarding.css`、`scrollbar.css`、`gradient-shadow-text.css`、`shiki.css`）**并未作为 `.css` 文件装在 `lib/styles/`**。`lib\styles\` 里**只有 `brand-font.css` + 3 个 woff2 + OFL 许可**。8 张表是构建期由 tsdown 内联成 `client.js` 里的 `const css = "..."` 字符串（见 `dsh-client-ui-layout\lib\client.js:73-81` 的同款形态）：

```js
const tagId = "@deepseek-ai/dsh-client-ui-layout/AppFrame.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-layout";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
```

### 4.3 完整 `--dsw-*` token 清单（403 个，全部由 `dsh-client-ui-theme\lib\client.js` 定义）

```text
--dsw-alias-bg-base, --dsw-alias-bg-document-preview, --dsw-alias-bg-document-selection,
--dsw-alias-bg-layer-1, --dsw-alias-bg-layer-2, --dsw-alias-bg-layer-3,
--dsw-alias-bg-mask-1, --dsw-alias-bg-mask-2, --dsw-alias-bg-mask-3,
--dsw-alias-bg-mask-drop, --dsw-alias-bg-mask-photo, --dsw-alias-bg-module-platform,
--dsw-alias-bg-multi-select, --dsw-alias-bg-overlay, --dsw-alias-bg-skeleton,
--dsw-alias-border-inverted, --dsw-alias-border-inverted2,
--dsw-alias-border-l1, --dsw-alias-border-l2, --dsw-alias-border-l2-darkmode-thin,
--dsw-alias-border-l3, --dsw-alias-border-l4,
--dsw-alias-brand-primary, --dsw-alias-brand-primary-invert,
--dsw-alias-brand-primary-new-colorprimary-new-color, --dsw-alias-brand-text,
--dsw-alias-button-contrast-fill, --dsw-alias-button-elevated-fill,
--dsw-alias-button-floating-fill, --dsw-alias-button-floating-hover,
--dsw-alias-button-ghost-active-border, --dsw-alias-button-ghost-active-fill,
--dsw-alias-button-ghost-active-hover, --dsw-alias-button-info-fill,
--dsw-alias-button-info-hover, --dsw-alias-button-primary-dimmed,
--dsw-alias-button-primary-fill, --dsw-alias-button-primary-hover,
--dsw-alias-button-tool-bar-fill, --dsw-alias-button-tool-bar-fill-invisible,
--dsw-alias-button-tool-bar-hover, --dsw-alias-code-diff-added, --dsw-alias-code-diff-deleted,
--dsw-alias-file-diff-added-bg, --dsw-alias-file-diff-added-gutter, --dsw-alias-file-diff-added-marker,
--dsw-alias-file-diff-deleted-bg, --dsw-alias-file-diff-deleted-gutter, --dsw-alias-file-diff-deleted-marker,
--dsw-alias-interactive-bg-active, --dsw-alias-interactive-bg-hover,
--dsw-alias-interactive-bg-hover-accent, --dsw-alias-interactive-bg-hover-danger,
--dsw-alias-interactive-bg-hover-solid,
--dsw-alias-label-caption, --dsw-alias-label-deep-diving, --dsw-alias-label-deep-diving-shimmer,
--dsw-alias-label-dimmed, --dsw-alias-label-document-preview, --dsw-alias-label-primary,
--dsw-alias-label-primary-bluish, --dsw-alias-label-primary-dimmed,
--dsw-alias-label-primary-foreground, --dsw-alias-label-primary-inverted,
--dsw-alias-label-secondary, --dsw-alias-label-shimmer, --dsw-alias-label-tertiary,
--dsw-alias-link, --dsw-alias-markdown-citation, --dsw-alias-markdown-code-block,
--dsw-alias-markdown-code-block-banner, --dsw-alias-markdown-code-segment-selected,
--dsw-alias-markdown-code-segment-unselected, --dsw-alias-markdown-inline-code,
--dsw-alias-markdown-placeholder, --dsw-alias-markdown-tag,
--dsw-alias-menu-group-header-fill, --dsw-alias-menu-icon,
--dsw-alias-onboarding-accent, --dsw-alias-onboarding-card-fill,
--dsw-alias-onboarding-checkbox-border, --dsw-alias-onboarding-secondary-fill,
--dsw-alias-scrollbar-bg-l1, --dsw-alias-scrollbar-bg-l2,
--dsw-alias-scrollbar-hover-l1, --dsw-alias-scrollbar-hover-l2,
--dsw-alias-settings-card-fill, --dsw-alias-settings-card-stroke,
--dsw-alias-state-business-primary, --dsw-alias-state-business-tertiary,
--dsw-alias-state-error-primary, --dsw-alias-state-error-secondary,
--dsw-alias-state-idle-primary, --dsw-alias-state-success-primary,
--dsw-alias-state-success-secondary, --dsw-alias-state-success-tertiary,
--dsw-alias-state-warn-label, --dsw-alias-state-warn-primary,
--dsw-alias-state-warn-secondary, --dsw-alias-state-warn-tertiary,
--dsw-alias-switch-thumb, --dsw-alias-toast-bg, --dsw-alias-toast-label,
--dsw-alias-tooltip-bg, --dsw-alias-tooltip-key-bg,
--dsw-alias-turn-trigger-bg, --dsw-alias-turn-trigger-bg-hover,
--dsw-corner-shape,
--dsw-elevation-panel, --dsw-elevation-prominent, --dsw-elevation-soft,
--dsw-elevation-stroke, --dsw-elevation-stroke-color,
--dsw-focus-ring-color, --dsw-focus-ring-width,
--dsw-font-base-16(+ -font-family/-font-size/-font-style/-font-weight/-line-height),
--dsw-font-base-strong-16(+5 子属性),
--dsw-font-family, --dsw-font-family-brand,
--dsw-font-l-20(+5), --dsw-font-m-18(+5),
--dsw-font-markdown-base(+5), --dsw-font-markdown-base-italic(+5),
--dsw-font-markdown-base-strong(+5), --dsw-font-markdown-base-strong-italic(+5),
--dsw-font-markdown-code(+5), --dsw-font-markdown-code-block(+5),
--dsw-font-markdown-code-block-small(+5),
--dsw-font-markdown-h1(+5), --dsw-font-markdown-h2(+5),
--dsw-font-markdown-h3(+5), --dsw-font-markdown-h4(+5),
--dsw-font-markdown-small(+5), --dsw-font-markdown-small-italic(+5),
--dsw-font-markdown-small-strong(+5), --dsw-font-markdown-small-strong-italic(+5),
--dsw-font-markdown-table(+5), --dsw-font-markdown-table-head(+5),
--dsw-font-s-14(+5), --dsw-font-s-strong-14(+5),
--dsw-font-xl-24(+5), --dsw-font-xs-13(+5), --dsw-font-xs-strong-13(+5),
--dsw-font-xxs-12(+5), --dsw-font-xxs-strong-12(+5),
--dsw-font-xxxs-11(+5), --dsw-font-xxxs-strong-11(+5),
--dsw-gradient-onboarding-blue-stops, --dsw-gradient-onboarding-cyan-stops,
--dsw-gradient-onboarding-violet-stops,
--dsw-linear-gradient-think, --dsw-linear-think-select, --dsw-mask-blur,
--dsw-menu-backdrop-filter, --dsw-menu-surface-fill,
--dsw-radius-lg, --dsw-radius-md, --dsw-radius-panel,
--dsw-radius-sm, --dsw-radius-xl, --dsw-radius-xs,
--dsw-shadow-lv1, --dsw-shadow-lv1-blur, --dsw-shadow-lv2, --dsw-shadow-lv3,
--dsw-specific-bubble, --dsw-specific-bubble-highlight, --dsw-specific-input-major,
--dsw-specific-login-input, --dsw-specific-menu, --dsw-specific-selector,
--dsw-specific-sidebar-fill, --dsw-specific-sidebar-nav-item-active,
--dsw-specific-sidebar-nav-item-active-accent, --dsw-specific-sidebar-nav-item-hover,
--dsw-specific-tip,
--dsw-static-amber-100/400/500/600/900,
--dsw-static-blue-50/50p/75/100/300/400/450/500/600/800/900/950,
--dsw-static-deepseek-50/100/200/300/400/450/500/600/700-delete/800/900,
--dsw-static-green-100/400/500/500-a08/500-a12/900,
--dsw-static-neutral-00/50/100/150/200/250/300/400/500/550/600/700/800/850/900/1000,
--dsw-static-neutral-bluish-00/50/60/75/100/150/200/300/400/500/600/700/750/800/850/875/900/950/1000,
--dsw-static-red-50/100/400/400-a12/500/600/600-a08/900
```

（`(+5)` 表示该族另含 `-font-family`、`-font-size`、`-font-style`、`-font-weight`、`-line-height` 五个子 token；字体族共 ~300 个 token，是 403 中的主体。）

### 4.4 第一方布局 token（`--dsh-*`，38 个，跨插件）

这些是**布局/尺度**变量，与调色板分离，是自适应改造的直接抓手：

| token | 定义包 |
|---|---|
| `--dsh-frame-top-clearance` (48px)、`--dsh-frame-leading-clearance`、`--dsh-frame-chrome-top`、`--dsh-frame-overlay-top` | `dsh-client-ui-layout` |
| `--dsh-chat-content-width`、`--dsh-composer-card-max-width`、`--dsh-composer-side-clearance`(16px)、`--dsh-composer-dock-inset`(8px)、`--dsh-composer-stack-gap`、`--dsh-composer-text-max-height`(336px)、`--dsh-composer-model-icon-display`、`--dsh-composer-model-text-display` | `dsh-client-ui-conversation` |
| `--dsh-chat-flow-gap`、`--dsh-compaction-header-height`、`--dsh-table-lead`、`--dsh-table-spare` | `dsh-client-ui-chat` |
| `--dsh-sidebar-inline-padding`(12px)、`--dsh-windows-menu-start` | `dsh-client-ui-sidebar` |
| `--dsh-session-list-edge-inset`、`--dsh-session-list-scrollbar-width`、`--dsh-session-list-scrollbar-offset` | `dsh-client-ui-workspace` |
| `--dsh-trajectory-bottom-clearance`、`--dsh-trajectory-toolbar-height`、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta-secondary` | `dsh-client-ui-trajectory` |
| `--dsh-dockkit-dock-layer`、`--dsh-dockkit-float-layer`、`--dsh-dockkit-strip-inline-start` | `dsh-client-ui-sidebar-right` |
| `--dsh-content-font-size`、`--dsh-content-font-delta`、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta-secondary`、`--dsh-boot-bg` | `dsh-client-ui-theme` |
| `--dsh-windows-content-radius` | `dsh-client-ui-layout` |
| `--dsh-answer-field-padding` | `dsh-client-ui-user-questions` |
| `--dsh-onboarding-border-angle` | `dsh-client-ui-settings-account` |
| `--dsh-scrollbar-width` / `-thumb` / `-thumb-hover` / `-thumb-border` / `-track-margin` | `dsh-client-ui-theme`（被 23 个包重绑） |

### 4.5 已经存在的"流式宽度"（不是媒体查询）

`<PKG>\dsh-client-ui-conversation\lib\client.js`：

```css
.wSkVaW_body{
  --dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px));
  --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
  --dsh-composer-side-clearance:16px;
  --dsh-composer-dock-inset:8px;
}
```

同一个文件里还有一组**纯 `100%` 相对**的兜底（注意：不是媒体查询，靠百分比自动退化）：

```css
--dsh-chat-content-width: min(calc(100% - 32px), 920px);
--dsh-composer-card-max-width: min(calc(100% - 16px), 952px);
```

并有 JS 侧 `ResizeObserver` + `localStorage` 用户偏好：

```js
const publishWidths = (container) => {
  const target = container.parentElement ?? container;
  const column = container.offsetWidth;
  target.style.setProperty("--dsh-conversation-column-width", `${column}px`);
  const preference = readWidthPreference();
  if (preference === null) target.style.removeProperty("--dsh-chat-user-width");
  else target.style.setProperty("--dsh-chat-user-width", `${resolveContentWidth(column, preference)}px`);
};
```

**这是全局唯一"视口→CSS 变量"的成熟通道**，也是折叠屏/平板改造最应复用的机制：`ResizeObserver` → `element.style.setProperty(--dsh-*)` → CSS 消费。

---

## 5. 插件如何注入样式 / token（官方通道盘点）

| 通道 | 是否公开文档化 | API | 位置 |
|---|---|---|---|
| **Token 覆盖**（推荐） | ✅ | `ctx.theme.overrideTokens(source, { '--dsw-alias-x': { light, dark } })` → disposer；`ctx.theme.register({ id, colorScheme, tokens })` | `<PKG>\dsh-client-ui-theme\lib\types\client\index.d.ts:161-178` |
| **宿主 HTML 注入**（style/meta/link） | ✅ | `ctx.on('webserver/index-inject', table => table.push(...))` + `IndexInjection` 行：`{kind:'style', text}`（head）、`{kind:'html', placement, html}`、`{kind:'script'|'script-src'|'script-preload'|'global'}` | `<PKG>\dsh-host-webserver\lib\types\injections.d.ts:13-51`；`lib\types\index.d.ts:27` |
| **原始 index 变换**（逃生口） | ✅ | `ctx.webServer.tapIndex(html => html)` | `dsh-host-webserver\lib\types\index.d.ts:114` |
| **客户端全局样式** | ❌ 无公开 API | 实际机制：构建期 tsdown 把 `import './x.css'` 内联成 `const css = "..."`，在**工厂实体化时**插入 `<style data-plugin="<pkg>" data-plugin-css="<pkg>/<file>">`，卸载/HMR 时由 `dsh-client-modules` 的 owned-style cleanup 移除 | `dsh-client-ui-layout\lib\client.js:73-81`；`dsh-client-modules\README.md`（"module-body side effects (CSS injection included) lives in the factory closure"） |
| **手动 `<style>`**（手写 JS 插件） | 惯例 | 自行 `document.createElement('style')`，按约定打 `data-plugin` / `data-plugin-css`，以便被模块系统的样式清理识别 | 同上 |

主题插件本身就用宿主注入通道做首屏防闪：

`<PKG>\dsh-client-ui-theme\lib\index.js:88-95`：

```js
function apply(ctx, config) {
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  ctx.on("webserver/index-inject", (table) => {
    table.push(...bootThemeInjections(config.preference.get(), config.fontSize.get()));
  }, { prepend: true });
}
```

**结论**：想在插件里加 `<meta name="viewport" content="...,viewport-fit=cover">`、`<link rel="apple-touch-icon">`、或一段全局媒体查询样式表，**官方路径就是 `webserver/index-inject` 的 `style`/`html` 行**。客户端插件本身无法注入全局 CSS 的公开 API，只能靠构建期内联或自建 `<style>`。

---

## 6. PWA / 可安装性

### 6.1 HTML 外壳（唯一）

`<PKG>\dsh-web-frontend\dist\index.html`（全文 18 行）：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />
    <title>DeepSeek Harness</title>
    ...
```

**实际的 viewport 标签（逐字引用）**：

```html
<meta name="viewport" content="width=device-width, initial-scale=1" />
```

> ⚠️ **没有 `viewport-fit=cover`** —— 因此在 iPhone 上 `env(safe-area-inset-*)` 恒为 0，刘海/灵动岛/底部 Home 指示条区域无法安全避让。这是移动端改造的第一个必改点。

### 6.2 Manifest（存在）

`<PKG>\dsh-web-frontend\dist\manifest.webmanifest`：

```json
{
  "name": "DeepSeek Harness",
  "short_name": "DSH",
  "start_url": "./",
  "scope": "./",
  "display": "fullscreen",
  "icons": [
    { "src": "favicon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

问题：
- 图标**只有 1 个 SVG**，无 192/512 PNG，无 `maskable`（Android 自适应图标会留白/被裁切）
- 无 `apple-touch-icon`（iOS 添加到主屏会截屏生成图标）
- `display: "fullscreen"` 在 iOS Safari 不生效，会回落为浏览器标签
- 无 `theme_color` / `background_color` 字段（`theme-color` 由 JS 运行时写 `<meta>`，见下）

### 6.3 Service Worker：**不存在**

全量扫描 `serviceWorker` / `sw.js` / `beforeinstallprompt` / `apple-mobile-web-app-capable` / `mobile-web-app-capable`：**0 命中**。
→ **不可离线安装**，`beforeinstallprompt` 不会触发（Chrome 要求 manifest + SW）。

### 6.4 `theme-color` meta：运行时由 JS 创建

`<PKG>\dsh-client-ui-layout\lib\client.js:519-522, 546-547`：

```js
constructor() {
  this.themeColorMeta = document.createElement("meta");
  this.themeColorMeta.name = "theme-color";
}
...
this.themeColorMeta.content = getComputedStyle(body).backgroundColor;
if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta);
```

### 6.5 MIME 表已支持 manifest

`<PKG>\dsh-host-frontend-static\lib\index.js:24-33`：

```js
const MIME = {
  ".html": HTML_MIME, ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".map": "application/json",
  ".webmanifest": "application/manifest+json", ".gz": "application/gzip"
};
```

README 亦确认 "covers the Vite-emitted asset set plus the shipped PWA manifest"。同时 `dsh-web-frontend` 缺失的扩展名会退回 `application/octet-stream`——加 PNG 图标是安全的（`.png` 不在表内，会走 octet-stream，可能影响可安装性判定，**需要一并扩展 MIME 表**）。

---

## 7. 移动输入与交互

### 7.1 触屏：只有 2 处，且都不是手势

| 文件 | 命中数 | 实际内容 |
|---|---|---|
| `dsh-client-ui-chat\lib\client.js` | 13 | 仅用于**打断平滑滚动动画**：`touchstart`/`touchend` → `interrupt`（`L2064-2111`、`L2801-2823`）；`L4478` 是 `{passive:true}` 监听选项 |
| `dsh-client-ui-trajectory\lib\client.js` | 10 | 同上（滚动动画打断，`L2306-2328`） |

`chat\lib\client.js:2510`：

```js
const addEventListenerOptions = { passive: true };
```

**没有**：`swipe`、`long-press`、`pinch`、`drag`（触摸拖拽）、`gesture*` 事件、任何手势库。

### 7.2 `visualViewport`：1 处，且来自第三方库

`<PKG>\dsh-client-ui-conversation\lib\client.js:7821-7828`（在 `scrollIntoView` 的可见区计算内，属 vendor 代码）：

```js
if (e) {
  const e = r.visualViewport;
  if (e) { const t = e.offsetTop; c = t; a = t + e.height; }
  else c = 0, a = Il(t).innerHeight;
  ...
```

**第一方代码中没有任何 `visualViewport` 用于软键盘处理。** `--dsh-conversation-viewport-height` 是 `scroller.clientHeight`（`ResizeObserver`）写入的，**不会**因软键盘弹出而收缩（除非浏览器 resize 布局视口）。`chat` 里的回退值是 `100dvh`：

```css
--turn-rail-band: calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px));
```

### 7.3 `dvh` / `svh` / `lvh`：6 处

| 文件 | 用法 |
|---|---|
| `dsh-client-ui-primitives\lib\RiskConfirmation.module.css:13-15` | `@supports (height:100dvh){ .dialog{max-height:calc(100dvh - 48px)} }` |
| `dsh-client-ui-chat\lib\client.js` | `var(--dsh-conversation-viewport-height,100dvh)`（turn rail） |
| `dsh-client-ui-directory-picker-browse\lib\client.js` | `height:min(500px,100dvh - 32px)` |
| `dsh-client-ui-sidebar-documentpreview\lib\client.js` | `max-height:calc(100dvh - 24px)` |
| `dsh-client-ui-shortcuts\lib\client.js` | `max-height:calc(100dvh - 108px)` |
| `dsh-client-ui-schedule\lib\client.js` | 同族 |

→ `dvh` 只在**对话框/浮层**上用，主框架仍用 `height:100%`。

### 7.4 `safe-area-inset`：**0 处**（全仓库）

### 7.5 `enterkeyhint`：2 处，均在 PDF.js vendor

`<PKG>\dsh-client-ui-sidebar-documentpreview\lib\client.js:2057, 2231`（PDF.js 的 touch 文本框）。
→ **composer 的 textarea 没有 `enterkeyhint`**，手机回车键不会显示"发送"。

### 7.6 composer / textarea 与中文输入

`<PKG>\dsh-client-ui-conversation\lib\client.js`：`textarea` 4 处，`isComposing|compositionstart|compositionend` **36 处**。
→ **中文/日文 IME 合成保护做得非常充分**（`ui-primitives` 提供 `observeComposition`，`dsh-client-shortcuts` 明确"Composition, dead keys, AltGraph... pass through"）。这是对中文用户最有利的现状。

但 composer 的边距是**固定 px**，不随视口变化：

```css
--dsh-composer-side-clearance:16px;   /* wSkVaW_body */
--dsh-composer-side-clearance:8px;    /* 另有 8px 变体 */
--dsh-composer-text-max-height:336px; /* 固定，不随 dvh 调整 */
```

### 7.7 输入模态（`data-input-modality`）

`<PKG>\dsh-client-ui-primitives\lib\types\input-modality.d.ts`：

```ts
export declare const INPUT_MODALITY_ATTRIBUTE = "data-input-modality";
export declare function pointerModality(): boolean;
```

`README.md:152` 说明：`<html data-input-modality="pointer|...">` 驱动 `ui-theme` 的 `:focus-visible` 焦点环抑制。**这是唯一的"输入设备感知"机制，且只区分 pointer / keyboard，不区分 touch。**

### 7.8 键盘中心主义

`<PKG>\dsh-client-shortcuts\README.md:30`：

> Each command declares defaults for explicit `desktop:macos`, `desktop:windows`, `desktop:linux`, `web:macos`, `web:windows`, and `web:linux` profiles; **an omitted profile is unbound.**

- 六套 profile **全部是键盘**，无 `touch` / `mobile` / `pointer` profile。
- 布局快捷键 `sidebar.left.toggle` 只注册了 `desktop:{macos,windows,linux}` 和 `web:{macos,windows}` —— **`web:linux` 未绑定**（`dsh-client-ui-layout\lib\client.js:628-655`）：
  ```js
  defaults: {
    "desktop:macos": { code: "KeyB", modifiers: ["primary"] },
    "desktop:windows": { code: "KeyB", modifiers: ["primary"] },
    "desktop:linux": { code: "KeyB", modifiers: ["primary"] },
    "web:macos": { code: "KeyB", modifiers: ["primary", "alt"] },
    "web:windows": { code: "KeyB", modifiers: ["primary", "alt"] }
  },
  ```
- 手机浏览器 = `web:*`，但没有任何靠拇指可达的等价入口（汉堡按钮/边缘手势）。

---

## 8. 终端 / CLI 适配

### 8.1 结论：**不存在 TUI，但文档预留了 `tui` profile**

- 全量扫描 `ink` / `blessed` / `terminal-kit` / `neo-blessed`：**未安装**。
- `node_modules\@xterm\` 只有 `headless` + `addon-serialize`（**服务端** headless 终端仿真，不是 TUI 渲染器），被 `dsh-api-terminal-controller` 与 `dsh-terminal-bash` 使用。
- `dsh --profile tui --resume <id>` 只出现在**举例**里：

  `<PKG>\dsh\README.md:28`
  ```
  dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
  ```
  `<PKG>\dsh-cmdline\README.md:34`
  ```
  `ctx.cmdlineArgs` — ... `dsh --profile tui --resume abc` gives your app `['--resume', 'abc']`.
  ```

- 文档明确把 TUI 当作**未来表层**：
  - `<PKG>\dsh-api-remotes\README.md:36`：*"Its Client face can be reused by Web or **a future TUI** that provides the same React-free `ctx.remote` contract."*
  - `<PKG>\dsh-client-ui-skill\README.md:12`：*"...loads the skill consistently from the Web composer, **TUI**, and ACP..."*
  - `<PKG>\dsh-client-ui-user-questions\README.md:68`：*"...the presets that want it (and to **the TUI composition, which has no presets**)."*

- 已随发行版交付的 profile 只有：`web`、`headless`、`acp`、`sdk`、`sdk-minimal`（`<PKG>\dsh-app-boot\README.md:50`）。

### 8.2 各终端相关包的真实职责

| 包 | 真实职责 | 能否复用做 CLI 客户端 |
|---|---|---|
| `dsh-terminal` | **给 agent 用**的持久终端会话服务（`ctx.terminals`），跨工具调用保持 shell/REPL 状态；进程本地，不跨重启 | ❌ 是 agent 工具后端，不是前端 |
| `dsh-terminal-bash` | `dsh-terminal` 的 bash 后端，spawn + 就绪探测 | ❌ 同上 |
| `dsh-client-ui-sidebar-terminal` | **Web 右栏里的 xterm.js 标签页**（`client.terminal.js` 685,961 B 懒加载 chunk） | ⚠️ 是浏览器内终端，其 xterm + FitAddon + 主题映射代码**可参考**，但它渲染在 DOM 里 |
| `dsh-cmdline` | 内层 argv（`ctx.cmdlineArgs`）+ `--help`/错误退出契约，宿主应用解析自己的 flag | ✅ **任何新前端都应复用它** |
| `dsh-headless` | 一次性任务，打印最终答案退出；`--json` 逐行事件流、`--session-id` 续接；**无交互式后续** | ⚠️ 最接近"脚本化 CLI 客户端" |
| `dsh-acp` / `dsh-acp-app` | ACP stdio 服务端（Agent Client Protocol），供**自动化客户端**；*"intentionally omits DSH-specific presentation data and interactive UI features"* | ⚠️ 语义层可用，无 DSH 呈现数据 |
| `dsh-sdk-jsonrpc-server` / `dsh-sdk-app` / `dsh-sdk-minimal` | JSON-RPC stdio SDK | ⚠️ 可作传输层 |
| `@xterm/headless`, `@xterm/addon-serialize` | 服务端 ANSI 屏幕状态 + 序列化 | ✅ 若 TUI 需回放 agent 的终端输出，可复用 |

### 8.3 "把现有 Web GUI 用文本浏览器渲染"是否可行

**不可行**，理由有三：

1. 页面是 React SPA，靠 `window.__DSH_BOOT__` + `window.__ModuleLoader__.load({...})` 动态装载 60+ 个 `client.js`（`dsh-client-ui-layout\lib\client.js:1-3`）。w3m/lynx/links 不执行 JS。
2. 样式全部是 CSS Grid 三列 + 内联 `gridTemplateColumns` + `@container` 查询；文本浏览器无语义可用（`<div>` 无角色），得到的是控件文本堆叠。
3. `dsh-host-frontend-static` 只做静态文件服务 + 拼 index；认证靠 token cookie（`authorizeIndex`），CLI 客户端需另走 `/api`。

**可行路径**：新增一个**独立前端**，共用同一套 React-free 契约：

```
新 TUI 前端  ──┬── ctx.cmdlineArgs        (dsh-cmdline)        命令行
               ├── ctx.remote             (dsh-api-gateway/client)  RPC/流
               ├── ctx.connection         (dsh-client-connection) 信任/世代/重连
               └── ctx.locale             (dsh-client-locale)     文案
                       └── 新 profile 组合包：dsh plugin --profile tui add <pkg>
```

`<PKG>\dsh-api-gateway\README.md` 明确 `ctx.remote` 是"Client Cordis environment"的一侧，与宿主 `ctx.typertGateway` 共享同一份生成的 `InvocationDescriptor` 契约 —— **这是 TUI 应消费的 seam**，不需要 React、不需要 DOM。

**依赖清单**（需自行引入）：`ink`（React 风格 TUI）或 `blessed`/`terminal-kit`（命令式），以及 `yoga`/自有布局。

---

## 9. 渲染器可扩展性（真实 API 名）

### 9.1 三种诉求的答案

**(a) 贡献一个带样式的组件** —— ✅ 支持，两层：

1. **首选**：`@deepseek-ai/dsh-client-ui-primitives` 已含 40+ 原子（`Button`/`Menu`/`Modal`/`Tooltip`/`SegmentedControl`/`DisclosureRow`/`MarkdownText`/`CodeBlock`/`FileTypeIcon`…），它"takes `--dsw-*` design tokens from the theme, so they fit any plugin without importing the theme or the slot system"（`README.md:34`）。**跨插件不能互相 import 组件**，所以这个包是唯一的共享位置（`README.md:39`）。
2. **自带样式**：在自己的插件包内写 `*.module.css`（`ui-primitives` 与 `dsh-client-ui-chat` 都是这么做的），构建期由 tsdown 内联 + 打 `data-plugin-css` 标签。

**(b) 覆盖布局** —— ❌ **不行（用"新增插件"的方式）**。原因在槽位声明纪律：

`<PKG>\dsh-client-ui-slots\README.md:46`：
> **Declaring a slot is claiming it: the registering entry becomes the only entry allowed to render that key**, and registering into an undeclared slot, **declaring an already-declared child**, ... throws at load.

`root` 已被 `ui-layout` 独占（`dsh-client-ui-layout\lib\client.js:601-627`），`ui-renderer` 只调用唯一一次 `renderSlot('root')`（`dsh-client-ui-renderer\README.md:32`）。

`root` 下已声明的子槽（`client.js:604-625`）：

```js
children: {
  "sidebar":       { kind: "single", scope: "root" },
  "main":          { kind: "keyed",  scope: "root" },
  "rightbar":      { kind: "single", scope: "root" },
  "shell.overlay": { kind: "list",   scope: "root" },
  "shell.leading": { kind: "single", scope: "root" }
}
```

→ 插件可以往 `main`（带 `key`）加面板、往 `shell.overlay`（list）加浮层、占 `sidebar`/`rightbar`，但**不能新增第四列、不能换成两个标签页**。

**可行的布局覆盖路径**（三选一）：
1. **改 `@deepseek-ai/dsh-client-ui-layout` 本身**（用户在自己的 checkout 里改，或 fork 包）——最直接。
2. **在 profile 组合里禁用 ui-layout、挂一个自写 layout 包**，它自己 `ctx.slots.register({ name: 'root', ... })` 并 `ctx.reflect.provide('layout', ...)`。需要同时提供 `ILayout`（`service.d.ts`）以免其他插件报缺服务。
3. **纯 CSS 叠加**：利用 `shell.overlay`（list 槽）+ `ctx.theme.overrideTokens` + `data-*` 属性做"窄屏时把 sidebar 变成浮层"。**不需要改框架，但拿不到真正的 DOM 结构变更**（列还是三列，只是被 transform/absolute 覆盖）。

**(c) 为消息/事件类型注册新渲染器** —— ✅ 支持，但**不是"renderer registry"式 API**，而是**槽位 + 组件工厂**：

- `ctx.slots.register({ name, ... }, Component)` — 普通槽位
- `ctx.slots.registerFactory(definition)` + 注入的 `renderFactorySlot()` + `useFactorySlot(name, fallback)` — 可复用装配（Component Factory）
- `SlotFactoryMap` / `SlotMap` 用 `declare module` 增强
- 事实上的"工具结果渲染器选择"发生在各插件内部（`dsh-client-ui-tool`、`dsh-client-ui-chat`、`dsh-client-ui-renderer` 的 `bindings.ts`），而不是一个开放的 renderer 表

`ui-renderer` 的安装契约类型在 `<PKG>\dsh-client-ui-slots\lib\types\renderer.d.ts`：`SlotRenderer`、`SlotRendererHost`、`StaleAuthorizationError`、`SlotOwnershipError`。实现方是 `ui-renderer`（`createSlotRenderer()`），挂载入口是 `ctx.uiRenderer.mount(container)`。

---

## 10. 中文 / i18n

- 包：`<PKG>\dsh-client-locale`（`lib\client.js` 62,953 B），**`zh` 已内置**：`lib\types\locales\zh.d.ts` 与 `en.d.ts` 并存（`src/locales/` 是 shipped zh/en 词典）。
- 切换：Settings → General 的 Language 行；立即生效，并同步 `<html lang>`。
- 自动检测：`navigator.languages` 先全标签匹配、再主子标签匹配，回落 `en`。
- 持久化：loopback 页面写入 `$DSH_HOME/cordis.patch.yml`（`locale.preference` 命名空间）；非 loopback 仅进程内。
- 原生壳可提供 `__DSH_LOCALE__`（`read()` + `onChange(locale)`）。

**插件加翻译（官方文档化 API）** —— `<PKG>\dsh-client-locale\README.md:48-64`：

```js
export const inject = ['locale']

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }),
    'my-locale: language',
  )
  ctx.effect(
    () => ctx.locale.register('common', 'ja', {
      cancel: 'キャンセル',
      close: '閉じる',
    }),
    'my-locale: common dictionary',
  )
}
```

- 内置词典必须**同时**提供 `zh` 与 `en`：`ctx.locale.register(ns, { zh, en })`，命名空间合并进 `LocaleNamespaceMap`，编译期校验 key 联合类型。
- 消费：`ctx.locale.bind(ns)` 或框架注入的 `t` 座位。
- 外部语言包：`ctx.locale.addLanguage({ id, label, fallback })`，id 须为 BCP 47 风格 ASCII，fallback 链必须终止于 `en`。
- 其他：`ctx.locale.resolveText(text)` 处理 `LocalizedText`（插件标题/描述，不查命名空间词典）。
- 已知限制：注册期捕获的文本（如命令描述）不随语言切换；无复数规则与 RTL 支持。

→ **中文用户加自己的词典完全支持**；自适应改造新增的任何文案都必须走 `ctx.locale.register(ns, { zh, en })`，否则 `verify-client-ui-i18n` 会拒绝（`README.md:84` 提到的强制校验）。

---

## 11. 折叠屏

### 11.1 现状：**0 处**

全仓库扫描 `screen-spanning` / `env(viewport-segment-*)` / `viewport-segment` / `horizontal-viewport-segments` / `vertical-viewport-segments`：**0 命中**。

### 11.2 需要的 CSS 能力（今天都没用）

| 能力 | 用途 | 现状 |
|---|---|---|
| `env(viewport-segment-width <x> <y>)` | 取每个折页段的宽/高/left/top | 未使用 |
| `env(viewport-segment-left/top/right/bottom <x> <y>)` | 取段边界 | 未使用 |
| `@media (horizontal-viewport-segments: 2)` | 双竖折（书本式）触发双栏 | 未使用 |
| `@media (vertical-viewport-segments: 2)` | 双横折（帐篷式） | 未使用 |
| `@media (spanning: single-fold-vertical\|single-fold-horizontal)` | 旧的 Surface Duo 语法 | 未使用 |
| `env(safe-area-inset-*)` | 折页铰链避让 | 未使用 |
| `viewport-fit=cover`（meta） | 使上述 env 生效 | **未使用** |

### 11.3 可用的现成抓手

折叠屏本质是"视口切换到 2 段"→ 恰好等价于"中栏变得可双栏化"。现有机制可直接承接：

1. `SIDEBAR_AUTO_COLLAPSE` 已按 `viewportWidth` 分支 —— 可扩展为按"段数"分支。
2. `computeColumns()` 是纯函数，可加一个 `segments` 参数。
3. `@container` 已在 8 个插件里用于"按列宽自适应" —— 双段时中栏变宽会被容器查询自动利用（已经是**意外正确的行为**）。
4. `ResizeObserver` → `--dsh-*` 通道已成熟。

**缺口**：`AppFrame` 的 `gridTemplateColumns` 是内联写死的三列，铰链处没有 padding/gap 概念，也没有把"面板同时显示"作为一等状态（右栏是 track 而非并列区域）。

---

## 12. 适配目标 → 现状 → 缺失 → 改动位置

| 适配目标 | 今天已有什么 | 缺什么 | 改哪里 |
|---|---|---|---|
| **手机（竖屏 ~360-430px）** | `@media (width<=400/480px)` 3 处微调；`pointer:coarse` 5 处让 hover 控件可达；`dvh` 用于浮层；`--dsh-chat-content-width:min(calc(100% - 32px),920px)` 已能在 360px 下退到 328px | ① 无 `viewport-fit=cover` → safe-area 全废 ② 三列仍在，左栏是 56px rail 挤占 中栏 ③ 无抽屉/汉堡/底部标签栏 ④ composer 无 `enterkeyhint` ⑤ composer 固定 padding，软键盘不驱动高度 ⑥ 无 `visualViewport` 监听 ⑦ 触控目标尺寸无 >=44px 保证 ⑧ 无 SW/可安装 ⑨ 图标非 maskable | `dsh-web-frontend\dist\index.html`（meta）<br>`dsh-host-webserver` 的 `IndexInjection`（注入 style/meta）<br>`dsh-client-ui-layout\lib\client.js`（`SIDEBAR_AUTO_COLLAPSE`、`AppFrame`、新增 `data-compact`）<br>`dsh-client-ui-conversation`（composer 变量 + `enterkeyhint`）<br>`dsh-client-ui-chat`（触控尺寸）|
| **平板（竖 768-834 / 横 1024-1366）** | 1024 阈值会在竖屏平板收起左栏（合理）；`@container (width<=900px)` 会隐藏 chat turn rail；`@container (<=620/560px)` 会收紧卡片 | ① 只有一级阈值，竖屏平板被当作"窄屏"处理（收起左栏）但中栏其实有 ~768px ② 无"中等"档（如 768-1024）③ 无分屏/双栏内容 | `dsh-client-ui-layout\lib\client.js` 的 `SIDEBAR_AUTO_COLLAPSE` → 换成断点集合；`columns.d.ts` 加常量；`computeColumns()` 加档位参数 |
| **桌面（>=1280）** | 完整三列 + 拖拽把手 + 宽度偏好；`@media (width<=1200px)` 仅影响 onboarding 插画 | 基本无缺失（这是当前唯一被优化的目标） | — |
| **折叠屏（双段）** | `@container` 会随中栏变宽自动生效；`ResizeObserver` 通道可用 | ① 0 处 `viewport-segment-*` / `screen-spanning` ② `viewport-fit=cover` 缺失 → env 全 0 ③ `AppFrame` 内联三列网格无铰链 gap/padding 概念 ④ 无"段数"状态 | `index.html` meta；`dsh-client-ui-layout\lib\client.js`（`computeColumns` + `gridTemplateColumns` + 新增 `data-fold`）；CSS 加 `@media (horizontal-viewport-segments:2)`；`dsh-host-webserver` 注入 `env()` 感知样式 |
| **终端 / CLI** | `dsh-cmdline`（argv）、`ctx.remote`（React-free RPC）、`dsh-client-connection`、`dsh-client-locale`、`@xterm/headless` + `addon-serialize`、`dsh-headless --json`、ACP/SDK profile | ① 无 TUI 前端 ② 无 `ink`/`blessed` 依赖 ③ 无 `tui` profile 组合包 ④ Web GUI 无法被文本浏览器渲染 ⑤ 无图片/表格/代码块的字符画降级策略 | **新增包** `<新 tui 前端>` + `<新 tui profile bundle>`（`dsh plugin --profile tui add ...`）；复用 `ctx.remote` / `ctx.cmdlineArgs` / `ctx.locale`；参考 `dsh-client-ui-sidebar-terminal\lib\client.terminal.js` 的 xterm 主题映射 |
| **触屏通用（所有尺寸）** | `pointer:coarse` 5 处 + `hover:none` 2 处；`data-input-modality` 只区分 pointer/keyboard | ① 无 `touch` 快捷键 profile ② 无长按/滑动/捏合 ③ 拖拽把手（sidebar/rightbar）用 `pointerdown`+`setPointerCapture`，在触屏上会与页面滚动冲突（无 `touch-action` 声明） ④ 无 >=44px 触控目标规范 ⑤ 工具栏按钮高 28-36px | `dsh-client-ui-layout\lib\client.js` 的 `DragHandle`（加 `touch-action`）；`dsh-client-shortcuts`（加 touch profile 或改为"设备能力"模型）；`dsh-client-ui-primitives`（触控尺寸变体）；各插件的 `@media (pointer:coarse)` |

### 12.1 `DragHandle` 的触屏风险（具体证据）

`<PKG>\dsh-client-ui-layout\lib\client.js:165-177`：

```js
const onPointerDown = react.useCallback((e) => {
  if (e.button !== 0 || capture.current !== null) return;
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  ...
```

没有任何 `touch-action: none` 声明（CSS 侧只看到 `.pI_x6G_handle` 的定位）。触屏上拖动把手会同时滚动页面。

---

## 13. 未验证 / 风险

1. **`lib/client.js` 是压缩混淆产物**：行号取自格式化后的文件，`.d.ts` 是可靠契约但实现细节（如 token 的实际算值、`@container` 的完整作用域）只能从字符串常量推断。**未在真实浏览器中运行验证任何一条结论。**
2. **未验证 `@container` 的实际容器归属**：`container-type: inline-size` 出现在 `EvIC1a_frame`/`EvIC1a_scroll`/`eGxaPq_slot`/`uV2eYG_row`/`Y0dWHa_tablePane` 等类上，但 `@container (width<=900px)` 等**未命名**查询会匹配最近的祖先容器。实际生效的容器是哪一个**未通过浏览器确认**。
3. **`--dsw-*` 计数（601 次 / 403 唯一名）来自正则匹配 `--dsw-[a-zA-Z0-9-]+\s*:`**，会漏掉：无空格的 `--dsw-x:val` 已覆盖、但 `var(--dsw-x)` 形式的"引用但未定义"不计入；`.d.ts` 里 `ThemeTokenInspection.cssVariable` 声明的 token 可能多于实现。**403 是"在 theme 的 client.js 中至少定义过一次"的名字数，不是设计系统的权威清单。**
4. **`@media` 普查基于原始文本而非解析后的 CSS**：`calc()` 内、`@supports` 内、字符串字面量内的 `@media` 会被计入；`dsh-web-frontend\dist\assets\langs\*.js`（语法高亮语法文件，含 CSS/Less 的 `at-media` 定义）已排除，但**未被排除的 vendor 大包**（`client.terminal.js` 685 KB、`client.pdf.js`）内的 `@media` 会影响"第一方 vs vendor"的归属判断。§7 的"第一方"扫描显式排除了这两个文件。
5. **`--profile tui` 的存在性**：只能确认"没有随发行版交付的 tui 组合包"和"没有 ink/blessed 依赖"。**不能排除**在 `$DSH_HOME/profiles/` 下用户已装过第三方 TUI 包，或 DSH 内部有未随 npm 发布的 TUI 实现。
6. **`visualViewport` 归属**：`conversation\lib\client.js:7822` 上下文是 `scrollIntoView` 的可见区计算，判定为 vendor 代码，但**未比对 sourcemap 确认**。
7. **`enterkeyhint` 归属**：两处均在 `dsh-client-ui-sidebar-documentpreview\lib\client.js`（PDF.js viewer），判定为 vendor；**composer 侧确认为 0**。
8. **移动端真机行为未测**：软键盘弹出时 `scroller.clientHeight` 是否变化取决于浏览器实现（iOS Safari 不 resize 布局视口），因此"composer 被软键盘遮挡"的严重程度**无法从静态代码判定**。
9. **不可安装的根因未穷尽**：缺少 SW 是主因，但 Chrome 还要求 `start_url` 可访问 + 图标 >=144px（SVG `sizes:"any"` 是否被接受**未验证**）。
10. **性能未测**：`ui-renderer` 的"首个应用帧等待全部 client entry 就绪"（`dsh-client-ui-renderer\README.md:94`）在移动端弱网/低端 CPU 上代价未知。
11. **`SIDEBAR_AUTO_COLLAPSE` 的来源**：注释称 "deepsuite LG breakpoint"，但未在任何包内找到 deepsuite 设计系统的断点定义文件，**无法核对 1024 是否是设计系统的一致取值**。
12. **主题 README 与产物的不一致**：README 描述 8 张 `.css` 表位于 `src/styles/`，但 npm 包只发 `lib/styles/brand-font.css`（+ 3 个 woff2 + OFL）。**升级 DSH 版本时若内联策略变化，本报告的 token 计数与定位会失效。**

---

## 14. 给"自适应网页"计划的三条硬约束

1. **列宽是 JS 内联样式**，不是 CSS。任何媒体查询方案都无法改变三列结构；必须动 `AppFrame`（`gridTemplateColumns`）或换成容器查询 + CSS 变量驱动。
2. **`root` 槽位被 `ui-layout` 独占**，插件无法"从外部"替换布局。要做真正的手机版布局，必须改包或在 profile 里替换 `ui-layout`。
3. **`viewport-fit=cover` 缺失 + `safe-area-inset` 0 命中**，所以任何移动端方案的第一步都必须是改 `index.html` 的 viewport meta（通过 `dsh-host-webserver` 的 `IndexInjection` 或直接改 `dsh-web-frontend\dist\index.html`）。
