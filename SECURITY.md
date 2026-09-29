# 安全说明

## 报告漏洞

请**不要**开公开 Issue。请通过 GitHub 的
[Private vulnerability reporting](https://github.com/wzqvip/dsh-app/security/advisories/new)
或邮件联系维护者。

---

## ⚠️ 本项目最需要警惕的风险：局域网暴露

本项目的"局域网访问"功能会把 DSH 的 Web 界面开放给其他设备。
**这不是一个普通开关 —— 它等价于把远程代码执行能力开放到网络上。**

### 为什么严重

DSH 有认证（每进程 launch token → 签名 cookie），但**一旦某个客户端通过认证，它就拥有完整操作员权限**：

| 能力 | 后果 |
|---|---|
| `terminal.create/write` | 以**系统用户权限**开交互式 shell，**绕开 Agent 的沙箱模式与审批策略** |
| `session.prompt` | 提交任意 prompt 驱动 Agent 执行命令 |
| `GET /api/file?path=<绝对路径>` | 读任意可读文件（**不受工作区约束**） |
| `settings` / `credentials` 写权限 | 可把 LLM key 改指到攻击者端点 |

DSH 官方**正是因为这个原因**在 CLI 层**硬拒绝** `--host 0.0.0.0`：

> `--host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network`

### 认证层的已知弱点

- token 兑换出的 cookie **刻意不带 `Secure`**（因为默认服务是回环 HTTP）
- → **在明文 HTTP 上可被嗅探，嗅探到即完全失守**

### 因此，任何开启局域网访问的方式都必须满足

- [ ] **优先保持 `host=127.0.0.1`**，用 SSH 隧道 / VPN / 反向代理做入口
- [ ] 若必须直连 LAN：**仅在完全可信的隔离网络**，且必须 HTTPS
- [ ] 有令牌/配对门，且**首次开启需显式确认**
- [ ] 只接受 IP 字面量 Host（防 DNS 重绑定）
- [ ] 提供**一键关闭**
- [ ] Windows 防火墙**只放行私有网络配置文件**
- [ ] 明确告知用户暴露的地址范围

**绝对不要**在咖啡厅、酒店、机场等公共 WiFi 上开启。

详见 [plan.md](plan.md) §5（含经源码复核的威胁模型与四套方案的排序）。

---

## 其它安全考量

### 插件信任

DSH 插件在**宿主进程内运行，不受工作区沙箱限制**。
本项目依赖第三方插件（如 `dsh-pet`），安装前请自行评估。

### 版本闸门不是安全机制

DSH 对插件 `peerDependencies` 的版本校验是**兼容性检查，不是沙箱**，
它**不防范恶意包代码**。本项目刻意不声明该 peer（为绕开兼容性闸门），
**这不代表可以放松对依赖的审查**。

### Token 与凭据

- DSH 的 launch token 每次启动都会变
- cookie 签名密钥持久化在 `$DSH_HOME/.credentials.yaml`
- **不要把 `$DSH_HOME` 下的凭据文件提交到仓库或分享**

本仓库的 [.gitignore](.gitignore) 已排除常见构建产物与本地备份，
但**请自行确认没有把 `~/.dsh` 的内容误提交**。

---

## 支持范围

项目处于早期阶段，安全修复会**优先处理**。
由于包含 `dsh-pet` 的素材（禁止商用），本项目及其衍生作品**不得用于商业用途**。
