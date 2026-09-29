# DSH 第三方插件架构调研（Host + Client）

- **调研对象**：DSH（DeepSeek Harness）**0.1.7-rc.2**
- **安装目录**：`C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
- **用户 home**：`C:\Users\WANGZ\.dsh`；**活动 profile**：`web`（`C:\Users\WANGZ\.dsh\profiles\web`）
- **第三方样例**：`C:\Users\WANGZ\.dsh\profiles\web\node_modules\dshmarket`（v1.66.5，MIT，**未压缩的 `src/` 随包发布**，是最好的实际模板）
- **证据标记**：`[已验证]` = 直接读到代码/类型/文档；`[推断]` = 由周边证据推理，未直接读到实现；`[未验证]` = 见文末章节。

> 下文所有相对路径若以 `@deepseek-ai/` 开头，均指上面的 npm-cache 安装目录；`dsh/` 指 `@deepseek-ai/dsh` 包；`profile/` 指 `C:\Users\WANGZ\.dsh\profiles\web`。

---

## 1. 插件契约（Plugin Contract）

### 1.1 两种插件形态

DSH 的插件本质就是 **Cordis 插件**（`@deepseek-ai/cordis` ~4.0.4）。一个包可以同时提供：

| 形态 | 入口 | 运行环境 | 发现方式 |
|---|---|---|---|
| **Host 插件** | `package.json.main` → `lib/index.js` | Node（Host 进程） | Loader 条目 `name:` 指向包名，解析到 `main` [已验证] |
| **Client 插件** | `exports["./client"]` → `lib/client.js` | 浏览器 | `package.json.dsh.client.platform === 'web'`，Host 侧把该文件作为 bundle 经 `/plugins/...` 提供 [已验证] |

`@deepseek-ai/dsh-client-ui-theme/package.json` 是最小完整样例，两者都有：

```json
"type": "module",
"main": "lib/index.js",
"types": "lib/types/index.d.ts",
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./package.json": "./package.json"
},
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale",
               "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-settings",
               "@deepseek-ai/dsh-api-remotes"],
    "platform": "web",
    "immediately": true
  }
}
```
（`@deepseek-ai/dsh-client-ui-theme/package.json`）

### 1.2 Host 插件模块的导出形状

`@deepseek-ai/dsh-client-ui-theme/lib/index.js`（Host 半）导出：

```js
const Config = z.object({                      // schemastery schema，命名导出 Config
	preference: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE).volatile(),
	fontSize: z.number().step(1).min(12).max(17).default(14).volatile()
});
function apply(ctx, config) { ... }            // 命名导出 apply(ctx, config)
export { Config, ..., apply };
```
（`@deepseek-ai/dsh-client-ui-theme/lib/index.js` 末尾；类型见同包 `lib/types/index.d.ts`：`export declare function apply(ctx: Context, config: Config): void`）

Host 插件契约要点 `[已验证]`：

- **导出 `apply(ctx, config)`**：`ctx` 是 Cordis `Context`，`config` 是由 `Config` schema 归一化后的值。**没有 default export**；Loader 直接消费模块的具名导出，所以 `name` / `inject` / `Config` 必须是**具名导出**（否则 bundler 会 tree-shake 掉）。
- **导出 `inject: string[]`**：Cordis 服务依赖声明（DI key 列表，不是包名）。文件里若不导出 `inject`，插件不依赖任何服务。示例：`@deepseek-ai/dsh-tool-todo/lib/index.js:12` → `const inject = ["tools", "sessionProjections"];`
- **导出 `Config`（可选）**：schemastery（`@deepseek-ai/schemastery`）对象。profile patch 里 `config:` 块由它校验/填默认值。`.volatile()` 表示该字段变化时**不触发插件重载**而走运行时引用（theme 用它做「热改主题不重启」）。
- **`name`（可选）**：诊断用标签。`@deepseek-ai/dsh-tool-todo/lib/types/index.d.ts:10` → `export declare const name = "tool-todo";`
- **`apply` 内可用 API（全部 [已验证] 出现在真实包中）**：
  - `ctx.inject([...services], (child) => ...)`：等待服务就绪后再执行（主题用它等 `settings`）。
  - `ctx.effect(() => disposer | void, label?)`：注册随 fiber 卸载清理的副作用（`webServer.register` 的 disposer、locale 注册等）。
  - `ctx.on(event, handler, opts?)`：监听 Cordis 事件；theme 用 `ctx.on("webserver/index-inject", table => table.push(...))` 往 web 页 `<head>`/`<body>` 注入样式与引导脚本，**并支持 `{ prepend: true }` 插队**。
  - `ctx.provide(name, value)` / 继承 `Service`：注册服务（见 §4.1）。
  - `ctx.get(name)`：可选读取服务（`settings-general` 用 `ctx.get("connection")`）。
  - `ctx.tools.register(defineTool({...}))`：注册模型可见工具（`@deepseek-ai/dsh-tool-todo/lib/index.js:95`）。
  - `ctx.sessionProjections.register(definition)`：注册客户端可见的只读投影单元（同文件 `:80`）。

### 1.3 Client 插件模块的导出形状 —— 关键差异

Client bundle **不是普通 ESM import**，而是包在 Loader facade 里的工厂模块。`@deepseek-ai/dsh-client-ui-theme/lib/client.js:1-6,1628-1634`：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-theme",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		...
		exports.theme = ThemeRuntime;   // 只是示例；真实导出见下
		exports.SETTINGS_NS = SETTINGS_NS;
		exports.ThemeRuntime = ThemeRuntime;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
```

即 **Client 插件同样是「具名导出 `apply` + `inject`（+ 可选 `name`）」**，只是外层多一层 `__ModuleLoader__.load({ id, factory })` 包装 `[已验证]`：

```js
const inject = ["slots", "locale", "remote", "configForms"];   // 客户端服务名
function apply(ctx) {
	installThemeStyles(ctx);
	const theme = new ThemeRuntime(ctx, ctx.configForms.get(THEME_SETTINGS_NAMESPACE));
	ctx.provide("theme", theme);                                  // 注册客户端服务
	ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "ui-theme: settings row dictionaries");
	ctx.on("theme/change", sync);
	ctx.slots.inject("settings.general.item", () => ctx.slots.register({
		name: "settings.general.item", id: "appearance", order: 10,
		store, locale: SETTINGS_NS, inject: injected
	}, AppearanceRow));
}
```
（`@deepseek-ai/dsh-client-ui-theme/lib/client.js:1567-1626`）

`dshmarket` 的客户端入口（第三方、有 `src/` 可读）形状完全一致 `[已验证]`：

```ts
export const name = 'dsh-market'
// 'theme' is safe to require: ui-layout (mandatory in every web composition)
// already hard-depends on it. This cordis's object-form inject means
// intercept config, NOT {required,optional} — do not use it here.
export const inject = ['slots', 'locale', 'theme']
export function apply(ctx: MarketClientContext): void { ... }
```
（`dshmarket/src/client/index.ts:95-100`）

> **重要语义澄清 `[已验证]`（dshmarket 源码注释）**：`package.json.dsh.client.inject` 与模块导出的 `inject` **不是一回事**。
> - `dsh.client.inject` 是**信息性**的包名依赖列表（`dsh-package-manifest` 原文：*"Informational package-name dependencies, not Cordis service injection"*），用于让 Host 侧的 bundle 组合按拓扑排序（*"让动态提供方先于其消费方加载"*）。
> - 模块导出的 `inject` 才是 **Cordis 服务名**数组（`slots`、`locale`、`remote`…），决定「服务不齐就不激活」。
> - 客户端 bundle 里**可以用对象形式的 `ctx.inject({ required: [...], optional: [...] })`**，但 dshmarket 明确警告本仓库 cordis 的对象形式 `inject` 是拦截配置语义，不要在模块级 `inject` 里用。

### 1.4 其余三个差异化样例（全部 [已验证]，均来自 `lib/client.js` 尾部 grep）

| 包 | Client `inject`（服务） | 贡献方式 |
|---|---|---|
| `dsh-client-ui-settings-general` | `["slots","locale","connection","remote","remote.settings","configForms","shortcuts"]` | 往 `settings.general.item` 注册多行（`line 957`）、`sidebar.toggle.badge`（`983`）、`settings.trigger/header/action/close/section`（`1152-1171`）、`ctx.shortcuts.register(...)`（`1065`）。**它是 settings 面板的 shell**，但自身不拥有任何文案 |
| `dsh-client-ui-sidebar-files` | `["slots","locale","session","..."]`（`line 934`） | `ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name:"sidebar.right.pane.tab", key:<tabType>, inject, children: { "sidebar.right.tab.files.actions": {...} } }, FilesBody)))`，另注册 `sidebar.right.pane.tab.title`。Host 半 `apply()` 是空函数：`/** Pure host half; the whole tab type lives in the browser export. */ export declare function apply(): void;` |
| `dsh-tool-todo` | 无 client 半 | Host：`inject = ["tools","sessionProjections"]`，`ctx.sessionProjections.register({key:"todos",...})` + `ctx.tools.register(defineTool({ name:"todo_write", description, parameters:{...}, output:{schema}, ... }))` |

**结论**：一个包可以 host-only、client-only 或**双半**（theme / sidebar-files / dshmarket 都是双半）。双半的 Host 半通常很薄（提供配置、Host 服务、注入 index 行），重活在 Client 半。

---

## 2. `package.json` 的 `dsh` 字段

### 2.1 权威类型定义

`@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts` 是公开字段的权威声明 `[已验证]`：

```ts
export interface DshManifest {
    /** Manifest format version, independent of the npm package and Session format versions. */
    manifestVersion?: 1;
    /** Bundle metadata consumed by the profile launcher. */
    bundle?: DshBundleManifest;
    /** Profile metadata consumed by the profile launcher. */
    profile?: DshProfileManifest;
    /** Client module loading and build metadata. */
    client?: DshClientManifest;
}
export interface DshBundleManifest {
    /** One patch file path, or an ordered list applied in sequence, each relative to the declaring package root. */
    patch: string | string[];
}
export interface DshProfileManifest {
    /** Ordered bundle layer list, using installed package names. */
    bundles?: string[];
}
export interface DshClientManifest {
    /** Client platform identifier; the Web consumer selects `web`. */
    platform: string;
    /** Informational package-name dependencies, not Cordis service injection. */
    inject?: string[];
    /** Boot phase-one registration barrier; absent means the shared application batch. */
    immediately?: boolean;
    /**
     * Exact module-table requests beyond the implicit client baseline, including
     * subpaths such as `<pkg>/client`; absent means baseline externals only.
     * Type-only imports are erased and create no module request.
     */
    external?: string[];
}
export interface DshEnginesManifest {   // package.json.engines
    dsh?: string; node?: string; npm?: string; [engine: string]: string | undefined;
}
```

### 2.2 全生态 `dsh.*` 字段清单（扫描全部 219 个包 + dshmarket + profile 得出）

