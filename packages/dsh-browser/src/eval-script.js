/**
 * 在**页面上下文**里执行一段脚本，并把结果序列化回 Node —— `/eval` 的实现核心。
 *
 * 单独成模块的理由：它只依赖 `new Function` / `JSON` / `setTimeout`，这些在 Node 里
 * 同样存在，所以**不起浏览器也能单测**（见 test/evaluate.test.mjs）。
 * ⚠️ 改它时注意两件事：
 *   1. **不能闭包引用外部变量** —— Playwright 是把函数源码序列化后送进页面的，
 *      外部变量在页面里不存在（引用会直接 ReferenceError）。
 *   2. 返回值只能是纯 JSON 标量，页面里的怪值不能把协议层弄炸。
 *
 * 为什么包一层，而不是直接 `page.evaluate(script)`：
 *   1. 要精确区分「脚本抛错 / 结果不可序列化 / 超时」——直接 evaluate 时这三种
 *      都以 Playwright 异常的形式回来，消息里还带一坨调用日志，上层没法分支。
 *   2. 序列化在**页面里**做：JSON.stringify 会正确暴露循环引用、BigInt、Symbol
 *      这类不可序列化的东西，而 Playwright 自己的报错文案不稳定。
 *   3. 同时接受**表达式**（`(() => document.title)()`）与**语句**
 *      （`throw new Error('x')`）两种写法：先按表达式构造函数，语法不合法再退回
 *      语句块。⚠️ 只做"构造"不做"试跑"，所以同一段脚本绝不会执行两遍。
 *
 * @param {{src:string, timeoutMs:number, maxBytes:number}} args
 * @returns {Promise<{ok:boolean, json?:string, bytes?:number, truncated?:boolean,
 *   undefinedResult?:boolean, code?:string, error?:string, stack?:string, durationMs:number}>}
 */
export const evaluateInPage = async ({ src, timeoutMs, maxBytes }) => {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const describe = (value) =>
    String(value === undefined || value === null ? value : value.message ?? value);

  let fn;
  try {
    // 表达式形式：`(() => 1)()`、`document.title`
    // eslint-disable-next-line no-new-func
    fn = new Function(`"use strict"; return (${src});`);
  } catch (expressionError) {
    try {
      // 语句形式：`throw new Error('x')`、`const a = 1; a + 1`
      // eslint-disable-next-line no-new-func
      fn = new Function(`"use strict"; ${src}`);
    } catch (statementError) {
      return {
        ok: false,
        code: 'script_error',
        error: `脚本语法错误：${describe(statementError)}`,
        stack: '',
        durationMs: elapsed(),
      };
    }
  }

  try {
    let value = fn();
    // 允许直接传函数表达式（`() => 1`）：自动调用一次，省得调用方每次补 `()`
    if (typeof value === 'function') value = value();
    // 页面里的 Promise：在**页面内**等，并自带超时。否则一个永不 resolve 的
    // Promise 会让 Node 侧一直挂着，只能靠硬超时兜底（那时页面已经不可用了）。
    // ⚠️ 必须在"自动调用函数"**之后**再判 thenable —— `async () => …` 调用后
    //    才变成 Promise；早判的话会把它当普通对象 JSON 化成 `{}`（实测踩过）。
    if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
      value = await Promise.race([
        value,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`eval timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    }

    if (value === undefined) {
      return { ok: true, json: 'null', undefinedResult: true, durationMs: elapsed() };
    }

    let json;
    try {
      json = JSON.stringify(value);
    } catch (serializeError) {
      return {
        ok: false,
        code: 'not_serializable',
        error: `result not serializable: ${describe(serializeError)}`,
        stack: '',
        durationMs: elapsed(),
      };
    }
    if (json === undefined) {
      return {
        ok: false,
        code: 'not_serializable',
        error: 'result not serializable（JSON.stringify 返回 undefined，例如 Symbol）',
        stack: '',
        durationMs: elapsed(),
      };
    }

    const bytes = json.length;
    if (bytes > maxBytes) {
      // 截断后 **result 是一段字符串**（JSON 前缀），调用方不能再按 JSON 解析
      return { ok: true, truncated: true, json: json.slice(0, maxBytes), bytes, durationMs: elapsed() };
    }
    return { ok: true, json, bytes, durationMs: elapsed() };
  } catch (error) {
    const message = describe(error);
    const timedOut = /eval timeout after/i.test(message);
    return {
      ok: false,
      code: timedOut ? 'timeout' : 'script_error',
      error: timedOut ? `脚本超时（${timeoutMs}ms 内未完成）` : message,
      stack: typeof error?.stack === 'string' ? String(error.stack).split('\n').slice(0, 8).join('\n') : '',
      durationMs: elapsed(),
    };
  }
};
