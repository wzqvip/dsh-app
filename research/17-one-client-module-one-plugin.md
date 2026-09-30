# 为什么网页端宠物不显示 —— 一个客户端模块只能出一个插件

> 日期：2026-09-29 · 状态：**根因已定位，修法待实施**
> 相关：[research/16](16-chat-bubble-how-it-works.md)（chat 气泡）、[AGENTS.md §4.2](../AGENTS.md)

## 现象

- 桌面端宠物：**正常**（实机截图 + 菜单 dump 含「设置…」）
- 网页端宠物：**完全不渲染**（无 `.pet-sprite`、无 `.pet-hit`、页面里没有任何 pet 类名）
- 我们的效率插件在网页端：**正常**（apply 完成、插槽注册、QuestionPanel 已挂载）

## 定位过程（关键是先让"看不见的"可见）

宠物客户端**上游没有任何 apply 期日志**，所以"它到底有没有 apply"在浏览器里
根本看不见。我先在生成的壳里给宠物 factory 包了一层诊断
（`scripts/build.mjs`，产出 `[dsh-efficiency-pet] factory 被调用`），
于是拿到决定性证据：

```
[dsh-efficiency] client logging installed      ← 我们的插件
[dsh-efficiency] apply() 开始
…
[dsh-efficiency-pet] factory 被调用            ← 【完全没有这一行】
```

**→ 宠物 factory 从未被调用，即根本没被物化（materialize）。**
而"没被物化"是**不会**报错的 —— 所以控制台干净、无 HTTP 失败，极具迷惑性。

## 根因

DSH 的客户端 boot 清单（`window.__DSH_BOOT__.entries`）里，
**每个包只对应一个客户端模块 id**，形如：

```json
{ "id":"dsh-efficiency", "url":"plugins/??dsh-efficiency/client.js&rev=…",
  "inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-connection"] }
```

`: `inject` 里是**客户端模块 id**（不是服务名）；它决定装载顺序。
上游 `dsh-pet` 同样只有一条：`{"id":"dsh-pet", …}`。

而我们的 bundle 提交了**两次** `load()`：

| load 的 id | 谁引用它 |
|---|---|
| `dsh-efficiency` | ✅ boot 清单里有 |
| `dsh-efficiency-pet` | ❌ **没有任何条目引用** |

客户端的模块系统是"按需物化"：**只有被 boot 条目 import 过的 id 才会
走 `factory(require)`**。`dsh-efficiency-pet` 只是被"登记"了 factory，
永远等不到 import —— 于是它的 `apply` 永远不会跑。

> 一句话：**一个客户端模块只能出一个插件。**
> 我们把两个插件塞进同一个 `client.js`、用两个 id 分别 load，
> 第二个在没有清单条目的情况下等于死档案。

## 修法（待实施，按推荐度排序）

### 方案 A（推荐）：让 factory 返回两个插件的组合
让 `dsh-efficiency` 这一个 id 物化出来的模块同时代表两个插件。
需要确认 cordis 的客户端装载器**是否支持一个模块导出多个插件**
（例如 `export const plugins = [pet, efficiency]` 之类的约定）。
先做取证：读 `@deepseek-ai/dsh-cordis-client-runner` 与
`@deepseek-ai/dsh-client-modules`，看它对 factory 返回值的要求
是"一个插件对象"还是"可以是数组/多插件容器"。
如果支持 → 改动最小，只需改 `scripts/build.mjs` 的壳与 `app.js` 的返回值。
（本轮曾在 `app.js` 里试过返回 `{ plugins: [...] }`，但当时是**基于猜测**，
没有先取证约定，属于错误做法，已回退。）

### 方案 B：把宠物代码并进我们自己的插件里
不再单独 `load('dsh-efficiency-pet')`，而是在我们插件的 `apply` 里
**直接调用宠物插件的 apply**（把宠物模块当作库，而不是独立插件）。
缺点：宠物 inject 的 6 个服务（`slots/locale/connection/remote/remote.commands/commandUi`）
得由我们的 inject 声明并转发；宠物内部对 `ctx` 的用法要能接受我们转交的 ctx。
优点：完全不依赖装载器的多插件支持。

### 方案 C：起第二个包
拆成 `dsh-efficiency-pet` 独立包（各自 `dsh.client`）。
最"正统"，但与维护者"做成一整个包"的要求相违，且回到双包分发。

## 待取证清单（下轮先做这个，别急着改）

1. `@deepseek-ai/dsh-client-modules` 的 `create`/物化对 factory 返回值的契约
   （必须是 `{name, inject, apply}` 单对象？还是也接受数组/`plugins` 字段？）
2. `@deepseek-ai/dsh-cordis-client-runner` 如何把条目变成插件
   —— 是否有一处会遍历"模块里的多个插件"
3. `cordis.patch.yml` 是否支持在一个 bundle 里插入多条 entry
   （若能，则每个 entry 各对应一个客户端 id，问题自然消解）

## 教训（写给下轮的我）

- **不要在没有日志的地方猜**。宠物上游没日志 → 先加诊断让状态可见，
  否则"没物化"与"物化了但渲染失败"看起来一模一样。
- **不要靠印象判断限制**。本轮我先说"沙箱管道 spawn 会 EPERM"（实测正常）、
  又说"probe.js 是死代码"（实际被 answerer 引用）—— 两次都是凭印象，
  两次都错。判据本身要先验证。
- **先取证契约，再写代码**。给 `app.js` 试 `{ plugins: [...] }` 是不该做的：
  那是猜约定，而不是读约定。