| 字段 | 出现处 | 含义 | 谁消费 |
|---|---|---|---|
| `dsh.manifestVersion` | 公开类型；本机安装的包**均未声明**（可选） | manifest 格式号，当前仅 `1` | 无强制读者 `[已验证]`（README：*"Current installers and loaders do not enforce `dsh.manifestVersion`"*） |
| `dsh.bundle.patch` | 所有组合包：`dsh-base`、`dsh-web-app`（数组 5 个 patch）、`dsh-headless`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`、`dsh-experimental-*`、`dshmarket` | 该包作为 **bundle 层**贡献的 patch 文件（一个或有序数组），路径相对包根 | `dsh-app-boot` 的 profile 组合；`dsh-plugin-manager` 的 `reconcile()` + `bundlePatchPaths()` |
| `dsh.profile.bundles` | 仅 profile 目录的 `package.json`（`profile/package.json`） | **有序** bundle 层列表，用已安装包名 | `dsh-app-boot` composeProfile；`dsh --profile <n> --dump-config` |
| `dsh.profile.patchReload` | `profile/package.json` 里实测存在（`"patchReload": "live"`） | 语义应为「patch 变更热重载」 | **在已安装的 JS 里 grep 不到 `patchReload` 字样** `[未验证]`（见文末） |
| `dsh.client.platform` | 全部 ~80 个 web 客户端包，值恒为 `"web"` | 客户端平台标识 | `dsh-client-modules` 的 manifest 解析器（只选 `web`） |
| `dsh.client.inject` | 全部 web 客户端包 | **信息性**包名依赖（不是服务注入），使 bundle 组合按拓扑排序 | `dsh-client-modules` 组合阶段（拒绝环、自请求、缺失提供方） |
| `dsh.client.immediately` | `dsh-client-connection`、`dsh-client-modules`、`dsh-client-ui-renderer`、`dsh-client-locale`、`dsh-client-ui-theme`、`dsh-api-remotes`、`dsh-api-gateway`、`dsh-client-hmr`、`dsh-client-file-upload`、`dsh-typert-registry` | **启动第一阶段屏障**：声明者进 modules bootstrap combo，其他进共享 application combo | `dsh-client-modules`（"启动清单注入"：bootstrap combo 是 parser 阻塞脚本） |
| `dsh.client.external` | `dsh-api-gateway/client`、`dsh-api-job-controller`、`dsh-api-session-controller`、`dsh-api-terminal-controller`、`dsh-api-workspace-controller`、`dsh-api-workspace-files`、`dsh-experimental-client-ui-voice-input` | 基座（静态模块表）**之外**的额外 external 精确请求（含子路径） | `dsh-client-modules` 组合阶段校验 |
| `dsh.sessionFormatMigration` | 4 个 `dsh-session-format-v0-to-v1`…`v3-to-v4` | **内部/非公开**（README 明说不暴露） | 镜像打包器/catalog/launcher |

> **注意**：**没有** host 侧专用字段（不存在 `dsh.host` / `dsh.entry` / `dsh.name`）。Host 半完全靠 npm 标准 `main` / `exports["."]` 被 Loader 解析 `[已验证]`（`dsh-package-manifest` README：*"Internal `configTrees`, `sessionFormatMigration`, and generated `moduleFallback` metadata remain owned by their image-packer, catalog, and launcher readers; the public types do not expose them."*）。

### 2.3 Client 入口如何被发现 + bundle 如何到达浏览器

这是 `dsh-client-modules` 的职责。以下全部来自 `@deepseek-ai/dsh-client-modules/README.zh.md` `[已验证]`：

1. **声明**：包声明 `dsh.client.platform === 'web'`、导出 `./client` bundle、在 `dsh.client.external` 列出基座外的模块请求。
2. **Host 半侧（Node）**：`ctx.clientModules` / `ClientModuleRegistry` 增量扫描已启用的 Loader 条目（每次 `internal/plugin` 事件标脏该 fiber 的 entry 名），把每个声明变成可加载 bundle，**在 `/plugins` 下提供**；按需惰性提供（首次 `GET` 才组合 body）。
3. **产物快照**：Host 在发布前**快照**每个 `client.js`；revision 由入口的 `mtimeMs` / `ctimeMs` / 大小派生（**不 hash 内容**）。URL：`/plugins/<package>/client.js?rev=<rev>`，chunk 为 `/plugins/<package>/client.<name>.js?rev=<rev>`；批量 combo 路由是 `/plugins/??...&rev=...`（每阶段 URL 不超过 3 KiB）。
4. **注入 index**：Host 往页面注入 `window.__ModuleLoader__` queue facade → 各 application combo 的 preload 提示 → 阻塞 parser 的 **bootstrap combo** `<script>` → 启动图（`window.__DSH_BOOT__`，`<` 已转义）。facade 的 `create()` 物化 modules bundle 并把 `createClientModuleSystem` 的实例装成外壳 Loader 的 `internal`，即 `ctx.modules`。
5. **浏览器半侧**：`ClientModuleSystem` = **惰性 CJS 模块表**。执行 bundle **只注册 factory**，模块副作用（含 CSS 注入）在物化时才跑（`factory(require)` → exports，`loadCache` 记忆化）。同步 `require` 的解析顺序：**平台 seed 表 → 记忆化记录 → 启动图 row → 已注册 factory**；其他一律抛错。`require.async(...)` 用于 tsdown 拆分出的 chunk（编译为 `require.async("./client.<name>.js")`）。
6. **共享模块基座**：外壳初始化一张冻结的模块表（README 称 `PLATFORM_MODULES`：React、Cordis 与静态 UI 库）。实证：`dsh-client-ui-theme/lib/client.js` 与 `dshmarket/client/client.js` 都直接 `require("react")`、`require("react/jsx-runtime")`、`require("react-dom")`、`require("@deepseek-ai/dsh-client-ui-primitives")`、`require("@deepseek-ai/dsh-client-store")`，而它们的 `dsh.client.external` **为空** —— 说明这些就在基座表里 `[已验证，`PLATFORM_MODULES` 这个符号名本身未在已安装 JS 中 grep 到，见文末]`。
   `dsh-client-ui-renderer` README 佐证 `[已验证]`：*"React、React DOM、Cordis、ui-slots 与 ui-primitives 通过 Web 外壳的静态模块表保持同一浏览器身份；本包则以动态客户端 bundle 的形式加载。"*
7. **构建前置条件**：*"宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；缺失 bundle 会明确导致激活失败。"* —— 第三方插件发布 npm 包时必须**已构建** `lib/client.js`。
8. **HMR**（`@deepseek-ai/dsh-client-hmr`）：Host 半轮询入口产物 stat（`pollIntervalMs` 默认 500），提供 `/plugins/events` SSE；帧类型 `graph` / `rebuilt`。收到 `rebuilt` 后浏览器替换该 entry（**React 状态丢失**，会话/工作区状态保留），并级联重载依赖方。
9. **静态 dist**（`@deepseek-ai/dsh-host-frontend-static`）：占据 `webServer` 的**回退席位**，服务已构建 SPA，每个 index 响应经 `ctx.webServer.renderIndex`（即带上启动 manifest）。这与插件 bundle 路由（`/plugins`）是两套独立机制。

---

## 3. Slot 系统（客户端 UI 扩展点）

### 3.1 模型（来自 `@deepseek-ai/dsh-client-ui-slots/README.zh.md` + `lib/types/index.d.ts`，全部 [已验证]）

- 纯核心是 `SlotCore`（零依赖、无 React）。**Slot 契约表 `SlotMap` 在本包声明为空，由消费方通过 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { ... } }` 声明合并增补。**
- **声明 = 渲染授权**：`register()` 的 `children` 表既声明子 slot、又获得渲染它的唯一权利。注册未声明的 slot、重复声明子 slot、同一 store handle 跨 scope 挂载、chain 缺 `select` —— 都在**加载时抛错**。
- 四种 kind：
  - `single`：单占位者（同 cell 同 priority 的第二个注册会抛错；可声明不同 priority 形成 shadowing）。
  - `list`：有序条目（`id` + `order` + 可选 `label`）。
  - `keyed`：按键分派（`key`）。
  - `chain`：条目自带 `select(owner) => matched | null` 的选举（按 `priority` 升序，全 null 走 owner fallback）。
- 三种 scope：`root`（全局）、`session-maybe`（无会话也可渲染）、`session`（严格绑定当前会话）。
- 组件 props 由**五个 framework share** 组合而成（`ComposedProps`）：runtime share（owner props + scope standard kit）、child render share（`renderSlot` / `renderSlotChain` / `SessionProvider`）、Factory share（`renderFactorySlot`）、store share（`useStore` selector + baked actions）、业务 share（`inject` 工厂返回值）+ 可选 locale `t`。
- 注册 API：`ctx.slots.inject(slotName, () => ctx.slots.register(options, Component))`。**`inject` 会等该 slot 被声明**（即使注册方先于声明方激活），这也是 dshmarket 用来做**版本探测**的手段。
- 服务名（客户端）：`ctx.slots`（`SlotRegistry`，由 `dsh-client-ui-renderer` 安装）。注册方通过 `ctx.effect` 包装可获得自动注销。
- `'root'` slot 是框架预置的**唯一先验声明**（渲染树根洞），由 `dsh-client-ui-layout` 的 `AppFrame` 占据。`dsh-client-ui-renderer` 的类型注释明确警告 **不要往 `root` 注册**：

  > *"DO NOT register here. … a dynamically registered entry is assigned a lower priority than the shipped one, which makes it the winner: the page would render your component alone, with every seat the frame declares gone. For a surface of your own that floats over the whole app, register into `shell.overlay` instead (a list slot: additive, and click-through until your entry opts into pointer events)."*
  > —— `@deepseek-ai/dsh-client-ui-renderer/lib/types/client/registry.d.ts:18-31`

### 3.2 全部 Slot 名称表（从各包 `interface SlotMap` 声明穷举）

图例：kind/scope；**声明者** = 声明该 slot 的包（注册前必须先有声明）。

#### 框架与外壳

| Slot | kind / scope | 声明者 | 用途 / owner props |
|---|---|---|---|
| `root` | single / root | `dsh-client-ui-renderer` | 渲染树根洞，被 `AppFrame` 占据。**禁止注册** |
| `sidebar` | single / root | `dsh-client-ui-layout` | 整条左列。被 `ui-sidebar` 占；注册即**替换**导航列。owner: `{collapsed, width}` |
| `main` | keyed / root | 同上 | 中栏面板按 sidebar entry id 分派（`conversation` 为保留键） |
| `rightbar` | single / root | 同上 | 右列轨道。owner: `{width, viewportWidth, canShow}` |
| **`shell.overlay`** | **list / root** | 同上 | **「Frame-wide floating layer, above every column and outside their scroll containers」**。badge / toast stack / status pill / 悬浮挂件都归这里；层本身 click-through，条目要自己 opt in pointer events。**桌面宠物首选** |
| `shell.leading` | single / root | 同上 | 顶左窗口 chrome 席位（仅左列完全隐藏时挂载） |
| `shell.quota-notice` | chain / root | `dsh-client-ui-chat` | 全框配额提示链 |

#### 设置面板

