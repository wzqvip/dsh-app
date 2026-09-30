# 提问面板：结构在、子元素为空 —— 已定位并修复

> 日期：2026-09-30 · 状态：**两个 bug 均已修复并验证通过**

## 结论速览

| # | 症状 | 根因 | 状态 |
|---|---|---|---|
| 1 | 有提问时抛 `Cannot read properties of null (reading 'key')` | `h('span', null, …)`；`h` 是 `jsx`，`config` 不能为 `null` | ✅ 已修 |
| 2 | 面板容器在、`childNodes: 0` | `h` 用的是 `jsx`（第 3 参是 key），而组件按 `createElement` 语义把 children 作为第 3+ 参展开传 → **children 被静默丢弃** | ✅ 已修 |

修法：`app.js` 改为 `const h = react.createElement;`。
修后实测面板完整渲染（提问文案 + 选项 + 输入框 + Submit/Skip），
并有截图 `build/question-panel.png`。

## 排查过程（可复用的取证方法）

1. 先做端到端验证脚本：注入合成提问 → 真实 Chromium → CDP 断言。
2. 崩溃信息很快暴露了 bug 1（错误栈指向 DSH 自己的 bundle，因为它崩在 React 里）。
3. bug 2 的定位靠 **`outerHTML`**：
   ```json
   { "roots": 1, "childNodes": 0,
     "outerHead": "<div data-dsh-efficiency=\"questions\" data-anchor=\"below-pet\"
                    style=\"position: fixed; ... display: flex; ...\"></div>" }
   ```
   容器渲染了（定位属性齐全，说明 `items.length > 0`，否则 L188 就 return null），
   但里面**一个子节点都没有**。
4. 此时把怀疑对象从"数据"换成"children 传递方式"，一次命中。

## 为什么长期没被发现

- bug 1 只在**真的有提问要渲染**时触发，平时走不到那行。
- bug 2 影响"多 children"的元素；设置页的表单行每个元素通常只传一个 children，
  恰好落在 `jsx(type, config, key)` 能容忍的范围内，所以设置窗口一直正常。
  这解释了"只有提问面板空"的现象。

## 教训

- **"容器查出来了"不等于"内容渲染了"**：必须看 `childNodes` / `innerHTML`。
  只看"元素存在"会漏掉"子元素被吞"这一类问题。
- **`h` 这个名字掩盖了两套调用约定**（`createElement` 与 `jsx`）。
  看到"元素在、内容空"时，先怀疑 children 怎么传的，别先怀疑数据。
- **判据本身要先验证**。本轮我又先后用错两次选择器
  （`[class*=efficiency]`、按钮文字 `/选项 A/`），两次都得出"面板没渲染"的
  错误结论，白白绕路。
- **断言别要求逻辑上不可能的事**：合成提问没有真实 agent，
  宿主必然回 `no-live-agent-for-call`。该步该验的是
  "面板执行了答案路径且如实报错、不静默"，而不是 `answered > 0`。


## 这一轮已经修掉的（确定的 bug）

`panel.js` 里有一处 `h('span', null, t('title'))`。

`h` 是 **`react/jsx-runtime` 的 `jsx`**，签名是 `jsx(type, config, key)`，
内部会读 `config.key` —— **传 `null` 直接抛**：

```
TypeError: Cannot read properties of null (reading 'key')
```

现场表现极具误导性：错误栈指向 **DSH 自己的 bundle**
（`/assets/index-*.js`），控制台只留一句
`slot entry crashed in 'shell.overlay'`，完全看不出是我们的哪一行。

**只有当真的有提问要渲染时才会走到那一行**，所以这个缺陷长期潜伏 ——
直到本轮写了"提问到达 → 面板弹出"的端到端验证才暴露。

已改为 `h('span', {}, t('title'))`。修后该错误消失（console 0 错误）。

## 仍未解决的问题

用 `DSH_EFFICIENCY_DEV_TOOLS=1` 注入合成提问后，在真实 Chromium 里观察到：

```json
{ "roots": 1, "childNodes": 0,
  "outerHead": "<div data-dsh-efficiency=\"questions\" data-anchor=\"below-pet\"
                 style=\"position: fixed; top: 368px; right: 24px; z-index: 9000;
                        max-width: 380px; max-height: 451px; display: flex; ...\"></div>" }
```

也就是说：

- **容器渲染了**：定位属性齐全（`below-pet`、fixed 定位、z-index 9000），
  说明 `computePanelPlacement` 跑通、`items.length > 0` 也成立
  （否则组件在 L188 就 `return null` 了）
- **但容器里一个子节点都没有**（`childNodes: 0`，`innerHTML` 为空）
- 客户端日志明确写着 `面板开始渲染 1 条`，且 `poll 得到 1 条待答` 持续出现
- `/api/pending` 手动 curl 返回的数据结构正确
  （`{ok,count,items:[{callId,questions:[{id,question,header,options}]}]}`）

## 主要假设（下轮先验这一条）

**`h` 注入的是 `jsx`，而 panel.js 用的是 `createElement` 的 children 语义。**

- `jsx(type, config, key)` 的第三个参数是 **key**；
  children 必须写在 `config.children` 里。
- 而 panel.js 到处是
  `h('div', { style: S.card }, h(...), h(...), ...)` —— 把 children
  作为**第 3、4、5… 个参数**展开传（这是 `createElement` 的用法）。

如果 `jsx` 只认前三个参数，那么所有展开的 children 都会被**丢弃** ——
于是"容器在、子元素为空"，与观察完全吻合。
（顶层容器 `h('div', {style,...}, ...items.map(...))` 的 children 同样被丢，
所以连 item 的 div 也没有。）

### 验证方法
读 DSH 客户端 SDK 里 `h` 的来源（`makeQuestionPanel({ h, ... })` 的 `h` 由
app.js 从 `require('react/jsx-runtime').jsx` 取得 —— 见 app.js 的 makeFactory），
确认它的签名，然后二选一：

- **A**：改用 `React.createElement`（app.js 里从 `require('react')` 取
  `createElement`，作为 `h` 传下去）—— 与现有调用风格一致，改动最小。
- **B**：把 panel.js 全部改成 `jsx(type, { ...props, children })` 形式
  —— 改动大，容易漏。

（注意 app.js 里 `const { jsx: h } = require('react/jsx-runtime')`，
这就是所有子元素被吞的根源。settings.js 的 `makeSettingsSection` 也用同一个 h，
但它渲染的是表单行，**每个元素只传了一个 children 参数**，
恰好落在 `jsx(type, config, key)` 的可容忍范围内，所以没暴露。
这解释了为什么设置窗口一切正常、只有提问面板空 —— 与观察一致。）

## 教训

- 又一次是"**判据/假设本身没验证**"：我先用 `[class*=efficiency]` 查（面板
  根本没 class，标记是 `data-dsh-efficiency="questions"`），又用按钮文字
  `/选项 A/` 查（选项标签其实就是 `A`），两次都得出"面板没渲染"的错误结论。
  改用 `outerHTML` 直接看才拿到客观事实。
- 排查时"**把容器查出来**"不等于"**内容渲染了**"：
  必须看 `childNodes`/`innerHTML`，只看"元素存在"会漏掉子元素被吞的情况。
