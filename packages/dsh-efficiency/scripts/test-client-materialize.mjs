/**
 * 在 Node 里模拟浏览器的模块系统，验证 lib/client.js 的【两个插件都能实例化】。
 *
 * 为什么需要它：宿主半侧可以在沙箱里端到端验证（HTTP 200），但客户端半侧
 * 只在浏览器里跑。这个脚本补上"客户端 bundle 是否真的能装载"这一环 ——
 * 它不验渲染（那需要真浏览器），但能确认：
 *   - 两个 load 都提交了 id 与 factory
 *   - 两个 factory 都能被 require 真正实例化出 { name, inject, apply }
 *   - 效率助手的 apply 能在 mock ctx 上跑通
 *
 * 用法：node scripts/test-client-materialize.mjs [client.js 路径]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const clientPath = process.argv[2] ?? join(pkgRoot, 'lib', 'client.js');

if (!existsSync(clientPath)) {
  console.error(`[materialize] 找不到 ${clientPath} —— 先跑构建`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};

// ---- 浏览器环境最小替身 ----
// DOM 用"万能对象"：任何属性访问返回可调用/可继续取属性的代理，
// 让客户端代码可以跑过 DOM 构造而不必实现整套 DOM。
function makeFake() {
  const fn = function () { return makeFake(); };
  return new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === 'toString') return () => '[fake]';
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'length') return 0;
      if (prop === 'classList') return { add() {}, remove() {}, contains: () => false };
      if (prop === 'style') return {};
      if (prop === 'dataset') return {};
      return makeFake();
    },
    apply: () => makeFake(),
    construct: () => makeFake(),
    set: () => true,
  });
}

const loads = [];
globalThis.window = {
  __ModuleLoader__: { load: (o) => loads.push(o) },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (f) => setTimeout(f, 0),
  clearTimeout: (t) => clearTimeout(t),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
globalThis.document = makeFake();
// ⚠️ Node 24 的 navigator 是只读 getter（直接赋值抛 TypeError），必须用 defineProperty
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node', platform: 'node', language: 'zh-CN' },
  configurable: true,
  writable: true,
});
globalThis.location = { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);

// ---- 装载 bundle ----
console.log('[materialize] 1) 加载客户端 bundle');
const require_ = createRequire(import.meta.url);
try {
  require_(clientPath);
} catch (err) {
  check('bundle 可执行', false, String(err).split('\n')[0]);
  process.exit(1);
}
check('bundle 可执行', true);
check('提交了两次 load（两个插件）', loads.length === 2, `实际 ${loads.length}`);
for (const l of loads) {
  check(`load ${l.id} 有 id 与 factory`, typeof l.id === 'string' && typeof l.factory === 'function');
}

// ---- react 替身（factory 的 require 会取它）----
const hookState = [];
const mockRequire = (m) => {
  if (m === 'react') {
    return {
      createElement: () => ({}),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useCallback: (f) => f,
      useMemo: (f) => f(),
      useRef: () => ({ current: null }),
      useContext: () => ({}),
      Fragment: 'Fragment',
    };
  }
  if (m === 'react/jsx-runtime') {
    return { jsx: () => ({}), jsxs: () => ({}), Fragment: 'Fragment' };
  }
  throw new Error(`unexpected require: ${m}`);
};

// ---- 两个 factory 都要能实例化 ----
console.log('[materialize] 2) 两个 factory 实例化');
const mods = new Map();
for (const l of loads) {
  try {
    const mod = l.factory(mockRequire);
    mods.set(l.id, mod);
    check(
      `${l.id} → { name, inject, apply }`,
      typeof mod?.name === 'string' && Array.isArray(mod?.inject) && typeof mod?.apply === 'function',
      `name=${mod?.name} inject=${JSON.stringify(mod?.inject)}`,
    );
  } catch (err) {
    check(`${l.id} 实例化不抛错`, false, String(err).split('\n').slice(0, 2).join(' | '));
  }
}
void hookState;

// ---- 效率助手的 apply（有答案面板与设置项，最值得验）----
console.log('[materialize] 3) 效率助手 apply(ctx)');
const own = [...mods.entries()].find(([id]) => id === 'dsh-efficiency')?.[1];
if (!own) {
  check('找到效率助手模块', false);
} else {
  const registered = [];
  const ctx = {
    effect(fn) { try { return fn() || (() => {}); } catch { return () => {}; } },
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
    locale: {
      register: () => {},
      // ⚠️ 真实的 ctx.locale 有 bind()（插件用它绑定命名空间），mock 漏了会误报
      //    "ctx.locale.bind is not a function"（踩过）
      bind: () => ({ register: () => {}, t: (k) => k }),
      t: (k) => k,
    },
    slots: {
      // slots.inject 收到的是 generator：要把 yield 出来的句柄收集起来
      // （照 scripts/smoke-client.mjs 的正确实现，别自己发明 —— 踩过）
      inject(slotName, gen) {
        const it = gen();
        let r = it.next();
        while (!r.done) {
          registered.push({ slotName, handle: r.value });
          r = it.next();
        }
        return () => {};
      },
      register: (spec) => ({ spec }),
    },
    remote: { $on: () => () => {}, userQuestions: { attachWait: async () => ({ done: true }) } },
    settings: { register: () => () => {} },
  };
  try {
    own.apply(ctx);
    check('apply 不抛错', true);
    check('注册了插槽', registered.length >= 1, `注册 ${registered.length} 项`);
  } catch (err) {
    check('apply 不抛错', false, String(err).split('\n').slice(0, 2).join(' | '));
  }
}

console.log('');
if (failures === 0) {
  console.log('[materialize] PASS');
} else {
  console.log(`[materialize] FAIL: ${failures} 项未通过`);
  process.exit(1);
}
void pathToFileURL;
