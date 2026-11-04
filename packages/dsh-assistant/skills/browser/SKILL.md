# 浏览器技能（Browser）

> 让助理能真的"打开网页、读内容、填表、点按钮"，而不是只会说"我看不到"。
> 底层是 `dsh-browser` 服务；技能层负责**怎么做、什么时候该停手**。

## 0. 能力边界（先看这条）

| 能做 | 不能做 / 必须问人 |
|---|---|
| 打开任意网址、读页面文字与结构 | 替你输 2FA / 验证码 |
| 点按钮、填输入框 | **提交作业 / 交卷**（必须维护者点头） |
| 在页面里跑 JS 读结构化数据（`/eval`） | 读文件系统、读服务器密钥 |
| 用已保存的账号密码过登录表单 | 绕过 CAPTCHA |

**铁律**：任何"不可逆"的动作（提交、删除、付款、发消息给对方）一律先问人。

## 1. 接口（`http://dsh-browser:8789`，头 `x-dsh-token`）

| 接口 | 说明 |
|---|---|
| `POST /open {url}` | 在**同一个受管页**上导航（不会新开标签） |
| `POST /snapshot {}` | 返回 `{url,title,text,chars,needsUser,reason}` |
| `POST /act {action,selector,text?}` | `click` / `type` / `waitFor` |
| `POST /eval {script,timeoutMs?}` | 在页面里执行 JS，返回 `{result}` |
| `GET /health` | `{browserUp,page:{url,title},vncUrl,...}` |

`needsUser:true` 时 `reason` 是稳定枚举：
`login_required | mfa_required | captcha | blocked | unknown`。

## 2. 通用配方

### 2.1 读一个页面
```
/open <url>  →  等 5-10 秒（LTI/SPA 渲染慢）  →  /snapshot
```
- `chars < 100` 且 `needsUser:false` = **可疑空页**，不要当成功（实测踩过）
- 需要结构化数据（列表、表格）时用 `/eval`，别用正则啃 `text`

### 2.2 需要登录
```
needsUser:true
  → 如果 reason 是 login_required 且站点有账号密码表单：填账号密码（用 /eval 直接设值 + click 提交）
  → 如果是 mfa_required / captcha：**停手**，把 noVNC 链接发给维护者
```

**`/eval` 直接设值**比 `/act type` 稳：很多登录页有浮层（如 Microsoft 的 `#footerLinks`）
会拦截真实点击，但 JS `.click()` 不经过命中测试。

```js
// 填表单的稳妥写法（原生 setter + 事件）
(() => {
  const set = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
    setter ? setter.call(el, val) : (el.value = val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  return { user: set('#username', '...'), pass: set('#password', '...') };
})()
```

### 2.3 多标签陷阱
受管页只有一个。做 A 网站的事会把 B 网站挤掉。
所以：**每次操作前先 `/snapshot` 确认 `url` 的 host 是不是你以为的那个**，不是就先 `/open` 回去。

## 3. 站点配方

### 3.1 Outlook 网页（`outlook.cloud.microsoft`）
- 会话经常过期 → `/snapshot` 会返回 `login_required`
- 登录链路：Microsoft 页 → 填 `#i0116`/`#i0118` → **`#idSIButton9` 用 `/eval` 点**
- 验证码/2FA 一律交给人
- 读完邮件列表可以抓 `text`；需要结构化就用 `/eval` 取 `[role="option"]` 的 sender/subject/date

### 3.2 Canvas（`osu.instructure.com`，走 OSU SSO）
- 未登录会跳到 `webauth.service.ohio-state.edu`（**原生 Shibboleth**，不是 Microsoft）
  表单：`#username` / `#password` / `#j_private_yes`（私人设备选 Yes）/ `#submit`
- 但**有 Canvas 作业时**也可能走 `login.microsoftonline.com`（联邦到 Entra），
  那一页是 `#i0116` + `#i0118` + `#idSIButton9`（按钮文案会从 "Sign in" 变成 "Continue"）
- 答题页：`/courses/<cid>/quizzes/<qid>/take`
  · 题目容器 `.question`、题干 `.question_text`、选项 `.answers label`
  · 富文本作答区 `textarea` / `[contenteditable]` / `.mce-content-body`
- **同一时间只能开一份 attempt**：开第二份会仍停在第一份的 `/take` 页 →
  必须校验 `url` 里的 quizId 与请求一致，否则拒绝继续（不要串数据）

## 4. 与对话的关系

对话层通过工具调用使用本技能（见 `src/chat/tools.js`）：
`browser_open` / `browser_snapshot` / `browser_eval` / `canvas_read_quiz`。

模型**不应该**在没调用工具的情况下声称"我看不到" —— 它能查。
但如果工具返回 `needsUser`，正确回答是"需要你登录一下（附 noVNC 链接）"，而不是"我不知道"。
