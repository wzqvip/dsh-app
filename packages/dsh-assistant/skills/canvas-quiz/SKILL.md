# Canvas 作业 / Quiz 自动化

> 面向 **dsh-browser**（本项目的浏览器服务）的 Canvas 操作手册。
> 来源：整理自 `classpipe/.agents/skills/canvas-quiz-automation/SKILL.md` 与
> `classpipe/tools/auto_quiz_solver.py` 的实战经验，改写成我们这套接口的写法。

## 0. 铁律（先看这条）

| 动作 | 能否自动做 |
|---|---|
| 打开作业页、读题干 | ✅ 可以 |
| 在文本框里**写草稿** | ✅ 可以（但只是草稿，**不提交**） |
| 选择题自动勾选 | ✅ 可以（答案来自答案库或推理） |
| **点 Submit / 提交作业** | ❌ **必须先问人**，得到明确同意才提交 |

理由：提交是不可逆的（quiz 有次数限制、作业交了就算分）。草稿随便写，提交要人点头。

## 1. 可用接口

dsh-browser 在 `http://dsh-browser:8789`，头 `x-dsh-token`。

| 接口 | 用途 |
|---|---|
| `POST /open {url}` | 导航 |
| `POST /snapshot {}` | 取当前页可见文本 + `needsUser` 判定 |
| `POST /act {action:'click'\|'type'\|'waitFor', selector, text?, timeoutMs?}` | 单步操作 |
| `POST /eval {script}` | 在页面里跑 JS，返回结果（**读结构、批量勾选必须用它**） |

> `/eval` 缺失时，只能靠 `snapshot` 的纯文本 + 逐次 `act` 点击，慢且脆。
> 需要批量处理时优先用 `/eval`。

## 2. 流程 A：作业页 → 读要求 → 写草稿

```
1. /open  https://osu.instructure.com/courses/<cid>/assignments/<aid>
2. /eval  取标题 + 正文 + 截止 + 是否已提交
3. 生成草稿（LLM）
4. /act type 到正文编辑器（Canvas 用 contenteditable 或 textarea，见 §4）
5. **停下，等人确认后再提交**
```

读作业信息的 JS：

```js
(() => {
  const pick = (sel) => (document.querySelector(sel)?.innerText || '').trim();
  return {
    title: pick('h1'),
    dueText: pick('[data-testid="due-date"], .assignment-date-due, .date-due'),
    points: pick('.points_possible, [data-testid="points"]'),
    body: (document.querySelector('.user_content, #assignment_show .description')?.innerText || '').slice(0, 4000),
    submitted: /submitted!/i.test(document.body.innerText),
    url: location.href,
  };
})()
```

## 3. 流程 B：Canvas New Quizzes（Learnosity）

### 3.1 关键选择器

| 元素 | 选择器 | 备注 |
|---|---|---|
| 题目容器 | `fieldset`, `[role="group"]`, `.lrn_item` | **常有两层嵌套，会重复遍历** |
| 单/多选 | `input[type="radio"]`, `input[type="checkbox"]` | 点元素本身或 `label[for=id]` |
| 选项文本 | `label[for="..."]` | `innerText.trim()` |
| 提交按钮 | `button:has-text("Submit")`、`[data-automation="quiz-submit-btn"]` | |
| 二次确认 | `[role="dialog"]`, `.ReactModal__Content` | **必须再点一次 Submit** |
| 成绩 | `.result-score`, `[aria-label*="score"]` | 提交后等 1~3 秒 |
| 音频 iframe | `iframe[src*="media_attachments_iframe"]` | 里面能取到 **mediaId** |

### 3.2 用 mediaId 指纹命中答案（最可靠）

题目和选项都会被随机打乱，但**听力音频的 attachment id 与标准答案是固定绑定的**。
答案库在 `answers/tlielp-5050-media.json`（`mediaId -> 正确句子`）。

```js
// 读取每道题的 mediaId（题型：听力单选）
(() => {
  const out = [];
  document.querySelectorAll('fieldset, [role="group"]').forEach((g) => {
    const iframe = g.querySelector('iframe[src*="media_attachments_iframe"]');
    if (!iframe) return;
    const m = /media_attachments_iframe\/(\d+)/.exec(iframe.src);
    out.push({ mediaId: m ? m[1] : null, text: (g.innerText || '').slice(0, 120) });
  });
  return out;
})()
```

```js
// 按答案库勾选；按 name 分组，避免嵌套导致的重复点击
((answerMap) => {
  const byName = new Map();
  document.querySelectorAll('input[type="radio"]').forEach((r) => {
    if (!r.name) return;
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  });

  let picked = 0;
  for (const [, radios] of byName) {
    const group = radios[0].closest('fieldset, [role="group"]') || radios[0].closest('div');
    const iframe = group?.querySelector('iframe[src*="media_attachments_iframe"]');
    const m = iframe ? /media_attachments_iframe\/(\d+)/.exec(iframe.src) : null;
    if (!m) continue;
    const wanted = answerMap[m[1]];
    if (!wanted) continue;

    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const target = radios.find((r) => {
      const lbl = group.querySelector(`label[for="${r.id}"]`) || r.closest('label');
      const text = norm(lbl?.innerText);
      return text && (text.includes(norm(wanted).slice(0, 60)) || norm(wanted).includes(text));
    });
    if (target) { target.click(); picked++; }
  }
  return { picked, totalGroups: byName.size };
})(window.__ANSWER_MAP__)
```

### 3.3 提交（**必须先问人**）

```js
(() => {
  const btn = [...document.querySelectorAll('button, a')].find((b) => b.innerText.trim() === 'Submit');
  if (!btn) return { ok: false, reason: 'no submit button' };
  btn.click();
  setTimeout(() => {
    const modal = [...document.querySelectorAll('[role="dialog"] button, .ReactModal__Content button')]
      .find((b) => b.innerText.trim() === 'Submit');
    if (modal) modal.click();
  }, 500);
  return { ok: true };
})()
```

## 4. 避坑清单（都是踩过的）

1. **嵌套容器重复点击**：`querySelectorAll('[role="group"], fieldset')` 会把同一题遍历两次，
   后一次会把前一次的正确选择**覆盖掉**。→ 按 `input[name]` 分组，每组只点一次。
2. **两步提交**：外层 Submit 后 300~500ms 才弹对话框，必须再点一次，否则不算提交。
3. **音频没上传的题**：页面显示 `INSERT MEDIA HERE`，需要单独匹配句子。
4. **页面内部滚动容器**：`window.scrollBy` 可能无效，要对 `.pageContent` 之类滚动容器滚动。
5. **最高分保留**：Canvas 默认取所有 attempt 的最高分，多轮不会扣分（但**次数有限**，别乱交）。
6. **编辑器类型**：Canvas 富文本是 `contenteditable`（`.mce-content-body` / `[contenteditable="true"]`），
   `textarea` 只用于纯文本作业。写草稿前先 `snapshot` 确认是哪一种。

## 5. 答案库

| 文件 | 内容 | 来源 |
|---|---|---|
| `answers/tlielp-5050-media.json` | `mediaId -> 正确句子`（34 条） | `classpipe/data/media_map_419.json`（2026-11-03，人工/LLM 整理后验证 100%） |

用法：`/eval` 时把整个 JSON 作为参数注入（`window.__ANSWER_MAP__`），不要每次都从磁盘读。

**注意**：这类答案只对**同一份 quiz 的同一批题**有效。课程更新题目后要重新建立映射。
