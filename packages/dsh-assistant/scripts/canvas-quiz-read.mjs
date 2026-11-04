/**
 * 读取 Canvas quiz / survey 的题目，并写进缓存供对话使用。
 *
 * 为什么要"读一次 → 落缓存"：
 *   维护者问「quiz 题目看了吗」时，对话层（/chat）里没有任何浏览器能力，
 *   于是模型只能回答"我看不到题目"——可实际上我们**能**读到。
 *   把读到的东西落盘并注入对话上下文，才能让"我看不到"这类回答消失。
 *
 * 用法：
 *   node scripts/canvas-quiz-read.mjs --course 220921 --quiz 1503007
 *   node scripts/canvas-quiz-read.mjs --url https://osu.instructure.com/courses/220921/quizzes/1503008
 *
 * 安全：只读，**绝不提交**（不点 Submit Quiz）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { actOnBrowser, snapshotBrowser } from '../src/browser/client.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const dataDir = dirname(arg('state', '/data/state.json'));
const cachePath = arg('cache', join(dataDir, 'canvas-cache.json'));
const tokenPath = arg('token-file', '/data/token.txt');
const baseUrl = arg('browser', process.env.DSH_BROWSER_BASE ?? 'http://dsh-browser:8789');

const courseId = arg('course', '220921');
const quizId = arg('quiz', null);
const urlArg = arg('url', null);

if (!quizId && !urlArg) {
  console.error('[quiz-read] 需要 --quiz <id> 或 --url <url>');
  process.exit(2);
}

const quizUrl = urlArg ?? `https://osu.instructure.com/courses/${courseId}/quizzes/${quizId}`;
const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snap = () => snapshotBrowser({ baseUrl, token });
const act = (action, payload) => actOnBrowser({ baseUrl, token, action, ...payload });

async function evalScript(script, timeoutMs = 15_000) {
  const response = await fetch(`${baseUrl}/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-dsh-token': token } : {}) },
    body: JSON.stringify({ script, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error ?? `eval HTTP ${response.status}`);
  }
  return body.result;
}

console.log(`[quiz-read] 打开 ${quizUrl}`);
// 先清场：受管页可能还停在上一份 quiz 的 /take 页，直接 goto 会"看起来没导航"
await act('open', { url: 'about:blank' });
await sleep(1_200);
await act('open', { url: quizUrl });
await sleep(6_000);

let page = await snap();
let host = '';
try {
  host = new URL(page?.url ?? '').host;
} catch {
  /* ignore */
}
if (host && host !== 'osu.instructure.com') {
  console.error(`[quiz-read] ❌ 页面在 ${host}，不是 Canvas（可能是登录页）`);
  console.error(`[quiz-read]    ${String(page?.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
  process.exit(3);
}

// 如果在 quiz 详情页，需要点 Take the Survey 进入答题页
if (!/\/take/.test(String(page?.url ?? ''))) {
  // 按钮文案实测有四种：Take the Survey / Take the Quiz / Resume Survey / Resume Quiz
  const clicked = await evalScript(`(() => {
    const b = [...document.querySelectorAll('a,button')].find((x) =>
      /take the (survey|quiz)|resume (survey|quiz)|begin (survey|quiz)/i.test((x.innerText || '').trim())
    );
    if (!b) return { clicked: false };
    const href = b.getAttribute('href') || '';
    b.click();
    return { clicked: true, text: (b.innerText || '').trim(), href };
  })()`);
  console.log(`[quiz-read] 点进入答题页：${JSON.stringify(clicked)}`);
  await sleep(10_000);
  page = await snap();
}

// 结构化提取题目（旧版 Canvas Quiz DOM；新版会走 else 分支用纯文本兜底）
const extracted = await evalScript(`(() => {
  const uniq = (arr) => [...new Set(arr.map((s) => s.replace(/\\s+/g, ' ').trim()).filter(Boolean))];
  const questions = [...document.querySelectorAll('.question')].map((q, i) => {
    const prompt = (q.querySelector('.question_text')?.innerText || '').trim();
    const name = (q.querySelector('.question_name')?.innerText || '').trim();
    // 只从 .answers 里取 label（原来同时选 .answer 会把每个选项算两遍）
    const answers = uniq(
      [...q.querySelectorAll('.answers label, .answers .answer')].map((l) => l.innerText || ''),
    );
    const hasChoice = !!q.querySelector('input[type="radio"], input[type="checkbox"]');
    const hasEditor = !!q.querySelector('textarea, [contenteditable="true"], .mce-content-body');
    return {
      index: i + 1,
      name,
      prompt: prompt.slice(0, 1200),
      // 有选项就按选择题算 —— 富文本编辑器在同一个 .question 里也可能出现，别被它带偏
      type: hasChoice ? 'choice' : hasEditor ? 'essay' : answers.length > 0 ? 'choice' : 'unknown',
      answers: answers.slice(0, 10),
    };
  });
  return {
    url: location.href,
    title: document.title,
    questionCount: questions.length,
    questions,
  };
})()`);

// ⚠️ 必须确认真的读到了「这一次请求的那个 quiz」。
// 踩过：/open 1503008 之后页面仍停留在 1503007/take，结果把 Shen 的题存进了 Hirsch 的缓存。
const wantedId = quizUrl.match(/quizzes\/(\d+)/)?.[1] ?? null;
const actualUrl = String(extracted?.url ?? page?.url ?? '');
const actualId = actualUrl.match(/quizzes\/(\d+)/)?.[1] ?? null;

if (wantedId && actualId && wantedId !== actualId) {
  console.error(`[quiz-read] ❌ 读到的不是请求的 quiz：want=${wantedId} actual=${actualId}`);
  console.error(`[quiz-read]    pageUrl=${actualUrl}`);
  console.error('[quiz-read]    不写入缓存（避免串数据）。请重跑，或先 /open about:blank 再试。');
  process.exit(4);
}


const result = {
  readAt: new Date().toISOString(),
  quizUrl,
  pageUrl: extracted?.url ?? page?.url ?? null,
  title: extracted?.title ?? page?.title ?? null,
  questionCount: extracted?.questionCount ?? 0,
  questions: extracted?.questions ?? [],
  // 纯文本兜底：结构没抽到时，至少把可见文本留着
  textHead: String(page?.text ?? '').slice(0, 3000),
  submitted: false,
};

const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const key = quizUrl;
cache[key] = result;
cache.lastKey = key;
writeFileSync(cachePath, JSON.stringify(cache, null, 2));

console.log(
  `[quiz-read] ✅ ${result.title}  题目数=${result.questionCount}  → 已写入 ${cachePath}`,
);
for (const q of result.questions) {
  console.log(`   Q${q.index}（${q.type}）${q.prompt.replace(/\s+/g, ' ').slice(0, 90)}`);
  if (q.answers?.length) console.log(`       选项：${q.answers.join(' / ')}`);
}
if (result.questionCount === 0) {
  console.log('   ⚠️ 没抽到结构化题目，已保留纯文本兜底（textHead）');
  if (has('verbose')) console.log(result.textHead);
}
