/**
 * 把 vendor 的 dsh-pet **客户端**半侧打成一份可挂进我们 bundle 的 JS。
 *
 * 为什么同样不需要 tsdown（已实测）：
 *   - 27 个文件（client 6 + shared 21）里**没有 JSX**，全部用显式 h() 调用
 *     → Node 内置的类型剥离就够，不需要 JSX 转换
 *   - 外部依赖只有 `react` 与 `react/jsx-runtime`，两者都在 DSH 浏览器外壳的
 *     静态模块表里 → 由 factory 的 require 提供，不需要 node_modules
 *   - 其余 `node:*` 依赖全部来自 `*.test.ts` → 构建时跳过
 *
 * 与宿主打包器的差异：
 *   - 宿主产物是【模块】（export），客户端产物是【一段注入脚本】；
 *     所以我们导出一个 `__petFactory(require)` 供 build.mjs 组合，
 *     而不是自己调用 window.__ModuleLoader__.load
 *   - 裸模块 import 改写成 `require('react')`（浏览器模块表），
 *     而不是 createRequire（Node）
 *
 * 用法：node scripts/build-client-vendor.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const vendorRoot = join(pkgRoot, 'build', 'vendor');
// 打包入口用 app.ts 而不是 index.ts：client/index.ts 是【副作用脚本】，
// 它自己调用 window.__ModuleLoader__.load 完成自注册；而一个 id 只能 load 一次，
// 我们要把宠物与效率助手组合进同一个 factory，所以改由 build.mjs 统一 load。
// app.ts 才是干净导出 makeFactory 的那个模块。
const entry = join(vendorRoot, 'client', 'app.ts');
const outFile = join(pkgRoot, 'build', 'client-vendor.js');

if (!existsSync(entry)) {
  console.error(`[client-vendor] 找不到入口: ${entry}`);
  console.error('[client-vendor] 先跑 node scripts/build-vendor.mjs');
  process.exit(1);
}

const warnings = [];
const relOf = (f) => f.replace(vendorRoot, '').replace(/\\/g, '/');

/** 相对 import 解析（client 与 shared 两个目录都允许） */
function resolveRel(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && cand.endsWith('.ts')) return cand;
  }
  return null;
}

const IMPORT_STMT = new RegExp(
  String.raw`\bimport\s+(?:type\s+)?` +
    String.raw`((?:\*\s*as\s+[A-Za-z_$][\w$]*|\{[^}]*\}|[A-Za-z_$][\w$]*)` +
    String.raw`(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*))?)` +
    String.raw`\s+from\s*['"]([^'"]+)['"]\s*;?`,
  'g',
);

const depsOf = new Map(); // abs -> string[]

function collect(file, source) {
  const deps = [];
  let m;
  const re = new RegExp(IMPORT_STMT.source, 'g');
  while ((m = re.exec(source)) !== null) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const abs = resolveRel(file, spec);
    if (abs) deps.push(abs);
    else warnings.push(`${relOf(file)}: 无法解析 ${spec}`);
  }
  depsOf.set(file, deps);
  return deps;
}

// DFS 收集（跳过测试文件）
const order = [];
const visited = new Set();
function visit(file) {
  if (visited.has(file)) return;
  if (/\.test\.ts$/.test(file)) return;
  visited.add(file);
  const src = readFileSync(file, 'utf8');
  for (const d of collect(file, src)) visit(d);
  order.push(file);
}
visit(entry);

const varNameOf = new Map();
order.forEach((f, i) => varNameOf.set(f, `__c${i}`));

/** 把 import 改写成 CommonJS 赋值：相对 → 取 IIFE 成员；裸模块 → factory 的 require */
function transform(file) {
  let code = readFileSync(file, 'utf8');

  code = code.replace(IMPORT_STMT, (whole, rawClause, spec) => {
    const clause = rawClause.trim();
    if (/^type\b/.test(whole.replace(/^import\s+/, ''))) return '';

    const isRel = spec.startsWith('.');
    const abs = isRel ? resolveRel(file, spec) : null;
    let ref;
    if (isRel) {
      if (!abs || !varNameOf.has(abs)) return `/* [client-vendor] 未解析: ${spec} */`;
      ref = varNameOf.get(abs);
    } else {
      // 浏览器模块表：直接用 factory 的 require
      ref = `__ext_${spec.replace(/[^\w]/g, '_')}`;
    }
    const pre = isRel ? '' : `const ${ref} = require(${JSON.stringify(spec)}); `;

    const parts = [];
    if (!/^\*/.test(clause)) {
      const defM = clause.match(/^([A-Za-z_$][\w$]*)/);
      if (defM) parts.push(`const ${defM[1]} = ${ref}.default ?? ${ref};`);
    }
    const starM = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (starM) parts.push(`const ${starM[1]} = ${ref};`);
    const braceM = clause.match(/\{([^}]*)\}/);
    if (braceM) {
      for (const p of braceM[1].split(',').map((s) => s.trim()).filter(Boolean).filter((s) => !/^type\s/.test(s))) {
        const as = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        parts.push(as ? `const ${as[2]} = ${ref}.${as[1]};` : `const ${p} = ${ref}.${p};`);
      }
    }
    if (parts.length === 0) return pre.trimEnd() || '';
    return `${pre}${parts.join(' ')}`;
  });

  // 副作用 import
  code = code.replace(/\bimport\s*['"]([^'"]+)['"]\s*;?/g, (whole, spec) => {
    if (!spec.startsWith('.')) return `require(${JSON.stringify(spec)});`;
    const abs = resolveRel(file, spec);
    return abs && varNameOf.has(abs) ? `${varNameOf.get(abs)};` : '/* [client-vendor] 未解析副作用 import */';
  });

  // export → 收集 + 去掉关键字（与宿主打包器同一套策略，含 async 保留）
  const exported = new Set();
  code = code
    .replace(
      /^(\s*)export\s+((?:async\s+)?)(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
      (m, indent, asyncKw, kind, n) => {
        exported.add(n);
        return `${indent}${asyncKw}${kind} ${n}`;
      },
    )
    .replace(/^(\s*)export\s+(interface|type|declare)\s+/gm, '$1$2 ')
    .replace(/^(\s*)export\s*\{([^}]*)\}\s*;?/gm, (m, indent, names) => {
      for (const part of names.split(',')) {
        const p = part.trim();
        if (!p || /^type\s/.test(p)) continue;
        const as = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        exported.add(as ? as[2] : p);
      }
      return '';
    })
    .replace(/^(\s*)export\s+default\s+/gm, '$1const __default = ');

  return { code, exported };
}