| Slot | kind / scope | 声明者 | 用途 |
|---|---|---|---|
| `settings.launcher` | single / root | `dsh-client-ui-settings` | 侧栏账户启动器（owner: `{wide, settingsOpen, settingsShortcut?, openSettings, openOnboarding}`） |
| `settings.trigger` | single / root | 同上 | 侧栏底部触发行内容（owner: `{wide}`） |
| `settings.header` / `settings.close` | single / root | 同上 | 面板标题文本 / 关闭按钮无障碍名（无 owner props） |
| `settings.action` | list / root | 同上 | 内容列头部动作（Close 之前，有序） |
| **`settings.section`** | **list / root** | 同上 | **一整个设置页**。`id`（键/`only` 过滤）、`order`、`label`（注册方本地化，locale 变化时用新文案重注册）。owner: `{close}`。dshmarket 的 Market 页就是这么加的（`order: 40`） |
| `settings.plugins.tab` | list / root | 同上 | Plugins 设置区里的一个 Tab（`id`/`order`/`label`） |
| `settings.onboarding` | list / root | 同上 | 引导步骤（owner: `{stepId, explicit?, complete, openSection}`） |
| **`settings.general.item`** | **list / root** | 同上（类型由 locale 包持有） | **General 页里的一行偏好**。`id`/`order`；**owner 不传任何 props**，行自己画 label 与写路径。theme 的 Appearance（order 10）与 FontSize（order 11）就在这里 |
| `settings.models.provider-card` / `.sign-in` / `.footer` | — | `dsh-client-ui-settings-models` | 模型设置页扩展 |
| `plugins.bundle.activation` / `plugins.item` / `plugins.bundle.config` / `plugins.row.config` / `plugins.detail.actions` / `plugins.detail.badge` / `plugins.detail.section` | — | `dsh-client-ui-plugin-manager` | 插件管理页；**第三方 bundle 的配置卡应放 `plugins.bundle.config` 或 `plugins.row.config`**（源码注释原文） |

#### 侧栏（左）与右栏

| Slot | kind / scope | 声明者 | 用途 |
|---|---|---|---|
| `sidebar.toggle.badge` | single / root | `dsh-client-ui-sidebar` | 折叠按钮角标 |
| `sidebar.brand.mark` / `sidebar.brand.name` | — | 同上 | 品牌标记/名 |
| `sidebar.panellist` | — | 同上 | 面板列表 |
| `sidebar.workspaces` | — | 同上 | 工作区区块 |
| `sidebar.settings` | — | 同上 | 设置入口席位（`ui-settings-general` 占） |
| `sidebar.footer.action` | — | 同上 | 底部动作 |
| `rightbar.session` | single / session | `dsh-client-ui-sidebar-right` | 右栏会话内容（owner 带 `{active, retainTab}`） |
| **`sidebar.right.pane.tab`** | **keyed / session** | 同上 | **右栏一个 Tab 的正文**，key = tab type 的 `id`。`hookContext: TabHookContext`，`inject: {hooks:{tabInfo}}`。sidebar-files 的 `FilesBody` 就在这里 |
| `sidebar.right.pane.tab.title` | keyed / session | 同上 | 同 key 的 chip 标题 |
| `sidebar.right.tab.guide` | chain / session | 同上 | Guide Tab 正文替换 |
| `sidebar.right.tab.guide.entry` | keyed / session | 同上 | Guide 卡片 |
| `sidebar.right.tab.menu.item` | list / session | 同上 | Tab 动作菜单附加项（owner: `{tab, dismiss}`） |
| `sidebar.chat.conversation` | — | `dsh-client-ui-subagent` | 子 agent 侧栏对话 |
| `sidebar.workspaces.directoryFlow` / `sidebar.session.row.leading` / `sidebar.session.row.hover` / `sidebar.workspaces.session.menu.item` / `sidebar.workspaces.session.row.action` | — | `dsh-client-ui-workspace` | 工作区/会话行扩展 |

#### 会话与对话

| Slot | kind / scope | 声明者 | 用途 |
|---|---|---|---|
| `main.conversation` | single / session-maybe | `dsh-client-ui-conversation` | 对话外壳 |
| `conversation.session` | single / session | 同上 | 严格 per-session 对话主体（owner: `{view?}`） |
| `conversation.header` | single / session-maybe | 同上 | 常驻导航头 |
| `conversation.session.header` | single / session | 同上 | per-session 标题/动作/View 导航（owner: `{hideChrome}`） |
| `conversation.session.header.lineage` / `.actions` / `.utilities` / `.corner` | single·list / session | 同上 | 面包屑替换 / 标题旁动作（list）/ 右对齐工具（list）/ 最右角单一控件 |
| `conversation.header.leading` | single / root | 同上 | 无会话也可用的全局导航 |
| **`conversation.view`** | **list / session** | 同上 | **注册一个「对话视图」页签**（owner: `{inspectCall, viewRequest, openView, completeViewRequest}`）。Trajectory 就是这么加标签页的；**自定义 transcript renderer 的正规入口** |
| `conversation.composer` | chain / session | 同上 | 用 `select` 选举**替换整个 composer**（owner: `{sessionId, session, pendingInteraction}`） |
| `conversation.hero.workspace` / `.brand.mark` / `.agentPreset` | single / root·session-maybe | 同上 | 空白会话 Hero 区 |
| `conversation.input.dock` | list / session | 同上 | composer 卡片上方整宽条目（owner: `InputZone`） |
| `conversation.input.overlay` | list / session | 同上 | composer 卡片内浮层 |
| `conversation.composer.dock` | list / session | 同上 | composer 卡片下方环境条目 |
| `conversation.input.left` / `.right` | list / session | 同上 | 工具行左/右紧凑控件 |
| `conversation.input.activity` | single / session | 同上 | 模型选择器之后的紧凑动作（可整行展开，owner 带 `onActiveChange`） |
| `conversation.composer.bar` | single / session-maybe | 同上 | 常驻 composer 主体（owner: `{variant:'hero'\|'composer', blocked?, disabled?, ...}`） |
| `conversation.input.attachments` | single / session-maybe | 同上 | 草稿附件栏 + drop target |
| `conversation.input.plan` / `.permission` / `.model` | single / session | 同上 | 三个具名控件位（owner: `{locked}`） |
| `conversation.content` | **Factory** / session-maybe | 同上 | 可复用对话内容组件（含局部 slot `views` / `widthControls`） |
| **`conversation.chat.node`** | **keyed / session** | `dsh-client-ui-chat` | **最终 Chat 节点渲染器**，key = `ChatNodeKind`，`keyProps` 提供 `{node: ChatNode<Kind>}`，`hookContext: ChatNodeHookContext`。**复用某个 key 即替换该种节点的渲染** → 自定义消息渲染器 |
| `conversation.message.images` | single / session | 同上 | 一组持久消息图片的渲染器（替换默认画廊） |
| `conversation.chat.commandview` | keyed / session | 同上 | 命令行的渲染器（key = 命令名） |
| `conversation.chat.turnTail` | list / session | 同上 | 一轮结束后、动作行之前的条目 |
| `conversation.chat.assistant-actions` | list / session | 同上 | 某条已定稿助手消息的动作 |
| `conversation.trajectory.images` | single / session | `dsh-client-ui-trajectory` | Trajectory 记录表里的图片渲染器 |
| `conversation.approval.detail` | — | `dsh-client-ui-approval` | 审批详情 |
| `conversation.plan-review.actions` | — | `dsh-client-ui-user-questions` | 计划评审动作 |
| `plan-review` | — | `dsh-client-ui-plan` | 计划评审 |

#### 工具调用渲染

| Slot | kind / scope | 声明者 | 用途 |
|---|---|---|---|
| `tool.call.toolview` | — | `dsh-client-ui-tool` | 按工具名分派的工具调用视图（自定义工具渲染入口） |
| `tool.call.images` | — | 同上 | 工具调用图片 |
| `tool.view.cordis` | — | `dsh-client-ui-cordis` | Cordis 动态包的工具视图 |
| `deliverables.file.actions` / `deliverables.review.file.actions` | — | `dsh-client-ui-deliverables` | 交付物文件动作 |

> 另有若干**包私有 child slot**（只有声明方渲染，如 `sidebar.right.tab.files.actions`、`sidebar.right.tab.document.*`、`sidebar.right.tab.document.office.pdf`）；关闭来源包即随之消失。

### 3.3 「桌面宠物」浮层 → `shell.overlay`（[已验证]，明确的官方建议）

`dsh-client-ui-layout/lib/types/client/index.d.ts:75-88` 的原文：

> *"Frame-wide floating layer, above every column and outside their scroll containers. Deliberately generic and unowned by any feature: a badge, a toast stack or a status pill all belong here, and entries order among themselves. The layer itself is click-through — entries opt back into pointer events — so an occupant never blocks the app underneath. This is the additive seat for a frame-wide surface of your own: a fresh `id` is added beside the shipped entries instead of replacing them."*

配合 `registry.d.ts` 的 *"For a surface of your own that floats over the whole app, register into `shell.overlay` instead"*，这是**唯一官方指定的全应用浮层席位**。dshmarket 就在此注册安装后 Toast（`src/client/index.ts:284-288`）。**实现注意**：父层 click-through，宠物容器需自己 `style={{ pointerEvents: 'auto' }}` 或等价的 CSS opt-in `[推断，来自「entries opt back into pointer events」的语义]`；`position: fixed` + 高 `z-index` 由使用方负责 `[推断]`（slot 注释只说「above every column」，未给出具体 z-index）。

### 3.4 自定义 transcript renderer

两条路（都 [已验证]）：

1. **新视图页签**（推荐，非侵入）：注册 `conversation.view`（list/session），得到一个与 Chat 并列的标签页。Trajectory 的实现即此；组件通过 `SessionStandardProps` 的 `useTrajectory` / `useConversation` / `useChat` 拿到数据。
2. **替换某类消息节点**：注册 `conversation.chat.node`（keyed/session），key 取 `ChatNodeKind` 之一，即可接管该 kind 的渲染（注释：*"Reusing a key replaces that node renderer; a kind with no occupant renders no row."*）。

**`ChatNodeKind` 的完整取值**（`ChatNodeKind = Extract<keyof ChatNodeDataMap, string>`，`ChatNodeDataMap` 由各业务包 `declare module` 合并；下表 [已验证]，来自各 `conversation-nodes/*.d.ts` 与 `dsh-client-ui-{goal,plan,workflow-run,user-questions}`）：

| key | 载荷 | 说明 |
|---|---|---|
| `assistant-step` | `AssistantChatData` | 流式中/已定稿/被中断的助手步骤（`status: 'running'\|'settled'\|'interrupted'`）——**流式增量就在这种节点里** |
| `user` | `ReferencedUserMessageNode` | 开启一轮的普通用户消息 |
| `steering` | `ReferencedSteeringMessageNode` | 活动轮中被接纳的用户消息 |
| `context` | `ContextMessageNode` | 注入模型历史的非用户上下文 |
| `turn-trigger` | `ContextMessageNode` | 非人类输入开启的轮 |
| `command` | `CommandNode` | 普通斜杠命令生命周期 |
| `manual-compaction` | `ManualCompactionChatData` | 手动 compact 命令 + 其事务 |
| `compaction` | `CompactionSummaryNode` | 自动压缩检查点标记 |
| `tool-call` | `ToolChatData` | 根工具生命周期（递归子调用） |
| `model-retry` | `RetryChatData` | 模型重试链 |
| `turn-process` | `TurnProcessChatData` | 轮级折叠（答案前的过程行） |
| `turn-tail` | `TurnTailChatData` | 完成轮的动作与扩展尾 |
| `turn-error` / `turn-max-tokens` | `TurnErrorNode` / `TurnMaxTokensNode` | 轮终止原因 |
| `system-prompt` | `{text, update?}` | 某次请求的完整 system prompt |
| `unknown` | `UnknownSurfaceNode` | 未被认领的 append-surface 事件的通用呈现 |
| `command-input`（goal）/ `submitted-plan`（plan）/ `workflow-run` / `question-reply` | 各自包 | 由对应业务包合并进来 |

