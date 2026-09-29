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
let loaded = null;
globalThis.window = { __ModuleLoader__: { load: (o) => { loaded = o; } } };

// client.js 是 CJS 风格的副作用脚本（用 require 由 factory 取依赖）
const require_ = createRequire(import.meta.url);
require_(clientPath);

console.log('[smoke] 1) 模块加载');
check('调用了 __ModuleLoader__.load', loaded !== null);
if (!loaded) {
  console.error('\nFAIL: lib/client.js 没有调用 window.__ModuleLoader__.load');
  process.exit(1);
}
check('id 等于包的 npm 名', loaded.id === pkg.name, `${loaded.id} === ${pkg.name}`);
check('factory 是函数', typeof loaded.factory === 'function');

// ---- 2) 调用 factory ----
console.log('[smoke] 2) factory(require)');
const mockRequire = (m) => {
  if (m === 'react') {
    return {
      useEffect() {},
      useState() { return [null, () => {}]; },
      useCallback(f) { return f; },
      useRef() { return { current: null }; },
    };
  }
  if (m === 'react/jsx-runtime') return { jsx: (...args) => ({ args }) };
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

// ---- 3) 在 mock ctx 上跑 apply ----
console.log('[smoke] 3) apply(ctx)');
if (mod && typeof mod.apply === 'function') {
  const registrations = [];
  const mockCtx = {
    effect(fn) { return fn(); },
    locale: { register() {}, bind: () => (k) => k },
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
    mod.apply(mockCtx);
    check('apply 执行不抛错', true);
  } catch (err) {
    check('apply 执行不抛错', false, String(err));
  }
  check('完成了槽位注册', registrations.length > 0, `注册 ${registrations.length} 个`);
  const slots = registrations.map((r) => r.slotName).join(', ');
  check('注册到预期槽位', slots.includes('shell.overlay') && slots.includes('settings.section'), slots);
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
