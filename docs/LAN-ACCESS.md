# 局域网访问（LAN）——现状与可行路径

> 研究日期：2026-10-15 · 基于 DSH `0.2.0-rc.2` **源码复核 + 本机实测**
> 相关：[SECURITY.md](SECURITY.md)（威胁模型）· [plan.md](../plan.md) §5

## 一句话结论

**当前 DSH 没有任何受支持的"直接监听局域网"方式** —— `host` 只允许回环。
但**"只绑回环 + 自己加一个隧道/代理入口"这条路是可行的**，且已实测走通。
代价是：你必须自己承担入口的安全（DSH 明确把这件事留给了你）。

---

## 1. 为什么不能直接监听局域网（两层拦截，都实测确认）

### 第一层：CLI 显式拒绝 `0.0.0.0`

```
$ dsh web --host 0.0.0.0
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network;
       use 127.0.0.1 instead
```

源码：`dsh-web-app/lib/startup.js`

```js
if (options.host === "0.0.0.0") program.error("... intentionally not supported yet ...");
```

### 第二层：webserver 的 schema 也只允许回环

即使绕过 CLI 守卫（比如改插件配置），底层还会拦：

```
$ dsh web --host 192.168.2.183
ValidationError: invalid config:
  $.host expected "127.0.0.1" | "0.0.0.0" but got "192.168.2.183"
```

源码：`dsh-host-webserver/lib/index.js`

```js
host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
```

**合起来看**：`0.0.0.0` 被 CLI 拒、具体 IP 被 schema 拒 → **没有受支持的直连路径**。
（`--host` 实际上无法把服务放到局域网上。）

> ⚠️ 顺带一个实测出来的**细节坑**：`dsh web --host 0.0.0.0` 这个"自动信任局域网 IP"
> 的逻辑（`resolveLanTrust`）**写了但走不到** —— 因为 CLI 在它之前就退出了。
> 读源码时容易误以为"绑 0.0.0.0 是支持的"，实测才发现不行。

---

## 2. 为什么 `--trusted-host` 不是"开 LAN 的开关"

`--trusted-host` 只影响 **`/api` 的 DNS-rebinding 围栏**，不改变监听地址。

围栏逻辑（`dsh-client-connection/lib/index.js` → `isTrustedApiRequest`）：

1. `Host` 必须是**回环**，或在 `trustedHosts` 列表里 → 否则 **403**
2. `sec-fetch-site: cross-site` → 403
3. 若带 `Origin`：`new URL(origin).host` 必须等于 `Host` → 否则 403

源码注释明确写了它的定位：

> *Network reachability and authentication stay out of scope … this fence is not an auth layer.*

**实测对照**（DSH 绑回环，代理在 `192.168.2.183:3095` 转发）：

| DSH 启动参数 | 请求 `Host` | `/api/health` |
|---|---|---|
| 默认 | `192.168.2.183:3095` | **403** ← 围栏拒绝 |
| 默认 | `192.168.2.183:9999` | **403** |
| `--trusted-host 192.168.2.183:3095` | `192.168.2.183:3095` | **401** ← 围栏放行，进入认证 |
| `--trusted-host 192.168.2.183:3095` | `192.168.2.183:9999` | **403** ← 未列入的仍拒 |

→ 结论：**`--trusted-host` 是"入口方案"的必要配件，不是 LAN 开关。**

---

## 3. 认证层：token → 签名 cookie

- 每次启动生成**每进程随机 token**（32 字节 base64url），打印在启动输出里：
  `dsh web: http://127.0.0.1:<port>/?token=<43 字符>`
- 带 `?token=` 访问 → 303 并下发 cookie
- cookie 形态：`dsh-auth-<authority 的哈希>=v1.<payload>.<签名>`，
  **payload 里固定了 authority**：

  ```json
  {"version":1,"authority":"192.168.2.183:3095","issuedAt":…,"expiresAt":…}
  ```

**两个直接后果**：

1. **cookie 与 authority 绑定** —— 经 `192.168.2.183` 拿到的 cookie 不能用于
   `127.0.0.1`（反之亦然）。换 IP/主机名访问要**重新用 token 换一次**。
2. ⚠️ **cookie 没有 `Secure` 标记**（因为默认是回环 HTTP）→
   **明文 HTTP 上可被嗅探，嗅探到即完全失守**。这是 [SECURITY.md](SECURITY.md) 已记录的弱点。
   实测确认（`Set-Cookie` 里只有 `HttpOnly; SameSite=Strict`，无 `Secure`）。

---

## 4. 三条可行路径（按推荐度排序）

### 方案 A：SSH 隧道（**最推荐**）

**思路**：DSH 保持只绑回环，你把**流量送进回环**。