对应组件 props 别名：`ChatNodeViewProps<Kind> = PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'chat'>`（`dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:163`），owner 为 `ChatNodeOwnerProps`，业务面为 `ChatNodeInjected`，per-occurrence 上下文为 `ChatNodeHookContext`。

---

## 4. Host 服务与客户端可调用的 RPC

### 4.1 注册 Host 服务（同进程，Cordis DI）

- **方式 A（简单值）**：`ctx.provide(name, value)` —— 客户端 `dsh-client-ui-theme/lib/client.js:1582` 用它注册 `theme`；`dshmarket/src/client/index.ts:199` 用它注册 `market`（并做了 `typeof ctx.provide === 'function'` 的健壮性判断）。Host 侧同理可用（同一个 Cordis `Context`）`[已验证，客户端；Host 侧为同一 cordis API，推断]`。
- **方式 B（Service 子类）**：`class WebServer extends Service { static Config = z...; [Service.init]() {...} }`，Cordis 按类名把实例挂到 `ctx.webServer` `[已验证]`（`dsh-host-webserver/lib/types/index.d.ts:67`）。
- **服务声明合并**：类型层面在 `declare module '@deepseek-ai/cordis' { interface Context { theme: ThemeRuntime } }` 中声明（theme 客户端类型第 84-97 行），同时可声明 `interface Events`（如 `'theme/change'(snapshot)`）。
- **依赖注入**：插件导出 `inject: ["webServer","loader"]`，或用 `ctx.inject([...], child => ...)` 延迟注册（`dshmarket/src/index.ts:181`）。

### 4.2 Typert Remote（「类型化 RPC」）—— 现有官方机制

| 组件 | ctx key | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-api-gateway`（Host 入口） | `ctx.typertGateway` | `invoke()` 解析描述符、校验具名参数、调用业务方法；`stream()` 支持流；注册 `/api` 上的 trusted-host interceptor；拥有 `/api/remote.mux` WebSocket |
| `@deepseek-ai/dsh-api-gateway/client` | `ctx.remote` | `$mount()` 挂载生成的 Host-for-Client 贡献（每个 namespace 是 `remote.<ns>` 子 Service）；`$on()` 订阅转发的 Host 事件；`$stream()` 跨物理载体重连的单消费者流；`$host` 给出 `{home, isLoopback}` |
| `@deepseek-ai/dsh-typert-protocol` | — | `@Remote` / `@RemoteScope(key)` 装饰器 + `TypertRemoteService` 基类 + `bindTypertRemote()`；`RemoteStream<Out,In>`；`RemoteError`（`<domain>/<reason>` 码 + `RemoteErrorDetailsMap` 可合并扩展） |
| `@deepseek-ai/dsh-typert-registry` | `ctx.typert` | 存放运行时描述符与 provider（`.local` / `.lookups`） |
| `@deepseek-ai/dsh-client-connection` | `ctx.connection`（客户端） | 通用 RPC `ctx.connection.rpc.call('/api', endpoint, ...)`；精确 GET/HEAD/POST 路由表；浏览器鉴权（启动 token → 签名 cookie）与 Host/Origin 信任栅栏 |

Host 侧业务写法（协议 README 原文示例，`@deepseek-ai/dsh-typert-protocol/README.zh.md:34-45`）`[已验证]`：

```ts
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
export class GoalService extends TypertRemoteService {
  @Remote
  async create(agentId: string, objective: string): Promise<GoalResult> { ... }
}
```

**但这条路对第三方插件有硬门槛 `[已验证]`**：
- Client 侧 `ctx.remote.$mount()` 需要**生成产物**（`@deepseek-ai/dsh-api-remotes` 导入的 `/remote` 声明与严格 codec）；README 明说 *"contribution 挂载时，每个由 Client 供值的字段都必须具备生成的严格 codec"*、*"若要增加能力，必须显式导入相应的 `/remote` 值并在此组合中挂载"*。
- 存在 **SRC 模式回退**（源码启动、无 codegen）：*"SRC 模式是开发阶段的回退路径，适用于从未具备严格定义的端点；它解析简单参数名，并且只允许非查找参数使用可安全表示为 JSON 的值"*，但有诸多限制（不支持重载/解构/默认值/rest）。
- `dsh-api-remotes` 是**应用装配包**（BFF），其能力集合是**构建期显式导入固定的**，第三方无法在运行时往里面加 Remote。
- Host 侧可另有直连入口：`ctx.typertGateway.invoke()` 可直接调用（保留业务错误），不依赖浏览器。

**结论 `[推断，但有强证据]`：第三方插件不要指望用 Typert 新增类型化 Remote 方法，除非自建完整的 Typert 生成流水线（`@deepseek-ai/dsh-typert-*` 的 generator 未在本机安装列表中，属于 monorepo 构建工具）。**

### 4.3 **推荐做法（唯一被真实第三方插件验证的路径）：`webServer` 精确 HTTP 路由 + 同源 `fetch`**

Host 半（`dshmarket/src/index.ts:181`、`src/routes.ts:1605` 等 40+ 处）：

```ts
ctx.inject(['webServer', 'loader'], (hostCtx) => {
  hostCtx.effect?.(...)   // 或用 ctx.effect 包裹
  host.webServer.register({
    kind: 'exact',                       // 'exact' | 'prefix'
    path: '/dsh-desktop-pet/api/state',  // 绝对路径，无尾斜杠
    handler: (req, res) => { /* 自己拥有完整响应生命周期，可 SSE */ }
  })
})
```
`webServer.register(route): () => void`，`(kind, path)` 重复即抛错 `[已验证]`：`@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:30-45, 84-90`。

Client 半（`dshmarket/src/client/market-data.ts:30-34`）——**用 `document.baseURI` 做同源相对路径**，这样反向代理前缀挂载也能工作：

```ts
export function api(path: string): string {
  const relative = path.replace(/^\/+/, '')
  if (typeof document === 'undefined') return `/${relative}`
  return new URL(relative, document.baseURI).pathname
}
// 调用：fetch(api('/dsh-market/installed'), { cache: 'no-store' })
```

鉴权：浏览器 cookie（`HttpOnly`、`SameSite=Strict`、`Path=/`、host-only）由 `dsh-client-connection` 的 `authorizeIndex` 在 `GET /?token=...` 时写入，之后**同源 `fetch` 自动携带**；Host/Origin 信任栅栏（loopback 或 `trustedHosts`）在鉴权前执行 `[已验证]`。所以 Host 路由 handler 不必自己写鉴权。

**其他已存在的 Host 服务（可 `ctx.inject`/`ctx.get` 复用）** `[已验证，来自各包 package.json 与 README]`：`tools`、`sessionProjections`、`settings`/`configForms`、`storage`、`jobs`、`terminal`、`agents`、`loader`、`hmr`、`pluginManager`、`connection`、`credentials`、`shortcuts`(client)、`locale`(client)、`resources`(client)、`theme`(client)、`slots`(client)、`uiRenderer`(client)。

---

## 5. 客户端如何观察实时 agent trajectory

### 5.1 可用的数据服务/钩子

| 来源 | 形态 | 内容 |
|---|---|---|
| `useSession`（`SessionStandardProps`，`dsh-client-ui-session` 声明） | `SnapshotSelectorHook<SessionSnapshot>` | 当前会话生命周期与控制状态 |
| `useProjection`（同） | `UseProjection` | **Host 计算好的投影值，按 key 寻址**（如 `todos`、goal…）。这是「有限视图」最省事的来源：Host 侧 `ctx.sessionProjections.register({ key, stateSchema, init, apply, wire:{viewSchema, view} })`，客户端直接读 |
| `useConversation`（`dsh-client-ui-conversation` 声明） | `SnapshotSelectorHook<ConversationSnapshot>` | target-neutral 对话装配 |
| `useInput` / `inputActions` | — | 输入机状态与稳定动作 |
| `useChat`（`dsh-client-ui-chat` 声明） | `UseChat` | Chat target |
| **`useTrajectory`**（`dsh-client-ui-trajectory` 声明） | `SnapshotSelectorHook<TrajectorySnapshot>` | **按轮次组装好的事件记录**，含流式中间态 |
| `useSessions` / `useSessionStatus` / `useSessionRetainInfo`（`GlobalStandardProps`） | — | 会话列表、统一 UI 状态（`running`、`pendingInteraction`、`completionUnread`） |
| `ctx.remote.$on(event, listener)` | 事件订阅 | Host 转发的 Cordis 事件（合法键 = `API_REMOTE_FORWARDED_EVENTS` 名单） |

`TrajectorySnapshot` 的形状（`dsh-client-ui-trajectory/lib/types/client/trajectory-contract.d.ts:55-64`，[已验证]）：

```ts
export interface TrajectorySnapshot {
    readonly systemPrompts?: readonly SystemPromptNode[];
    readonly eventNodes: readonly ConversationNode[];
    readonly eventLocations: ReadonlyMap<number, ConversationLocation>;
    readonly requests: readonly RequestView[];
    readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>;
    readonly partial: PartialAssistant | null;        // ← 正在流式的助手消息
    readonly runningCalls: readonly RunningToolCall[]; // ← 正在跑的工具调用
}
```

即：**thinking delta / 消息 delta / tool call / tool result / turn 边界**都在 `eventNodes` + `partial` + `runningCalls` 里；`TrajectoryContribution` 的联合类型给出了细分种类（`'system-prompt' | 'node' | 'assistant' | 'tool' | 'request-header' | 'compaction' | 'session-end' | 'turn-end'`，`trajectory-contract.d.ts:12-46`）。

### 5.2 最小可用代码骨架（服务名/方法名均 [已验证]，整体装配 [推断]）

```tsx
// client/ 侧：注册一个只读「宠物视角」视图
export const inject = ['slots', 'locale']       // 需要 useTrajectory ⇒ session scope 由框架注入
function PetView(props) {                        // 注册进 conversation.view（scope: session）
  const traj = props.useTrajectory()             // ← StandardProps 自动注入
  const session = props.useSession()              // ← dsh-client-ui-session 提供
  return <div>{traj.partial?.text ?? (session.running ? '…' : 'idle')}</div>
}
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view', id: 'desktop-pet', order: 90, label: () => t('petView'),
  locale: NS, inject: () => ({ t })
}, PetView))
```

也可以不注册 slot，直接在 `apply` 里订阅 Host 转发事件（`ctx.remote.$on`）或轮询 `useSessionStatus` 的 `running`。

> 注意：`conversation.view` 的 owner props（`ConvViewOwnerProps`）不直接携带数据，数据来自 `SessionStandardProps` 的钩子；且 `dsh-client-ui-trajectory` README 明说它的视图是**纯投影**、*"既不读取也不改变 Chat 会话快照"* —— 想「有限视图」就应该同样只读。

### 5.3 `dsh-client-store`（客户端状态基座）

`@deepseek-ai/dsh-client-store` README `[已验证]`：
- 不依赖 React 的 observable / snapshot 原语：**同步与 animation-frame 发布**、基于 **Immer** 的更新、浅比较、可选 `localStorage` 持久化。
- React 钩子由 `dsh-client-ui-renderer` 通过 uSES（`useSyncExternalStore`）在渲染位置绑定 —— *"渲染器在 slot outlet 处把运行时的裸 observable source 绑定为 selector 钩子"*。
- Slot 层用 `defineStore({ init, actions })` 声明 store 席位（`store:` 选项），组件拿 `useStore(selector)` 与 baked actions；`@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts:12` 从 store 包导入 `BoundActions/HandleOf/PropsStore/SnapshotSelectorHook/StoreDecl`。

---

## 6. 安装、加载与 patch 语义

### 6.1 profile 组合模型（`dsh/README.zh.md:37-50`，[已验证]）

配置树**以空根为起点**（`profile/cordis.yml` 内容就是 `[]`），依次叠加：

1. `dsh.profile.bundles` 中各组合包的 `dsh.bundle.patch`（**按列表顺序**）
2. profile 自身的 `profile/cordis.patch.yml`
3. **home 级 `$DSH_HOME/cordis.patch.yml`**（本机全局偏好，**优先级高于 per-profile 层**）
4. `--patch <file>` 覆盖层（可重复，按 argv 顺序，最后应用）

> 注：`dsh/README.zh.md` 的第 43 行把 home 层写在 profile 层之后（即更晚应用 = 更高优先级）；`dsh/lib/profile-boot-BZ2ZjNWi.js:196-197` 的 JSDoc 明确 *"the home-level user patch layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply to every profile, so it outranks the per-profile layer)"*。以代码注释为准。

`dsh.profile.bundles` 的解析顺序：**先从 dsh 安装目录**（`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`），**再从 profile 自己的 `node_modules`**（pnpm 把树外插件装在这里）。

**当前 `profile/package.json` 实测**：
```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dshmarket": "^1.66.5" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket"],
      "patchReload": "live"
    }
  }
}
```
`dshmarket` 作为**第三方 bundle** 出现在 bundles 列表里 —— 这就是目标形态。

### 6.2 patch 语义（`@deepseek-ai/cordis-plugin-include/lib/index.js:56-105`，[已验证]）

顶层 YAML 数组，每项是一条 patch entry：

```js
for (const patch of patches) {
  const { id, insert, name, ...overrides } = patch;
  if (insert) {
    if (id) {                       // 插到某个 group 里
      const target = entryMap.get(id);
      if (!target) { warn("patch insert: entry %C not found", id); continue; }
      if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
      if (!Array.isArray(target.config)) target.config = [];
      target.config.push(...insert);
    } else data.push(...insert);    // 追加到顶层
    buildMap(insert);               // 同一次 patch 列表里，后续 patch 可以命中刚插入的行
    continue;
  }
  if (!id) { warn("patch: id is required for non-insert patches"); continue; }
  const target = entryMap.get(id);
  if (!target) { warn("patch: entry %C not found", id); continue; }
  if (name && name !== target.name) { warn("patch: name mismatch for %C ..."); continue; }
  for (const [key, value] of Object.entries(overrides)) { if (key === 'id') continue; target[key] = value; }
}
```

要点：
- **`id` 定向覆盖**：patch 项的其余键（`name`、`config`、`disabled`、`inject`…）**整键替换**目标 entry 的同名键（不是深合并）。
- **`insert:` 无 `id`** → 追加到顶层条目列表；**`insert:` 带 `id`** → push 进该 group 的 `config` 数组（要求目标 `group: true`）。
- **patching 共享对象会被 clone**（`structuredClone`）→ 反复应用可回退。
- **命中不到只 warn 并跳过**，不会让启动失败。
- 顶层必须是数组，否则 `throw new TypeError("config file must be a top-level array of entries")`。
- 支持 `.yml` / `.yaml` / `.json` / `.js`(动态 import) —— 由扩展名决定。

**`!!js` 表达式支持**（同文件 15-29 行，[已验证]）：

```js
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
	kind: "scalar",
	resolve: (data) => typeof data === "string",
	construct: (data) => ({ __jsExpr: data }),
	predicate: isJsExpr,
	represent: (data) => data["__jsExpr"]
});
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
```

即 `!!js` 标量被解析成 `{ __jsExpr: "<源码字符串>" }` 节点，**由 Loader 在该 entry 激活时求值**；`dsh --dump-config` 用同一 schema 解析与打印，保证 dump 与启动不漂移。（注意 schema 是 `JSON_SCHEMA` 扩展，不是 `DEFAULT_SCHEMA`。）

### 6.3 `dsh plugin --profile <name> <pnpm args>` 的确切行为

CLI 入口：`dsh/lib/bin.js:116-127` —— `dsh plugin` 是 commander 子命令，`requiredOption("--profile <name>")`，其余参数**原样转发给 pnpm**，`args.length === 0` 时报错 `"plugin needs pnpm arguments to forward (e.g. add <package>)"`。

实现：`dsh/lib/plugin-BGnVfe_D.js`（本机文件名是 `plugin-BGnVfe_D.js`；任务描述里的 `plugin-DkYIj96-.js` 是**另一个构建 hash**，本机不存在 `[已验证]`）：

1. `desktop` profile 有专属限制（必须先被 Desktop 初始化）。
2. **先解析 DSH 自有命令**：`version-exemptions` / `allow-version` / `revoke-version`（见 §7）。
3. 否则走 `runPluginCommand(context, args, options)`（来自 `@deepseek-ai/dsh-plugin-manager/operations`）。
4. 包管理器环境由安装包提供（`installation-owned executable`），`execution: "cli"`（**继承终端与认证环境、不捕获输出**，带交互式构建批准能力；service 路径则是清理环境 + 捕获输出）。
5. 退出码 127 → 提示 `pnpm was not found; install pnpm and make it available on PATH.`
6. 不兼容 → 打印精确的 `allow-version` 命令。
7. 失败且参数里有 git 地址 → 提示把 pnpm 打印的 key 加到 `profile/pnpm-workspace.yaml` 的 `allowBuilds`（**git 插件靠 `prepare` 脚本构建，pnpm 默认拦**）。

安装后的 key 步骤（`dsh-plugin-manager/lib/types/operations.js` + `lib/index.js:238-266`）：

- 具名安装（`add` / 带 spec 的 `install`）**先做兼容性预检**（本地路径直接读 `package.json`；registry spec 先 `pnpm view` 查版本与 peer）→ 不兼容则**在 pnpm 之前失败**，什么都不会下载、不会跑构建脚本。
- pnpm 成功后，`reconcile(before, dir, anchor, options)` 把**新出现的依赖**里声明了 `dsh.bundle` 的包**自动追加到 `dsh.profile.bundles`**（默认 `activateNewBundles !== false`）；不想加就显式传 `activateNewBundles: false`。
- 若新依赖**没有** `dsh.bundle` → 打印 `dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会被启用**。
- 失败/取消的安装会**恢复 `package.json` 与 `pnpm-lock.yaml` 快照**；`pnpm-workspace.yaml`（pnpm 记录 pending builds 的地方）**故意不恢复**。
- 卸载顺序：从 `dsh.profile.bundles` 移除 → 卸载运行时贡献 → `pnpm remove`。

