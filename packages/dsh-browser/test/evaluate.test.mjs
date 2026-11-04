/**
 * `evaluateInPage` 的直接单测 —— 这是 `/eval` 真正干活的那段代码。
 *
 * 为什么能不起浏览器就测：这段函数只依赖 `new Function` / `JSON` / `setTimeout`，
 * 在 Node 里同样存在；Playwright 把它序列化到页面里执行，语义一致。
 * （所以它必须**不闭包引用外部变量**，改代码时注意。）
 *
 * 这里钉住的是契约最容易坏的地方：
 *   - 表达式 vs 语句两种写法；
 *   - `async () => …` 自动调用后**必须 await**（否则 JSON 化成 `{}`，实测踩过）；
 *   - 抛错 / 不可序列化 / 超时 三类失败的 code 不同；
 *   - 超过 maxBytes 时截断并给 bytes，而不是把响应撑爆。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateInPage } from '../src/eval-script.js';

const run = (src, overrides = {}) => evaluateInPage({ src, timeoutMs: 1_000, maxBytes: 64 * 1024, ...overrides });

test('表达式：普通对象结果', async () => {
  const out = await run('(() => ({ title: "Example Domain", n: 2 }))()');
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(out.json), { title: 'Example Domain', n: 2 });
  assert.equal(typeof out.durationMs, 'number');
});

test('表达式：不带自调用也能求值（1 + 2）', async () => {
  const out = await run('1 + 2');
  assert.equal(out.ok, true);
  assert.equal(JSON.parse(out.json), 3);
});

test('函数表达式：自动调用一次（() => 42）', async () => {
  const out = await run('() => 42');
  assert.equal(out.ok, true);
  assert.equal(JSON.parse(out.json), 42);
});

test('语句形式：throw new Error("x") → script_error，error 就是 x', async () => {
  const out = await run("throw new Error('x')");
  assert.equal(out.ok, false);
  assert.equal(out.code, 'script_error');
  assert.equal(out.error, 'x');
  assert.match(out.stack, /Error: x/);
});

test('语句形式：多行语句块也能跑', async () => {
  const out = await run('const a = 40; const b = 2; return a + b;');
  assert.equal(out.ok, true);
  assert.equal(JSON.parse(out.json), 42);
});

test('语法错误 → script_error，且文案可读', async () => {
  const out = await run('(() => {');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'script_error');
  assert.match(out.error, /脚本语法错误/);
});

test('async 函数：结果会被 await（不是 JSON 成 {}）', async () => {
  const out = await run('async () => { await new Promise((r) => setTimeout(r, 20)); return "late"; }');
  assert.equal(out.ok, true);
  assert.equal(JSON.parse(out.json), 'late');
});

test('Promise 直接返回也会被 await', async () => {
  const out = await run('Promise.resolve({ a: 1 })');
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(out.json), { a: 1 });
});

test('Promise 永远不 resolve → code=timeout（页面里的定时器兜住）', async () => {
  const started = Date.now();
  const out = await run('async () => { await new Promise(() => {}); return 1; }', { timeoutMs: 120 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'timeout');
  assert.match(out.error, /脚本超时/);
  assert.ok(Date.now() - started < 2_000, '不应该等满整个超时窗口之外的时间');
});

test('Promise reject → script_error（原样带回消息）', async () => {
  const out = await run('async () => { throw new Error("boom"); }');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'script_error');
  assert.equal(out.error, 'boom');
});

test('循环引用 → not_serializable', async () => {
  const out = await run('(() => { const a = {}; a.self = a; return a; })()');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not_serializable');
  assert.match(out.error, /not serializable/);
});

test('BigInt → not_serializable（JSON.stringify 抛错）', async () => {
  const out = await run('(() => 10n)()');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not_serializable');
});

test('Symbol → not_serializable（JSON.stringify 返回 undefined）', async () => {
  const out = await run('Symbol("s")');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not_serializable');
});

test('undefined → ok + undefinedResult，json 是 "null"', async () => {
  const out = await run('(() => undefined)()');
  assert.equal(out.ok, true);
  assert.equal(out.undefinedResult, true);
  assert.equal(out.json, 'null');
});

test('超过 maxBytes → truncated，json 截到 maxBytes，bytes 是原始长度', async () => {
  const out = await run('(() => "x".repeat(500))()', { maxBytes: 100 });
  assert.equal(out.ok, true);
  assert.equal(out.truncated, true);
  assert.equal(out.json.length, 100);
  assert.equal(out.bytes, 502); // 500 个 x + 两个引号
});

test('刚好等于 maxBytes 不截断', async () => {
  const out = await run('(() => "x".repeat(98))()', { maxBytes: 100 });
  assert.equal(out.ok, true);
  assert.equal(out.truncated, undefined);
  assert.equal(out.json.length, 100);
});