```powershell
# 在手机/另一台机器上（需要 SSH 到这台机器）
ssh -N -L 3080:127.0.0.1:3080 <user>@<这台机器的IP>
# 然后手机浏览器访问 http://127.0.0.1:3080/?token=<token>
```

- ✅ 不需要 `--trusted-host`（客户端 URL 的 authority 就是 `127.0.0.1:3080`）
- ✅ 链路是 SSH 加密的 → 绕开了"cookie 无 Secure、明文可嗅探"的弱点
- ✅ 不需要开防火墙入站端口（SSH 那个口你自己管）
- ⚠️ 需要在手机上装 SSH 客户端；token 仍要手工传一次

> 手机端可用 Termux / iOS 的 SSH 客户端做本地端口转发。
> 或者**反向**：用 Tailscale/ZeroTier 这类覆盖网（见方案 C）。

### 方案 B：本机反向代理 + `--trusted-host`（无需改 DSH 代码）

**思路**：代理监听局域网，把请求转给回环，并**保留原始 Host**，
同时给 DSH 加 `--trusted-host <代理的 authority>`。

```powershell
# 1) 启动 DSH 时声明信任代理的 authority（host:port 必须与实际访问的一致）
dsh web --port 3080 --trusted-host 192.168.2.183:3095

# 2) 起代理（保留 Host 模式）
node scripts/lan-proxy-probe.mjs --listen 192.168.2.183:3095 --target 127.0.0.1:3080 --mode keep

# 3) 手机访问 http://192.168.2.183:3095/?token=<token>
```

- ✅ 不需要改 DSH 任何代码
- ⚠️ **必须 HTTPS**，否则 token/cookie 在明文上裸奔；
  而 HTTPS 又要求证书被手机信任（自签需在手机上装根证书）
- ⚠️ 必须同时开 Windows 防火墙入站（**只放行"专用网络"配置文件**）

### 方案 C：覆盖网（Tailscale / ZeroTier）—— 你机器上**已经装好了**

实测本机已有：

```
172.28.0.5        ZeroTier One
100.85.232.107    Tailscale
```

**思路**：这两个都会给你一张"私有虚拟网卡"，手机加入同一网络后
可直接访问这些地址。但 **DSH 只绑回环，所以你仍需要一个入口** ——
所以方案 C 是**方案 A/B 的传输层替代**，不是独立方案：

- 手机与电脑都在 Tailscale/ZeroTier 里 → 用**方案 B 的代理**绑到覆盖网 IP
  （比绑真局域网更安全：不对公网/访客网络暴露）
- 或者用 Tailscale 的 `tailscale serve` / `funnel` 做入口（自行加密 + 身份）

**这是本机最合适的组合**：`Tailscale + 方案 B 代理`，且把 `--trusted-host` 设成 Tailscale 的 authority。

---

## 5. 无论选哪条路，都必须做的

- [ ] **上 HTTPS** —— cookie 无 `Secure`，明文等于交出完整操作员权限
- [ ] **只放行私有网络配置文件**（Windows 防火墙），绝不在公共 WiFi 上开
- [ ] **用完就关** —— 代理/隧道都是一条命令，随手停掉
- [ ] **token 当密码对待** —— 它等价于登录凭据；不要发在群里/截图里
- [ ] **确认 `--trusted-host` 只列你自己的 authority**，不要图省事写通配
- [ ] 记住：**任何通过认证的客户端 = 完整操作员权限**
      （`terminal.create` 可开系统级 shell，绕过 Agent 沙箱与审批）

---

## 6. 附：诊断工具

`scripts/lan-proxy-probe.mjs` —— 最小转发代理，用来验证围栏行为：

```powershell
# 保留 Host（对应方案 B）
node scripts/lan-proxy-probe.mjs --listen <LAN_IP>:<port> --target 127.0.0.1:<dsh_port> --mode keep

# 改写 Host 为回环（不需要 --trusted-host；但真实浏览器还需一并改写 Origin，脚本已处理）
node scripts/lan-proxy-probe.mjs --listen <LAN_IP>:<port> --target 127.0.0.1:<dsh_port> --mode rewrite
```

⚠️ 它是**诊断工具，不是产品代码**：无 TLS、无访问控制。
**只在本机临时实验时用**，别拿它当长期入口。

### 实测踩到的两个坑（留给后来者）

1. **`Origin` 头必须跟着 `Host` 一起改写**
   围栏要求两者同源。浏览器对**同源 GET 不发 `Origin`**，所以只测 GET 会得出
   "能用"的错误结论 —— 直到你点发送消息/改设置（POST）才 403。
   脚本的 `rewrite` 模式已同时改写 `Origin`。
2. **`--trusted-host` 的取值必须与实际访问的 `host:port` 完全一致**
   （含端口）。写成 `192.168.2.183`（不带端口）在围栏里是"匹配任意端口"，
   但如果你用 `localhost` 或别的 IP 访问，仍然 403。