### 6.4 本地开发插件怎么加进 profile

```powershell
# 1) 装进 web profile（会把包链接/复制到 profile\node_modules，并在其声明 dsh.bundle 时自动入 bundles）
dsh plugin --profile web add file:C:\Users\WANGZ\Documents\GitHub\dsh-app\dsh-desktop-pet
#    pnpm 的 link: 协议（不复制、纯符号链接，适合反复改）
dsh plugin --profile web add link:C:\Users\WANGZ\Documents\GitHub\dsh-app\dsh-desktop-pet

# 2) 校验组合结果（不启动）
dsh --profile web --dump-config            # 带用户层 + --patch
dsh --profile web --dump-default-config    # 不带用户层（cordis.patch.yml 坏掉时的恢复诊断）

# 3) 启动
dsh web
# 或临时加一层覆盖（不改 profile 文件）
dsh --profile web --patch .\dev.patch.yml
```

`file:` 与 `link:` 在 pnpm 下对**目录依赖**都是软链（`link:` 更明确地强制符号链接）`[推断，pnpm 通用语义]`；无论哪种，改完插件必须**重新构建** `lib/client.js`（client bundle 是已构建产物，Host 只提供不编译）。

**让插件生效的两条等价路径**：

- **路径 A（推荐、可发布）**：插件自己带 `dsh.bundle.patch`，`cordis.patch.yml` 里写 `insert` 行；`dsh plugin add` 自动把它加进 `dsh.profile.bundles`。
  ```yaml
  # dsh-desktop-pet/cordis.patch.yml
  - insert:
      - id: desktop-pet
        name: dsh-desktop-pet
        config:
          petName: Boba
  ```
- **路径 B（纯本地、不发布）**：不声明 `dsh.bundle`，直接在 `profile/cordis.patch.yml` 插入行（甚至可 `file:` 装依赖后手写绝对路径的 `name`）：
  ```yaml
  - insert:
      - id: desktop-pet
        name: dsh-desktop-pet
  ```
  dshmarket 用的就是路径 A（其 `cordis.patch.yml` 全文只有 4 行：一个 `insert` + `id: dsh-market` + `name: 'dshmarket'`）。

**注意**：HMR（`dsh-hmr`）在 YAML 中启用时才会监视 profile manifest 与 patch 文件并热重组；否则改动**重启后生效**。本 profile 的 `patchReload: "live"` 字段在任何已安装 JS 中都 grep 不到 `[未验证]` —— 实际起作用的是 `dsh-hmr` 条目本身（`@deepseek-ai/dsh-client-hmr` 的 Host 半 + `@deepseek-ai/dsh-hmr` 的配置 HMR）。

---

## 7. 版本兼容性检查

### 7.1 安装时 / 启动时的 peer 检查（`@deepseek-ai/dsh-app-boot/lib/index.js:286-313`，[已验证]）

```js
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) {
  const fields = objectOf$1(manifest, "Plugin manifest");
  if (!Object.hasOwn(fields, "peerDependencies")) return void 0;
  const dependencies = objectOf$1(fields.peerDependencies, "Plugin manifest peerDependencies");
  const peers = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== "string") throw new Error(...);
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;   // ← 只看 DSH 自己的 peer
    const requirement = ["workspace:^","workspace:~","workspace:*"].includes(range) ? runtimeVersion : range;
    if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
  }
  if (Object.keys(peers).length === 0) return void 0;
  ...
  return { name, version, runtimeVersion, peers, exempted: ... };
}
```

