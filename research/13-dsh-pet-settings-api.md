# dsh-pet 的设置面板框架 —— 可直接复用的部分

> 日期：2026-09-29 · 来源：读 `dsh-pet@0.2.12` 源码
> 结论：**不需要重写设置面板**，直接调用它的 PUT 接口即可。

---

## 1. 三段式数据流（dsh-pet 自己用的）

```text
数据入口（成品）
  宿主 readAllConfig() = 内置默认(assets/config.jsonc) + 用户层(main-config.json) + 文件宠物
  → GET /dsh-pet-7340/config 返回**绝对正确的成品**（{ main:{...}, pet1:{...} }）
  → 客户端直接消费，不做校验/兜底

数据出口（只写用户层）
  → PUT /dsh-pet-7340/config，body 为 JSON
  → 宿主 saveUserConfig() 白名单重建用户层 main-config.json
  → 响应体 = 保存后的**成品聚合**（与 GET 同一份）
  → 客户端把它交给 petBridge.reload() 直接拍平，**无需刷新页面**

恢复默认
  → DELETE /dsh-pet-7340/config（删除用户层文件）

路径信息
  → GET /dsh-pet-7340/config/meta（配置文件与素材目录路径 + 存储位置清单）
```

`PUT` 的额外好处（源码 L653-655 注释）：
> 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段
> （physics/whisperPrompt/chatMemoryRounds/...）带回给 saveUserConfig
> —— 设置页保存不再抹掉用户手改的精调配置

---

## 2. PUT 的可编辑字段（白名单，源码 config.ts:441-500）

**`pets[]` 每一项：**

| 字段 | 类型 | 必填 |
|---|---|---|
| `id` | string | ✅ |
| `size` | number > 0 | ✅ |
| `display` | `web` / `desktop` / `both` / `none` | ✅ |
| `position` | `{ corner, marginX, marginY }` | ✅ |
| `balanceEnabled` | boolean | ✅ |
| `name` | string | 可选（缺失则回落 id 并告警） |
| `whisperEnabled` | boolean | 可选 |
| **`workStatusEnabled`** | boolean | 可选 ← **状态联动就在白名单里** |

**顶层全局开关（未传则不写）：**

- `notificationsEnabled`（系统通知总开关）
- `whisperImageEnabled`（碎碎念配图）
- `chatImageEnabled`（对话配图）

**校验失败** → 400，并返回期望结构的说明。

---

## 3. 保存即生效（含桌面窗自动重启）

`PUT` 与 `DELETE` 之后都会调：

```js
void syncDesktop(); // display/size 等可能变化：重解析桌面宠物并重启 Helper
                    //（异步，不阻塞保存响应）
```

→ **改 `display` / `size` 不需要手动重启任何东西。**

反过来，**动画/物理/文案类字段**（`animations` / `animationWeights` / `physics` /
`workStatusTexts`）不在白名单里 → 只能**手改 JSON**，但这类改动**热生效**
（无需重启，宠物实时重读配置）。

---

## 4. 客户端注册契约（照抄即可）

`src/client/app.ts` 的装配层：

```js
const name = 'pet';
const inject = ['slots', 'locale', 'connection', 'remote', 'remote.commands', 'commandUi'];

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pet: dictionaries');
  const t = ctx.locale.bind(NS);

  // overlay
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'pet', order: 1000 }, () => h(PetMulti, {}));
  });

  // 设置页
  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register(
      { name: 'settings.section', id: 'pet-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
      PetConfigSection,
    );
  });
}
```

注意两点（与本项目现有实现一致）：
- `slots.inject` 用 **generator**，`yield` 注册句柄供卸载回收
- 设置页条目的 `inject: () => ({ t })` 把翻译函数显式传给组件

---

## 5. 对本项目的直接用途

**设置面板不必重写**。我们只要调 dsh-pet 的 PUT 接口就能改：
`notificationsEnabled`、`workStatusEnabled`、`display`、`size`、`position`、
`balanceEnabled`、`whisperEnabled`。

→ 这覆盖了 [todo.md](../todo.md) 里 P2-15「统一设置页」的**大部分需求**，
且**零耦合风险**（只用它的公开 HTTP 契约，不 import 它的内部模块）。

自研设置页只需负责 dsh-pet 白名单**之外**的东西，以及本插件自己的项。

⚠️ 耦合权衡：这会让本插件的设置页**依赖 dsh-pet 已安装**。
按 [ARCHITECTURE.md](../ARCHITECTURE.md) §9 的 L1/L2 分层，
「核心层不得依赖承载层」→ 所以设置页必须**检测 dsh-pet 是否可用**，
不可用时隐藏相关分区，而不是报错。
