/**
 * `/act {action:'type'}` 的输入策略测试。
 *
 * 要钉住的三件事（都是 2026-11-05 维护者/Lead 明确要求的）：
 *   1. click 成功 → 走老路（click 后 fill）
 *   2. click 失败（浮层遮挡等）→ **跳过 click 直接 fill**，并带 degraded / reason 标记
 *   3. click 与 fill 都失败才报错（且保留 pressSequentially 兜底给 contenteditable）
 * 另外：**日志里绝不能出现输入内容**（可能是密码）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { typeIntoLocator } from '../src/type-input.js';

/**
 * 假定位器：按 `behaviour` 决定每个方法成功/抛错，并记录调用顺序。
 * 抛出的错误信息带 "Timeout" 以模拟 Playwright 超时。
 */
function fakeLocator({ click = 'ok', fill = 'ok', press = 'ok' } = {}) {
  const calls = [];
  const behaviour = { click, fill, press };
  const attempt = (name) => {
    calls.push(name);
    if (behaviour[name] === 'throw') throw new Error(`${name}: Timeout 10000ms exceeded`);
    return undefined;
  };
  return {
    calls,
    async click() {
      return attempt('click');
    },
    async fill() {
      return attempt('fill');
    },
    async pressSequentially() {
      return attempt('press');
    },
  };
}

const collect = () => {
  const lines = [];
  return { lines, logger: (level, msg, extra) => lines.push({ level, msg, extra }) };
};

test('click + fill 都成功：走老路，不降级', async () => {
  const locator = fakeLocator();
  const { lines, logger } = collect();
  const result = await typeIntoLocator({ locator, text: 'hello', timeout: 1000, logger });

  assert.equal(result.ok, true);
  assert.equal(result.inputMode, 'fill');
  assert.equal(result.degraded, false);
  assert.equal(result.reason, undefined);
  assert.deepEqual(locator.calls, ['click', 'fill'], '顺序必须是先 click 再 fill');
  assert.deepEqual(lines, []);
});

test('click 被浮层挡住（超时）→ 跳过 click 直接 fill，带 degraded + reason', async () => {
  const locator = fakeLocator({ click: 'throw' });
  const { lines, logger } = collect();
  const result = await typeIntoLocator({ locator, text: 'user@example.com', timeout: 1000, logger });

  assert.equal(result.ok, true, 'click 失败不该让整个动作失败');
  assert.equal(result.inputMode, 'fill');
  assert.equal(result.degraded, true);
  assert.equal(result.reason, 'click_failed');
  assert.deepEqual(locator.calls, ['click', 'fill']);
  assert.ok(
    lines.some((l) => l.msg === 'type_click_failed_fallback_fill'),
    '应留一条结构化日志',
  );
});

test('click 成功但 fill 不支持（富文本）→ 退回逐字符输入', async () => {
  const locator = fakeLocator({ fill: 'throw' });
  const { lines, logger } = collect();
  const result = await typeIntoLocator({ locator, text: 'rich', timeout: 1000, logger });

  assert.equal(result.ok, true);
  assert.equal(result.inputMode, 'press');
  assert.equal(result.degraded, true);
  assert.equal(result.reason, 'fill_failed');
  assert.deepEqual(locator.calls, ['click', 'fill', 'press']);
  assert.ok(lines.some((l) => l.msg === 'type_fill_failed_press'));
});

test('click 与 fill 都失败但逐字符成功：仍算成功（降级）', async () => {
  const locator = fakeLocator({ click: 'throw', fill: 'throw', press: 'ok' });
  const result = await typeIntoLocator({ locator, text: 'x', timeout: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.inputMode, 'press');
  assert.equal(result.reason, 'click_failed', '原因优先记 click 失败');
  assert.deepEqual(locator.calls, ['click', 'fill', 'press']);
});

test('click + fill + press 全失败 → 返回错误（不抛异常，交给 HTTP 层映射）', async () => {
  const locator = fakeLocator({ click: 'throw', fill: 'throw', press: 'throw' });
  const result = await typeIntoLocator({ locator, text: 'x', timeout: 1000 });

  assert.equal(result.ok, false);
  assert.match(result.error, /press/);
  assert.equal(result.timedOut, true, '超时类错误要标记，HTTP 层据此回 408');
  assert.deepEqual(result.stages, ['click_failed', 'fill_failed', 'press_failed']);
});

test('可以清空输入（text 为空字符串）', async () => {
  const locator = fakeLocator();
  const result = await typeIntoLocator({ locator, text: '', timeout: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.inputMode, 'fill');
});

test('日志与返回值里都不出现输入内容（可能是密码）', async () => {
  const secret = 'S3CRET-PASSWORD-do-not-log';
  const locator = fakeLocator({ click: 'throw', fill: 'throw', press: 'throw' });
  const { lines, logger } = collect();
  const result = await typeIntoLocator({ locator, text: secret, timeout: 1000, logger });

  const everything = JSON.stringify({ result, lines });
  assert.ok(!everything.includes(secret), '输入内容绝不能出现在日志/返回值里');
  assert.match(everything, /click_failed/);
});

test('非超时类错误不标记 timedOut（HTTP 层会回 500 而不是 408）', async () => {
  const locator = {
    calls: [],
    async click() {
      throw new Error('Element is not an <input> element');
    },
    async fill() {
      throw new Error('Element is not an <input> element');
    },
    async pressSequentially() {
      throw new Error('Element is not an <input> element');
    },
  };
  const result = await typeIntoLocator({ locator, text: 'x', timeout: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
});