关键点：
- **只检查 `peerDependencies` 中名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的项**。`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`dsh-settings`… 中只有 `@deepseek-ai/dsh-settings`（前缀匹配）参与检查。
- **`dshmarket` 因此完全没有被检查**：它的 `peerDependencies` 是 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-settings`(optional) / `@deepseek-ai/schemastery`(optional) —— 只有 `@deepseek-ai/dsh-settings` 命中前缀，而 `^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1` 相对 runtime 版本 `0.1.7-rc.2`… 该 range 不含 `0.1.7`，**理论上会被判为 incompatible** `[推断：需要实际解析才能定论，可能存在豁免或 semver 预发布语义差异——见文末]`。
- 判定用 `includePrerelease: true`；`workspace:^` / `workspace:~` / `workspace:*` 被当作「等于当前运行时」。
- 不兼容时抛/打印的文案见 `pluginCompatibilityWarning`（`index.js:320-323`），提示用 `dsh plugin allow-version` 授予**精确版本**豁免。
- `dsh-package-manifest` README 明确：**`dsh.manifestVersion` 与 `engines.dsh` 都是「声明式」的，当前安装器与加载器不强制**（*"Compatibility is declarative. Current installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`."*）。

### 7.2 豁免机制

- 存放位置：**profile 目录下的 `compatibility.json`**（与 `package.json`、`cordis.patch.yml` 并列），把精确的 `package-name@version` 映射到精确 DSH 运行时版本列表（`PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"`，`app-boot/lib/index.js:328`）。当前 `profile/` 下**不存在**该文件 `[已验证]`。
- CLI：
  ```
  dsh plugin --profile web version-exemptions
  dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk
  dsh plugin --profile web revoke-version <pkg>@<ver> --dsh-version <exact>
  ```
  `allow-version` 会在保存前打印风险警告（`plugin-BGnVfe_D.js:36`），且与 `package.json` 共用文件锁（`withFileLock(..., { waitMs: 120000 })`）。
- 授权**不继承**：插件升级、DSH 升级都会失效，必须为**精确版本对**重新授权。`plugin_manager` 工具用 `list_version_exemptions` / `set_version_exemption`（需 `acceptRisk: true`）。
- 兼容性拒绝带 `incompatible-version` 错误码，携带每个被拒包的 `name` / `version` / `runtimeVersion` / 未满足的 `peers`。
- 重要：**版本豁免不授权依赖构建脚本**（§6.3 的 `allowBuilds` 是另一套）。

### 7.3 本地开发插件应该声明什么

- **想完全避开版本闸门**：不要声明任何 `@deepseek-ai/dsh*` 的 `peerDependencies`。只声明 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 这类不匹配前缀的（**注意 `@deepseek-ai/dsh-settings` 会命中 `@deepseek-ai/dsh-` 前缀！**）。
- **想显式声明兼容**：`"peerDependencies": { "@deepseek-ai/dsh": "0.1.7-rc.2" }` 或用 includePrerelease 友好的范围。
- `engines.dsh` 可写但**不强制**，仅作文档。
- 建议同时保留 `peerDependenciesMeta` 的 `optional: true`（dshmarket 对 `dsh-settings`/`schemastery` 就这么做），并注意 profile 的 `pnpm-workspace.yaml` 里 **`autoInstallPeers: false`**（实测），即 peer 不会自动装。

---

## 8. 客户端构建工具链

### 8.1 `"bundle": "tsdown"` 意味着什么

`"scripts": { "bundle": "tsdown", "watch": "tsdown --watch" }` 出现在几乎所有 client 包（如 `dsh-client-ui-theme/package.json`）。含义 `[已验证/推断混合]`：

- **tsdown**（rolldown 系打包器）负责把 `src/client/**` 打成**单个** `lib/client.js`，格式是 §1.3 的 `window.__ModuleLoader__.load({ id, factory })` CJS-factory 包裹。
- `lib/types/**/*.d.ts` 由 `tsc` 产出（`"types": "lib/types/index.d.ts"`，`files` 里也带 `lib/types/**/*.d.ts`）。
- dshmarket 的实际构建脚本是 `"build": "tsc -p tsconfig.json && npm run build:client"`，`"build:client": "tsdown && node scripts/normalize-client-banner.mjs"` `[已验证]` —— **`normalize-client-banner.mjs` 说明 `__ModuleLoader__` 包裹的 banner 需要后处理规范化**，即 tsdown 输出后要保证 `id` 与 factory 头正确。
- **共享预设**：`dsh-client-hmr` README 提到 *"使用共享 Client tsdown 预设的任何 watch 进程"*、*"该预设会在所有包内 chunk 写完后标记 `lib/client.js`"* —— 该预设是 **monorepo 内部工具，未随 npm 发布**（本机 `node_modules` 下 grep 不到 `tsdown.config.*` 或 `clientBundle` 之外的实现；`dsh-client-modules/lib/index.js` 里只有一处 `clientBundle` 相关字符串）`[已验证：预设文件不存在于本机安装]`。**第三方必须自备 tsdown 配置。**

### 8.2 产物的硬性形状要求（[已验证]）

1. **必须是** `window.__ModuleLoader__.load({ id: "<npm 包名>", factory: (require) => { ...; return module.exports } })`。`id` 必须**等于包的 npm 名**（`dsh-client-modules` README：*"解析出的 manifest 包名作为浏览器模块身份"*；重名会让组合失败）。
2. **ESM 源码 → 单个自包含 factory**。允许 tsdown 拆 chunk（编译成 `require.async("./client.<name>.js")`），但 README 明确限制：*"该协议只支持自包含 chunk：入口与 chunk 产物不能同步 require 另一个相对 `client*.js` 产物。"*
3. **external 规则**：
   - **基座（自动 external，不需要声明）**：`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`…（由外壳的冻结模块表提供）。`[已验证 by 实证]`：theme 与 dshmarket 的 `require(...)` 列表含这些，而 `dsh.client.external` 为空。
   - **其他 DSH 包**：想 `require("@deepseek-ai/dsh-client-locale")` 必须写进 `dsh.client.external`（例：`dsh-api-gateway` 声明 `["@deepseek-ai/dsh-api-gateway/client"]`）。**类型 import 会被擦除，不产生请求。**
   - **第三方库**（clsx、js-yaml…）：要么 inline 打进 bundle（theme 就把 clsx inline 了），要么同样列进 `external` 并确保基座/其他 bundle 提供它。
   - 组合阶段**会拒绝**：畸形请求、缺失提供方、自请求、同步请求环。
4. **CSS**：theme 的做法是 `tsdown` 把 CSS 模块转成字符串常量，然后 package 自己在模块体里 `document.head.appendChild(<style data-plugin-css=...>)` `[已验证]`（`theme/lib/client.js:26-41, 1013-1021`）。没有 bundler 级的 CSS 注入约定。
5. **旧 Host 兼容**：dshmarket 运行时检查 `@deepseek-ai/dsh-client-ui-primitives` 的具名导出是否存在（`REQUIRED_PRIMITIVES = ['Menu','DisclosureRow','Tooltip','Toast']`），缺失就 `console.warn` 并**不注册**而不是渲染崩溃 `[已验证]` —— 第三方插件的良好实践。

### 8.3 参考构建配置（[推断]，基于 dshmarket 的 `scripts` 与产物形状）

```ts
// tsdown.config.ts
export default defineConfig({
  entry: ['src/index.ts', 'src/client/index.tsx'],
  format: ['esm'],
  platform: 'neutral',
  dts: false,                       // .d.ts 交给 tsc
  clean: false,
  external: [
    'react', 'react-dom', 'react/jsx-runtime',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  // client 入口需产出 __ModuleLoader__ 包裹的 lib/client.js（dshmarket 用
  // scripts/normalize-client-banner.mjs 后处理该 banner）
})
```
**建议**：直接以 `dshmarket` 的发布产物为模板，用自写的 banner 插件（`output.banner` / `renderChunk`）产出
`window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {` … `return module.exports } })`。

---

## 9. `dshmarket` 案例研究（最佳模板）

### 9.1 身份与结构

- 包名 `dshmarket`（**非 scope**，与 `profile/package.json` 的依赖名、`cordis.patch.yml` 的 `name:`、`dsh.profile.bundles` 里的名字完全一致）。v1.66.5，MIT，仓库 `github.com/dsh-market/dsh-market`。
- 文件（安装目录 `profile/node_modules/dshmarket`）：

```
package.json
cordis.patch.yml          # 4 行：insert 一个 id: dsh-market / name: dshmarket 的行
README.md  README.zh.md  UPDATE-API-V1.md  LICENSE
lib/index.js              # Host 半（打包产物）
lib/*.js                  # Host 各模块（accelerate/backup/check/install/patch/profile/routes/…共 46 个）
lib/types/**/*.d.ts
client/client.js          # ★ Client bundle（已构建，~14000 行，__ModuleLoader__ 包裹）
locale/en.json locale/zh.json
src/**                    # ★ 源码随包发布（tsdown 之前的 TS/TSX）
  ├─ index.ts             # Host 入口（309 行）
  ├─ routes.ts            # 5573 行：40+ 个 webServer.register({kind:'exact', path:'/dsh-market/...'})
  └─ client/              # index.ts, MarketSection.tsx(6571), locales.ts(1347), market-data.ts(1500), …
```

### 9.2 `package.json` 关键字段

```json
{
  "name": "dshmarket", "version": "1.66.5", "type": "module",
  "main": "lib/index.js", "types": "lib/types/index.d.ts",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale",
                 "@deepseek-ai/dsh-client-ui-settings",
                 "@deepseek-ai/dsh-client-ui-theme"],
      "platform": "web"
    }
  },
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./update-api-v1": { ... },
    "./client": "./client/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-settings": "^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "peerDependenciesMeta": { "@deepseek-ai/dsh-settings": {"optional":true}, "@deepseek-ai/schemastery": {"optional":true} },
  "dependencies": { "js-yaml": "^4.1.0", "undici": "^7.29.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json && npm run build:client",
    "build:client": "tsdown && node scripts/normalize-client-banner.mjs",
    "prepack": "npm run build && node scripts/preflight.mjs",
    "prepare": "npm run build"
  },
  "files": ["locale","lib","src","client","UPDATE-API-V1.md","cordis.patch.yml","LICENSE"]
}
```

注意：**`exports["./client"]` 指向 `./client/client.js`（不是 `lib/client.js`）** —— 说明 client 出口路径由 `exports` 决定，不限定 `lib/`。而 `dsh-client-modules` 的 README 里以 `lib/client.js` 为惯例举例。

### 9.3 它如何 patch UI（`src/client/index.ts`）

| 目标 | 位置 | 说明 |
|---|---|---|
| 设置页 | `settings.section`，`id:'market', order:40, label: () => t('nav')` | 一个完整的 Market 设置页 |
| Plugins 区 Tab | `settings.plugins.tab`，`id:NS, order:60` | 0.1.7 线的新席位（旧线用 `settings.plugin.item`，通过**嵌套 `ctx.inject(['settingsScope'], ...)` 探测**；0.1.7 把该服务改名为 `settings`，所以嵌套 inject 不再触发） |
| bundle 配置卡 | `plugins.bundle.config`，`key: 'dshmarket'` | 「bundle 自己的配置按 bundle 包名 keyed」 |
| **浮层 toast** | **`shell.overlay`**，`id:'dsh-market-toast'` | **安装后 Toast —— 桌面宠物可照抄的位置** |
| 侧栏 nav 图标 | `installSettingsNavIcon(ctx, () => t('nav'))` | 自注入 `<style data-plugin-css>` 换图标 |
| 客户端服务 | `ctx.provide('market', marketControl)` | 宿主可用它控制/渲染市场面板 |
| locale | `ctx.effect(() => ctx.locale.register('dsh-market', { zh, en }))` | 自己的文案命名空间 |

