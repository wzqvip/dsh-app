# Outlook 手机 App 取信：可行方案评估

> 调研日期 2026-11-03 · 由子代理独立调研 + 主代理核验本地能力
> 目标：在学校**只有 OWA、无 OAuth/Graph/token** 的前提下，把邮件内容接进
> `dsh-assistant`（提取 DDL → 提醒 → 摘要）

## 证据强度说明（重要）

子代理调研时 `developer.android.com` 与 `support.apple.com` 的页面**被截断或拦截**，
因此 Android/iOS 的部分条款依据的是同主题的其它官方页面 + 可抓取的第三方复现记录
（KDE Bugzilla、OWASP MASTG、微软 Q&A、learn.microsoft.com）。

本文用以下标记区分：

- ✅ **已验证**：本仓库主代理自己查证过（附链接）
- 📎 **子代理调研**：子代理给出的证据，主代理**未二次核验**
- ⚠️ **推测**：尚无直接证据，需实测

---

## 结论

1. **唯一能长期落地的：Android 通知监听**（`NotificationListenerService` → 自建 webhook）。
   复用"Outlook App 会话不易过期"这一已知事实，绕开 OAuth/OWA。
   能拿 **发件人 + 主题 + 正文摘要 + 时间**；**拿不到正文与附件**。
2. **EAS / IMAP 基本认证已经死了** ✅ —— 不要投入。
3. **先花 15 分钟试 Power Automate**：能拿到正文+附件，性价比最高，但取决于学校策略。
4. **ADB 不做主路径**，但 `dumpsys notification --noredact` 与 `appops` 是很好的救援工具。

---

## 对比表

| 方案 | 能拿到 | 稳定性 | 一次性工时 | 专用设备 | 主要风险 |
|---|---|---|---|---|---|
| **Power Automate**（新邮件→HTTP POST） | 主题/**正文**/附件 | 3/5 | 0.5–2h | 否 | 租户禁用 / DLP / HTTP 动作属 premium / **需公网可达回调** |
| **规则转发 → Gmail IMAP** | 全部 | 4/5 | 1–2h | 否 | 手机端不能建规则；**外发自动转发默认关闭**（`5.7.520`） |
| **Android 通知监听 → webhook** ⭐ | 发件人/主题/摘要/时间 | 4/5 | 4–8h（现成 FOSS App 起步 1–2h） | 否 | Android 15 脱敏、Intune 屏蔽通知内容 |
| 无障碍 / Appium | 列表 + 正文片段 | 2/5 | 16–30h | 是 | 需解锁前台；RN 选择器不稳 |
| ADB `uiautomator` / `dumpsys` | 同上，`dumpsys` 可读全文 | 2.5/5 | 10–20h | 是 | 解锁、adb 掉线、格式漂移 |
| ~~EAS / IMAP 基本认证~~ | — | **0** | — | 否 | 永久禁用 |
| iOS 快捷指令 | 发件人/主题（正文存疑） | 2/5 | 2–4h | iPhone | Conditional Access 只许 Outlook；无后台常驻 |
| Teams / To Do / RSS | 基本无 | 1/5 | — | 否 | 需 token / 功能已移除 |

---

## 关键事实

### ✅ Exchange Online 的 Basic auth 已永久禁用

微软公告：Basic auth 自 2022 年起在 Exchange Online 中停用，**包括应用密码**，
且官方明确表示无法重新启用。
来源：<https://learn.microsoft.com/en-ca/lifecycle/announcements/basic-auth-deprecation-exchange-online>

→ "没有 OAuth 就用 IMAP 用户名密码"这条路，在现代租户上不成立。
（`pyactivesync` 等 EAS 客户端库确实存在 📎，但按 basic auth 设计，需要改成 Bearer —— 前提是你有 Bearer，
而没有 OAuth 授权就没有 Bearer，逻辑闭环不成立。）

### ✅ Outlook 手机 App 不能建规则/转发

