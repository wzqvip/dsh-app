/**
 * 客户端 bundle 冒烟测试 —— 模拟浏览器的 __ModuleLoader__ 契约。
 *
 * 为什么必须有这个测试：
 *   已经踩过一次坑 —— build.mjs 在外层硬编码了 `module.exports = { apply, inject, name }`，
 *   但 apply/inject/name 定义在 makeFactory() 的闭包内部，外层作用域根本没有这些变量。
 *   结果是浏览器加载插件时抛 `ReferenceError: apply is not defined`，**整个 Web 引导失败**。
 *   `node --check` 只验语法，查不出这种作用域错误。
 *
 * 本测试覆盖：
 *   1. 执行 lib/client.js 时会调用 window.__ModuleLoader__.load（且带上正确的 id）
 *   2. factory 能被调用，并返回含 apply/inject/name 的模块
 *   3. apply(ctx) 能在 mock ctx 上跑完，并完成预期的槽位注册
 *
 * 用法：node scripts/smoke-client.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const clientPath = join(pkgRoot, 'lib', 'client.js');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

let failures = 0;
const check = (label, cond, extra = '') => {
  const mark = cond ? '✅' : '❌';
  console.log(`  ${mark} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};

// ---- 1) 捕获 load() ----
// ⚠️ 现在**只有一次** load。曾经是两个（效率助手 + 桌宠各一次），但那行不通：
//    客户端 boot 清单里每个包只对应一个客户端模块 id，第二个 id 永远不会被物化
//    （实测：它的 factory 一次都没被调用，而且不报错）。
//    现在桌宠作为【库】由 app.js 引入，在这一个插件里一并 apply。
//    所以这里同时断言"只有一个 load"，防止有人又走回多 id 那条死路。
const loads = [];
globalThis.window = {
  __ModuleLoader__: {
    load: (o) => {
      loads.push(o);
    },
  },
};

// client.js 是 CJS 风格的副作用脚本（用 require 由 factory 取依赖）
const require_ = createRequire(import.meta.url);
require_(clientPath);

console.log('[smoke] 1) 模块加载');
check('调用了 __ModuleLoader__.load', loads.length > 0);
if (loads.length === 0) {
  console.error('\nFAIL: lib/client.js 没有调用 window.__ModuleLoader__.load');
  process.exit(1);
}
check('只注册一个插件（一个客户端模块只能出一个）', loads.length === 1, `实际 ${loads.length} 个`);
for (const l of loads) {
  check(`注册 ${l.id}: factory 是函数`, typeof l.factory === 'function');
}

// 取那唯一的一个
const loaded = loads.find((l) => l.id === pkg.name);
check('id 等于包的 npm 名', !!loaded, loaded ? loaded.id : `候选: ${loads.map((l) => l.id).join(', ')}`);
if (!loaded) {
  console.error('\nFAIL: 没有找到 id 为包名的插件注册');
  process.exit(1);
}

// ---- 2) 调用 factory ----
console.log('[smoke] 2) factory(require)');
const mockRequire = (m) => {
  if (m === 'react') {
    return {
      useEffect() {},
      useState() { return [null, () => {}]; },
      useCallback(f) { return f; },
      useMemo(f) { return f(); },
      useRef() { return { current: null }; },
    };
  }
  if (m === 'react/jsx-runtime') return { jsx: (...args) => ({ args }), jsxs: (...args) => ({ args }), Fragment: 'F' };
  throw new Error(`unexpected require: ${m}`);
};

let mod = null;
try {
  mod = loaded.factory(mockRequire);
} catch (err) {
  check('factory 调用不抛错', false, String(err));
}
if (mod) {
  check('返回 apply 函数', typeof mod.apply === 'function');
  check('返回 inject 数组', Array.isArray(mod.inject), JSON.stringify(mod.inject));
  check('返回 name 字符串', typeof mod.name === 'string', String(mod.name));
}

// 桌宠现在作为【库】被 app.js 引入并一并 apply，
// 所以它的可用性由下面第 3 步的"注册了 4 个槽位"来验证（宠物 2 + 本插件 2），
// 不再有独立的 factory 可调。

// ---- 3) 在 mock ctx 上跑 apply ----
// 注意：本文件是 CJS（用 require 加载产物），不能用顶层 await，
// 所以这一段包在 async IIFE 里。
console.log('[smoke] 3) apply(ctx)');
if (mod && typeof mod.apply === 'function') {
  const registrations = [];
  const remoteSubscriptions = [];
  const mockCtx = {
    effect(fn) { return fn(); },
    locale: { register() {}, bind: () => (k) => k },
    // 客户端 Remote 层：官方 UI 用它订阅 agent-scoped waterfall（见 research/11）。
    sessions: { scopeOf: () => 'session-smoke' },
    remote: {
      $on(event, listener) {
        remoteSubscriptions.push({ event, listener });
        return () => {};
      },
      userQuestions: {
        // attachWait 的替身：返回一个异步迭代器，首个 next() 表示"认领成功"
        attachWait() {
          let n = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  n += 1;
                  // 第一次 → 认领成功（未 done，带 remainingMs）；之后 → 窗口结束
                  return n === 1 ? { done: false, value: { remainingMs: 60000 } } : { done: true };
                },
                return: async () => ({ done: true }),
              };
            },
            dispose() {},
          };
        },
      },
    },
    slots: {
      // slots.inject 收到的是 generator：要把 yield 出来的句柄收集起来
      inject(slotName, gen) {
        const it = gen();
        let r = it.next();
        while (!r.done) {
          registrations.push({ slotName, handle: r.value });
          r = it.next();
        }
      },
      register(opts) { return { opts }; },
    },
  };
  try {
    globalThis.__smokeErrors = [];
    const origError = console.error;
    console.error = (...a) => { globalThis.__smokeErrors.push(a.map(String).join(' ')); origError(...a); };
    try {
      mod.apply(mockCtx);
      check('apply 执行不抛错', true);
    } finally {
      console.error = origError;
    }
  } catch (err) {
    check('apply 执行不抛错', false, String(err));
  }
  // 关键断言：apply 期间**不能有错误日志**。
  // 这条能抓住"apply 中途抛错但被框架吞掉"的情形 ——
  // 实测抓到过一个 ReferenceError: t is not defined，它导致整个插件没装配、
  // 面板完全不出现，而只检查"apply 没抛"是发现不了的。
  const errs = globalThis.__smokeErrors ?? [];
  check('apply 期间无错误日志', errs.length === 0, errs.length ? errs.join(' | ').slice(0, 300) : '');
  check('完成了槽位注册', registrations.length > 0, `注册 ${registrations.length} 个`);
  const slots = registrations.map((r) => r.slotName).join(', ');
  check('注册到预期槽位', slots.includes('shell.overlay') && slots.includes('settings.section'), slots);

  await (async () => {
    // answerer 契约：必须注册到 remote waterfall
    check('answerer 订阅了 remote 事件', remoteSubscriptions.length === 1, `订阅 ${remoteSubscriptions.length} 个`);
    const sub = remoteSubscriptions[0];
    if (!sub) return;
    check('订阅的是 user-questions/request', sub.event === 'user-questions/request', sub.event);

    const mkRequest = (id) => ({
      wait: { callId: id, timed: true },
      questions: [{ id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }],
    });

    // (a) 面板未挂载（bridge 无 receiver）→ 必须让位，绝不能吞掉提问
    {
      let nextCalled = 0;
      const r = await sub.listener(mkRequest('smoke-nopanel'), async () => { nextCalled += 1; return { answers: [] }; });
      check('[无面板] 让位给官方', nextCalled === 1, `next 调用 ${nextCalled} 次`);
      check('[无面板] 透传 next 结果', !!r && Array.isArray(r.answers));
    }

    // (b) 面板已挂载 + 用户作答 → 必须返回答案，且不调用 next
    {
      // 直接取组件注册的渲染函数来挂载面板不可行（需要 React），
      // 所以这里用 bridge 的公开契约：模拟面板注册接收器并作答。
      // 通过 apply 内部创建的 bridge 无法直接拿到 —— 改为验证未挂载路径已足够，
      // 挂载路径由真实浏览器验证（见 research/11 的验证计划）。
      const diag = globalThis.__DSH_EFFICIENCY__;
      check('诊断计数已发生', !!diag && diag.seen >= 1, `seen=${diag?.seen}`);
      check('诊断记录了最近一次提问', !!diag?.last?.callId, diag?.last?.callId);
    }
  })();
} else {
  check('可执行 apply', false, 'apply 缺失，跳过');
}

console.log('');
if (failures === 0) {
  console.log('[smoke] PASS');
  process.exit(0);
} else {
  console.error(`[smoke] FAIL: ${failures} 项未通过`);
  process.exit(1);
}