const chunks = [];
const moduleExports = new Map();
for (const f of order) {
  const { code, exported } = transform(f);
  moduleExports.set(f, [...exported]);

  const leftovers = code
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /^\s*(import|export)\s/.test(l));
  if (leftovers.length) {
    const dump = join(pkgRoot, 'build', 'client-vendor-failed.ts');
    writeFileSync(dump, code, 'utf8');
    console.error(`[client-vendor] ${relOf(f)} 残留模块语法 ${leftovers.length} 行：`);
    for (const [n, l] of leftovers.slice(0, 6)) console.error(`[client-vendor]   L${n}: ${l.trim()}`);
    console.error('[client-vendor]   已落盘 build/client-vendor-failed.ts');
    process.exit(1);
  }

  let stripped;
  try {
    stripped = stripTypeScriptTypes(code, { mode: 'strip' });
  } catch (err) {
    const dump = join(pkgRoot, 'build', 'client-vendor-failed.ts');
    writeFileSync(dump, code, 'utf8');
    console.error(`[client-vendor] 类型剥离失败于 ${relOf(f)}: ${String(err).split('\n')[0]}`);
    console.error('[client-vendor]   已落盘 build/client-vendor-failed.ts');
    process.exit(1);
  }

  chunks.push(
    `// ======== ${relOf(f)} ========\n` +
      `const ${varNameOf.get(f)} = (function () {\n${stripped}\nreturn { ${[...exported].join(', ')} };\n})();`,
  );
}

// 入口导出 makeFactory
const entryVar = varNameOf.get(entry);
const entryNames = moduleExports.get(entry) ?? [];
const wanted = ['makeFactory'];
const missing = wanted.filter((n) => !entryNames.includes(n));
if (missing.length) {
  console.error(`[client-vendor] ❌ 入口缺少导出: ${missing.join(', ')}（实际: ${entryNames.join(', ')}）`);
  process.exit(1);
}

const out = `// 由 packages/dsh-efficiency/scripts/build-client-vendor.mjs 生成 —— 请勿手改。
//
// 来源：vendor/dsh-pet/src/client/** 与 src/shared/**
//       （上游 PC2005-cloud/dsh-pet，MIT，见 vendor/dsh-pet/LICENSE）
//
// 本文件【不自己调用 window.__ModuleLoader__.load】：
// 客户端的模块系统一个 id 只能 load 一次，而我们要把"宠物"和"效率助手"
// 两个插件组合进同一个 factory。所以这里只导出 __petFactory，
// 由 build.mjs 在生成的壳里统一执行两次 load。
//
// 模块数：${order.length}
//
const __petFactoryImpl = (function () {
${chunks.join('\n\n')}

// 从入口 IIFE 取值（IIFE 内部声明不会泄漏到此处，必须显式解构）
const makeFactory = ${entryVar}.makeFactory;
return makeFactory();
})();

// 供 build.mjs 组合：传入同一个 require（浏览器模块表）
export function __petFactory(require) {
  return __petFactoryImpl(require);
}
`;

mkdirSync(dirname(outFile), { recursive: true });

// 产出自检：用 mock require 真正实例化一次，确认 factory 能产出插件模块
try {
  const probe = join(pkgRoot, 'build', '.client-vendor-probe.mjs');
  writeFileSync(probe, out, 'utf8');
  const mod = await import(`${pathToFileURL(probe).href}?t=${Date.now()}`);
  if (typeof mod.__petFactory !== 'function') throw new Error('__petFactory 未导出');
  const fakeRequire = (m) => {
    if (m === 'react') {
      return {
        useEffect() {}, useRef() { return { current: null }; }, useState() { return [null, () => {}]; },
        useCallback(f) { return f; }, useMemo(f) { return f(); },
      };
    }
    if (m === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: 'F' };
    throw new Error(`unexpected require: ${m}`);
  };
  const pluginModule = mod.__petFactory(fakeRequire);
  if (typeof pluginModule?.apply !== 'function') throw new Error('factory 未返回含 apply 的插件模块');
  rmSync(probe, { force: true });
  console.log(`[client-vendor] 自检通过：导出 apply=${typeof pluginModule.apply} name=${pluginModule.name}`);
} catch (err) {
  writeFileSync(join(pkgRoot, 'build', 'client-vendor-failed.js'), out, 'utf8');
  console.error(`[client-vendor] ❌ 产出自检失败: ${String(err).split('\n')[0]}`);
  console.error('[client-vendor]   已落盘 build/client-vendor-failed.js');
  process.exit(1);
}

writeFileSync(outFile, out, 'utf8');
if (warnings.length) {
  console.log(`[client-vendor] ${warnings.length} 条告警：`);
  for (const w of warnings.slice(0, 8)) console.log(`   - ${w}`);
}
console.log(`[client-vendor] build/client-vendor.js <- ${order.length} 个模块（${out.length} B）`);