微软 Q&A：移动端找不到 Rules and Forwarding，必须回 PC 版 OWA。
来源：<https://learn.microsoft.com/en-us/answers/questions/4711391/can-t-find-rules-and-forwarding-when-using-mobile>
参考：<https://learn.microsoft.com/en-us/answers/questions/4731936/automatic-mail-forwarding-in-mobile-outlook-app>

> **但这不等于转发路走不通**：规则只需在 OWA **登录一次**设好（一次性 2FA），
> 之后由服务端执行，与网页会话是否过期无关。
> 真正的障碍是租户策略：**外发自动转发默认关闭**，退信码 `5.7.520` 📎。

### ✅ Outlook Android 通知里含正文预览

微软 Q&A 有用户抱怨通知里能看到验证码 → 说明通知载荷含 发件人 + 主题 + 摘要。
📎 具体字段名（`title` / `text` / `bigText` / `textLines`）需实测确认。

### 📎 Android 15 敏感通知脱敏（新坑）

Android 15 引入 `RECEIVE_SENSITIVE_NOTIFICATIONS`；第三方 listener 对 OTP 类内容
只看到 `Sensitive notification content hidden`。
现场证据：KDE Connect bug 495146（2024-10）；误判问题：bug 498862。
无 root 绕过：`adb shell cmd appops set <pkg> RECEIVE_SENSITIVE_NOTIFICATIONS allow`。
**对 DDL 类邮件影响有限**（判定是启发式的）。

### 📎 Intune MAM 会屏蔽通知内容（独立机制）

MC862228：`Org data notifications` 策略下，锁屏通知只剩"新邮件"。
与 Android 脱敏是两回事。**受 MDM 管理的设备不要尝试绕过**。

### ✅ ADB 可以无 root 检查 UI 层级

OWASP MASTG 的「Inspecting the UI Hierarchy」：`uiautomator dump` 无需 root。
来源：<https://mas.owasp.org/MASTG/techniques/android/MASTG-TECH-0177/>

---

## 推荐顺序（每步都能快速止损）

| 步 | 动作 | 谁做 | 时间 | 通过后 |
|---|---|---|---|---|
| 1 | `make.powerautomate.com` 试建「新邮件到达 → HTTP」 | 维护者（需 2FA） | 15 min | 走 PA，拿正文+附件 |
| 2 | OWA 开转发到 Gmail，发测试信看是否 `5.7.520` | 维护者 | 10 min | 走 Gmail IMAP |
| 3 | 通知监听 PoC（现成开源 App，不写代码） | 维护者装 + 主代理接入 | 1–2h | 主题+摘要够用即继续 |
| 4 | 上面全挂 → ADB `dumpsys notification --noredact` 兜底 | 主代理 | 2–3h | 仅调试设备 |

### 通知监听 PoC 通过线

> 24 小时内 ≥95% 的测试邮件在 **60 秒内**到达，且含 **发件人 + 主题 + 时间**；
> 重复 0；重启 App 后自恢复；脱敏占比 <10%（或 `appops` 之后为 0）。

### 必须做心跳告警

通知监听的失败是**静默的**：权限被杀、Intune 策略更新、省电清理都会让"什么都没来"。
必须加 **24 小时零通知 → Telegram 告警**，否则会把"管道断了"误判成"这周没作业"。

---

## 工程要点（给实现）

- **去重键**：`(package, notificationId, postTime)`
- **`textLines` 必须全量入库**（多封邮件聚合时 `bigText` 会被覆盖，只有 `textLines` 保留全部）
- **定时 `getActiveNotifications()` 补漏**（监听丢事件时兜底）
- `requestRebind` 处理服务被系统断连
- **包名白名单只留 `com.microsoft.office.outlook`**，避免收到其它 App 的隐私内容
- 归一成 `Item`：`source: 'outlook'`, `kind: 'email'`，复用现有去重/提醒/推送管线

## 合规优先级

**合规性**：Power Automate > 转发规则 > 通知监听 > UI 自动化
**可行性**：恰好相反

建议：**只存主题 + 摘要，不落正文** —— 教育记录（FERPA 语境）外流的风险不对等。
受 Intune 管理的设备**不要**绕过 MAM。