**版本自适应模式（极重要）**：不比较版本号，而是**用 `ctx.slots.inject(slot, cb)` 探测 slot 是否存在** —— 老 Host 从不声明该 slot，回调就永不运行。dshmarket 源码注释反复强调这一点（*"Detection is the slot itself, as everywhere else here"*）。

### 9.4 它如何加 Host API

`src/index.ts:181` → `ctx.inject(['webServer','loader'], (hostCtx) => ...)`，然后在 `routes.ts` 里 **40+ 次** `host.webServer.register({ kind:'exact', path:'/dsh-market/<name>', handler })`；Client 用 `fetch(api('/dsh-market/installed'), { cache:'no-store' })` 调用（同源、cookie 自动带上）。另有 `/dsh-market/api/v1/*` 版本化 JSON 接口（`update-api-v1.ts`）。

**没有使用 Typert Remote** —— 这就是第三方插件绕开 codegen 的现实答案。

### 9.5 值得抄的工程细节

- 类型自持：`MarketClientContext` / `SlotsService` / `LocaleService` / `ThemeService` 都是**结构化接口**（*"typing the touched surface keeps this external package free of monorepo-internal type dependencies"*）；只对确实要用的服务面写最小类型。
- 宿主能力缺失降级：`missingPrimitives()` + `typeof ctx.provide === 'function'` 判断 + `slots.register` 可能不返回 disposer 时的兜底。
- `ErrorBoundary`、`section-gate.ts`（区分「宿主不想显示」与「包正在被卸载」的次序问题）。
- 大量测试与 `prepack` 预检脚本。

---

## 10. 最小可用「Hello World」插件骨架（Host + Client）

> 以下每一行都来自 §1–§8 中 `[已验证]` 的事实；tsdown 配置部分是 `[推断]`。目标：往 GUI 加一个浮层「桌面宠物」，并提供一个 Host 侧 HTTP 接口（顺便加一个 Host 工具）。

### 10.1 文件树

```
dsh-desktop-pet/
├─ package.json                 # dsh.bundle.patch + dsh.client.platform
├─ cordis.patch.yml             # insert 一行 loader entry
├─ tsconfig.json                # 产出 lib/types/**
├─ tsconfig.client.json         # client face（可合并）
├─ tsdown.config.ts             # 产出 lib/index.js 与 lib/client.js
├─ README.md / LICENSE (MIT)
├─ src/
│  ├─ index.ts                  # ★ Host 半：name/inject/Config/apply + webServer 路由 + tools.register
│  └─ client/
│     ├─ index.tsx              # ★ Client 半：name/inject/apply → 注册 shell.overlay
│     └─ PetOverlay.tsx         # 浮层组件（固定定位 + pointerEvents:'auto'）
└─ lib/                         # 构建产物（必须提交/发布）
   ├─ index.js
   ├─ client.js                 # window.__ModuleLoader__.load({ id:'dsh-desktop-pet', factory })
   └─ types/index.d.ts, types/client/index.d.ts
```

### 10.2 `package.json`

```json
{
  "name": "dsh-desktop-pet",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "license": "MIT",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-locale"
      ],
      "external": []
    }
  },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.1" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.4" },
  "scripts": { "build": "tsc -p tsconfig.json && tsdown", "bundle": "tsdown", "watch": "tsdown --watch" },
  "files": ["lib", "src", "cordis.patch.yml", "LICENSE"]
}
```
要点：`peerDependencies` **刻意不含任何 `@deepseek-ai/dsh*`** → 绕过 §7.1 的版本闸门；`external: []`（只用基座模块）；`exports["./client"]` 是 client bundle 的发现点。

### 10.3 `cordis.patch.yml`

```yaml
# dsh bundle patch: inserts this plugin into a profile's layer stack.
- insert:
    - id: desktop-pet
      name: dsh-desktop-pet
      config:
        petName: Boba
        enabled: true
```

### 10.4 Host 半 `src/index.ts`

```ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'desktop-pet'
export const inject = ['webServer']                      // Cordis 服务名

export interface Config { petName: string; enabled: boolean }
export const Config = z.object({
  petName: z.string().default('Boba'),
  enabled: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return

  // 1) 一个同进程 Host 服务（可选，客户端拿不到它，它是给其他 Host 插件用的）
  ctx.provide('desktopPet', {
    name: config.petName,
    mood: () => 'happy',
  })

  // 2) 给浏览器用的 HTTP 接口（§4.3 的推荐路径）
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: '/dsh-desktop-pet/api/state',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ name: config.petName, mood: 'happy' }))
      },
    }))
  })
}
```

### 10.5 Client 半 `src/client/index.tsx` + `PetOverlay.tsx`

```tsx
// src/client/index.tsx
import { createElement as h } from 'react'
import { PetOverlay } from './PetOverlay.tsx'

export const name = 'desktop-pet'
export const inject = ['slots']                 // 客户端 Cordis 服务名

export function apply(ctx: {
  slots: { inject(slot: string, register: () => unknown): void
           register(options: Record<string, unknown>, component: () => unknown): unknown }
  effect(cb: () => unknown, label?: string): void
}): void {
  // 版本自适应：老宿主不声明 shell.overlay 时回调永不运行
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'desktop-pet',
    order: 100,
    label: () => 'desktop-pet',
  }, PetOverlay))
}
```

```tsx
// src/client/PetOverlay.tsx
import { useEffect, useState } from 'react'

export function PetOverlay() {
  const [mood, setMood] = useState('…')
  useEffect(() => {
    let alive = true
    const timer = setInterval(() => {
      fetch(new URL('dsh-desktop-pet/api/state', document.baseURI).pathname)
        .then(r => r.json())
        .then(v => { if (alive) setMood(v.mood) })
        .catch(() => { if (alive) setMood('offline') })
    }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  // 父层是 click-through：容器必须自己 opt in pointer events
  return (
    <div style={{ position: 'fixed', right: 24, bottom: 24, pointerEvents: 'auto', zIndex: 1000 }}>
      🐾 {mood}
    </div>
  )
}
```

> `shell.overlay` 的父层是 click-through，`pointerEvents: 'auto'` 是让宠物可交互的必需 opt-in；`position/z-index` 的**具体值未在任何文档中规定** `[推断]`，实测时可能需要调整（也可能被父层 `transform`/`overflow` 影响 `[未验证]`）。

### 10.6 若要加 Host 工具（模型可见）

```ts
export const inject = ['webServer', 'tools']            // 加 'tools'
// apply 内：
ctx.inject(['tools'], (scoped) => {
  scoped.tools.register(defineTool({                    // defineTool 来自 @deepseek-ai/dsh-tools
    name: 'pet_status',
    description: 'Report the desktop pet state.',
    parameters: {},
    output: { schema: { type: 'object', properties: { mood: { type: 'string' } }, required: ['mood'] } },
    execute: async () => ({ mood: 'happy' }),
  }))
})
```
（`defineTool` 的形状照抄 `@deepseek-ai/dsh-tool-todo/lib/index.js:95-121`；`execute` 字段名未在该片段中出现 `[未验证]`。）

---

## 11. 扩展点总表

### 11.1 客户端 slot（按用途）

| 目标 | Slot | kind / scope | 备注 |
|---|---|---|---|
| **全应用浮层 / 桌面宠物 / toast** | `shell.overlay` | list / root | click-through 层，条目自 opt-in pointer events |
| 窗口左上 chrome | `shell.leading` | single / root | 仅左列全隐藏时挂载 |
| 设置整页 | `settings.section` | list / root | `id`/`order`/`label` |
| 设置里的单行 | `settings.general.item` | list / root | 无 owner props，自画 label + 写路径 |
| Plugins 区 Tab | `settings.plugins.tab` | list / root | 0.1.7+ |
| 第三方 bundle 配置卡 | `plugins.bundle.config` | keyed / root | key = bundle 包名 |
| 侧栏（整列替换） | `sidebar` | single / root | 会**替换**导航列，慎用 |
| 侧栏内部席位 | `sidebar.settings` / `sidebar.panellist` / `sidebar.footer.action` / `sidebar.toggle.badge` / `sidebar.brand.*` | — | `ui-sidebar` 声明 |
| 右栏新 Tab | `sidebar.right.pane.tab` (+`.title`) | keyed / session | key = tab type id |
| **对话新视图（自定义 transcript）** | `conversation.view` | list / session | Trajectory 用这个 |
| **替换某类消息渲染** | `conversation.chat.node` | keyed / session | key = `ChatNodeKind` |
| composer 工具行控件 | `conversation.input.left` / `.right` / `.plan` / `.permission` / `.model` / `.activity` | list·single / session | |
| composer 上方/下方条目 | `conversation.input.dock` / `conversation.composer.dock` | list / session | |
| 整卡替换 composer | `conversation.composer` | chain / session | 需 `select` |
| 会话头动作/工具/角标 | `conversation.session.header.actions` / `.utilities` / `.corner` / `.lineage` | list·single / session | |
| 工具调用自定义渲染 | `tool.call.toolview` | — | `ui-tool` 声明 |
| 消息图片渲染 | `conversation.message.images` | single / session | |
| 多轮结束附加项 | `conversation.chat.turnTail` | list / session | |
| 助手消息动作 | `conversation.chat.assistant-actions` | list / session | |
| 根 | `root` | single / root | **禁止注册** |

### 11.2 Host 服务名（`inject` / `ctx.get`）

`tools`、`sessionProjections`、`webServer`（→ `register/registerUpgrade/registerFallback/tapIndex/applyIndexTaps/renderIndex`）、`loader`、`settings`、`storage`、`jobs`、`terminal`、`agents`、`llm`、`session*`、`workspace*`、`credentials`、`hmr`、`pluginManager`、`connection`、`appReady`、`webhook`、`schedule`、`goal`、`skills`、`subagent`…

### 11.3 客户端服务名

`slots`（`SlotRegistry`）、`locale`、`remote`（`ClientRemote`，含 `remote.<namespace>`）、`connection`、`configForms`、`theme`、`layout`、`uiSession`、`uiRenderer`、`modules`、`resources`、`shortcuts`、`settingsScope`（≤0.1.6）/`settings`（0.1.7+）、`settings.models`、`market`（dshmarket 提供）。

---

## 12. 装进 `web` profile 的确切命令

```powershell
# ── 0. 前置：插件必须先构建好 lib/client.js（Host 不编译客户端）
cd C:\Users\WANGZ\Documents\GitHub\dsh-app\dsh-desktop-pet
pnpm install ; pnpm run build
Test-Path .\lib\client.js        # 必须是 True

# ── 1. 安装到 web profile（pnpm add，DSH 先做兼容性预检）
dsh plugin --profile web add file:C:\Users\WANGZ\Documents\GitHub\dsh-app\dsh-desktop-pet
#   或纯符号链接（改完重建即生效，推荐本地开发）
dsh plugin --profile web add link:C:\Users\WANGZ\Documents\GitHub\dsh-app\dsh-desktop-pet

# ── 2. 确认它被当作 bundle 层启用
#    （声明了 dsh.bundle.patch 时，runPluginCommand 会自动追加到 dsh.profile.bundles）
Get-Content C:\Users\WANGZ\.dsh\profiles\web\package.json

# ── 3. 校验组合树（不启动）
dsh --profile web --dump-config
#    期望看到一条 insert 进来的 entry：id: desktop-pet / name: dsh-desktop-pet
dsh --profile web --dump-default-config      # 仅 bundle 层，用于排查 cordis.patch.yml 写坏的情况
dsh --profile web --dump-config-schema       # 打印 entry/patch 的 JSON Schema（会 import 插件声明 schema）

# ── 4. 启动（会打开带 ?token= 的浏览器 URL）
dsh web

# ── 5. 临时叠加一层 patch，不改 profile（例如临时禁用某行）
#    dev.patch.yml:  - id: desktop-pet
#                      disabled: true
dsh --profile web --patch .\dev.patch.yml

# ── 6. 兼容性被拒时（若你确实声明了 @deepseek-ai/dsh* peer）
dsh plugin --profile web version-exemptions
dsh plugin --profile web allow-version dsh-desktop-pet@0.0.1 --dsh-version 0.1.7-rc.2 --accept-risk

# ── 7. 卸载
dsh plugin --profile web remove dsh-desktop-pet
```

**手工启用（不想让 `dsh plugin` 自动改 bundles 时）**：

```yaml
# C:\Users\WANGZ\.dsh\profiles\web\cordis.patch.yml
- insert:
    - id: desktop-pet
      name: dsh-desktop-pet
      config:
        petName: Boba
```
```json
// C:\Users\WANGZ\.dsh\profiles\web\package.json  → dsh.profile.bundles 追加 "dsh-desktop-pet"
```
> 两者都做才算「作为 bundle 层启用」；只写 patch 也行（路径 B），但那样包不在 `dsh.profile.bundles` 里，插件管理页不会把它当受管 bundle。

**home 级 / 单入口 patch（影响所有 profile）**：
```yaml
# C:\Users\WANGZ\.dsh\cordis.patch.yml   ← 优先级高于 profile 层
- insert:
    - id: desktop-pet
      name: dsh-desktop-pet
```

---

## 13. 未验证 / 风险

### `[未验证]` 事实清单

1. **`dsh.profile.patchReload`**：实测存在于 `profile/package.json`（值 `"live"`），但**在已安装的所有 JS/TS/JSON/YAML 中 grep 不到 `patchReload` 字样**。它要么由 Desktop/更新版 launcher 读取，要么是过时/无效字段。**不要依赖它**；配置热重载实际由 `dsh-hmr` 条目提供。
2. **`PLATFORM_MODULES` 基座表的精确成员**：符号名只在 README 中出现，未在已安装 JS 里 grep 到；基座成员是**由 `require()` 实证**反推的（react / react-dom / react/jsx-runtime / cordis / ui-primitives / client-store + 静态 UI 库）。**新增外部依赖时必须在真实 Host 上试运行**，失败会表现为组合期「缺失提供方」错误。
3. **tsdown 共享 Client 预设**：README 提到它，但**文件不在本机安装中**（属 monorepo 内部工具）。§8.3 的配置是 `[推断]`，尤其「bundle banner 如何产出 `__ModuleLoader__.load`」这一步需要实测（dshmarket 用 `scripts/normalize-client-banner.mjs` 后处理，该脚本未随包发布）。
4. **`dshmarket` 的 peer 是否真的通过检查**：`@deepseek-ai/dsh-settings` 的 range 不含 `0.1.7-rc.2`，按 §7.1 逻辑应判不兼容；但 profile 下**没有 `compatibility.json`**，且它显然在运行。可能是 `optional: true` 被跳过、或 semver 预发布语义、或该 peer 根本未被评估。**结论：以「不声明 `@deepseek-ai/dsh*` peer」为稳妥策略**；此点建议实测。
5. **`shell.overlay` 的层级/定位契约**：文档只说「above every column」，未给 z-index/containing block 保证。宠物是否会被父层的 `transform`/`overflow` 裁剪、能否覆盖 settings 模态框，**需实测**。
6. **`ctx.provide` 在 Host 侧的行为**：客户端（theme、dshmarket）实证使用；Host 侧我在已读代码中**没有直接看到调用点**（Host 更常用 `Service` 子类 / `ctx.set`）。§10.4 用它注册 Host 服务属 `[推断]`，建议改用 `class PetService extends Service` 或先验证。
7. **`defineTool` 的 `execute` 字段名**：`dsh-tool-todo/lib/index.js:95-121` 只读到 `name/description/parameters/output`，未读到执行函数字段；`@deepseek-ai/dsh-tools` 的 `defineTool` 签名需另行阅读。
8. **浏览器半沙箱（`dsh-cordis-client-runner`）**：那是**进程内动态包**（Agent 运行时生成插件）的路径，其浏览器半被限制为「纯 JS、无 JSX、无 import、只有 `React`/`console`/`styles`/`host`」。**这是另一条产品线，与本任务的「已构建 npm 插件」无关**，不要混用（它的 `host.call(method,args)` 只到它自己的 host 半）。
9. **`dsh plugin --profile web add file:...` 对目录依赖是否真用符号链接**（pnpm 细节）+ **HMR 是否能感知符号链接目标的重建**：revision 由 `mtimeMs/ctimeMs/size` 派生，理论可行，未实测。
10. ~~`conversation.view` 注册的完整可用 props / `ChatNodeKind`~~ —— **已解决**：`ChatNodeKind` 的完整取值见 §3.4 表；`ChatNodeViewProps` / `ChatNodeOwnerProps` / `ChatNodeInjected` 已定位到 `dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:118-163`。`conversation.view` 组件仍应从 `SessionStandardProps`（`useConversation` / `useInput` / `inputActions` / `useSession` / `useProjection`，以及 chat/trajectory 各自合并进来的 `useChat` / `useTrajectory`）取数据，owner props 只提供 `{inspectCall, viewRequest, openView, completeViewRequest}`。
11. **前端资源与 CSP**：未发现 CSP 限制的证据，也未验证。

### 风险与建议

- **风险：把 `root` 当入口注册** → 会 shadow 掉整个 AppFrame，页面只剩你的组件。用 `shell.overlay`。
- **风险：`dsh.client.inject` 与导出的 `inject` 混淆** → 前者是包名（拓扑排序），后者是服务名。
- **风险：深度 import Host 内部包** → 唯一保证的 client 侧门面是 `@deepseek-ai/dsh-api-remotes`（wire 词汇）与已列出的 `dsh-client-ui-*`；跨包 import 需要写进 `dsh.client.external`，且没有语义化版本承诺。
- **风险：版本漂移** → `settingsScope` → `settings` 的改名就让 dshmarket 的设置卡静默消失过一次（源码注释里的 #722）。**推荐完全照抄「用 slot 存在性探测能力，而不是比对版本号」的模式**。
- **风险：Typert 路线** → 若真的需要类型化 RPC，需要自建生成流水线；先用 HTTP 路由方案。
- **风险：客户端 bundle 必须预构建** → 忘构建会导致激活失败并给出「缺少 bundle」诊断；`files` 字段必须包含 `lib/client.js`（或自定义 client 出口）。
- **建议**：把 `dshmarket` 的 `src/` 当作参考实现通读（尤其是 `src/client/index.ts` 的 289 行 —— 它把「注册设置页 / Tab / bundle 配置卡 / 浮层 / 客户端服务 / 版本自适应」一次演示完）。

---

## 14. 许可证与再分发

- 本机所有 `@deepseek-ai/*` 包**均为 MIT**（每包含 `LICENSE`，`package.json` 有 `"license": "MIT"`）；`dshmarket` 亦为 **MIT**（`dshmarket/LICENSE`）。
- MIT 允许复制、修改、再分发**代码**，条件是**保留版权声明与许可声明**（在源码/二进制中，及随附文档）。因此：
  - 抄 dshmarket 的模式代码（如 `api()`、`market-element` 的封装方式、section-gate 思路）**合法**，但若**逐字复制**较大片段，应在自己的 `LICENSE`/`NOTICE` 中保留 `Copyright (c) dsh-market` 及 MIT 全文。
  - 抄 `@deepseek-ai/*` 的实现代码同理（保留 DeepSeek 的版权与 MIT 声明）。
  - **不构成法律意见**；发布到 npm 前请让维护者确认 NOTICE 文件。
- 注意：**`dshmarket` 的 npm 包里连 `src/` 一起发布**（`files` 含 `"src"`），所以它本身就把「可参考的源码」当作分发内容；而 `@deepseek-ai/*` 只发 `lib/`（构建产物）+ `lib/types/`，**没有 `.ts` 源码**——所以对第一方包只能从 `.js`/`.d.ts`/README 反推。

---

## 附：本次调研读过的关键文件（供复核）

```
@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts            ← dsh 字段权威类型
@deepseek-ai/dsh-client-ui-theme/{package.json,lib/index.js,lib/client.js,lib/types/index.d.ts,lib/types/client/index.d.ts}
@deepseek-ai/dsh-client-ui-slots/{README.zh.md,lib/index.js,lib/types/index.d.ts,lib/types/renderer.d.ts}
@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts
@deepseek-ai/dsh-client-ui-layout/lib/types/client/index.d.ts     ← shell.overlay
@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts
@deepseek-ai/dsh-client-ui-chat/lib/types/client/contract/slots.d.ts
@deepseek-ai/dsh-client-ui-renderer/lib/types/client/registry.d.ts  ← root 警告
@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts
@deepseek-ai/dsh-client-ui-trajectory/lib/types/client/trajectory-contract.d.ts
@deepseek-ai/dsh-client-ui-session/lib/types/client/index.d.ts
@deepseek-ai/dsh-client-ui-settings-general/lib/client.js
@deepseek-ai/dsh-client-ui-sidebar-files/lib/{client.js,types/index.d.ts}
@deepseek-ai/dsh-tool-todo/lib/{index.js,types/index.d.ts}
@deepseek-ai/dsh-client-modules/README.zh.md
@deepseek-ai/dsh-client-hmr/README.zh.md
@deepseek-ai/dsh-host-frontend-static/README.zh.md
@deepseek-ai/dsh-cordis-client-runner/README.zh.md
@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts
@deepseek-ai/dsh-api-gateway/README.zh.md
@deepseek-ai/dsh-api-remotes/README.zh.md
@deepseek-ai/dsh-client-connection/README.zh.md
@deepseek-ai/dsh-typert-protocol/README.zh.md
@deepseek-ai/dsh-session-projection/README.zh.md
@deepseek-ai/dsh-client-store/README.zh.md
@deepseek-ai/dsh-plugin-manager/{README.zh.md,lib/index.js,lib/types/operations.js}
@deepseek-ai/dsh-app-boot/lib/index.js                            ← peer 兼容性
@deepseek-ai/dsh/{lib/bin.js,lib/plugin-BGnVfe_D.js,README.zh.md}
@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js                     ← patch 层顺序
@deepseek-ai/cordis-plugin-include/lib/index.js                   ← patch + !!js 语义
C:\Users\WANGZ\.dsh\profiles\web\{package.json,cordis.patch.yml,cordis.yml,pnpm-workspace.yaml,pnpm-lock.yaml}
C:\Users\WANGZ\.dsh\profiles\web\node_modules\dshmarket\{package.json,cordis.patch.yml,src/client/index.ts,src/client/market-data.ts,src/index.ts,src/routes.ts}
```
