/**
 * 零依赖宿主打包器：把 vendor 的 dsh-pet 宿主源码打成一个自包含的 lib/index.js。
 *
 * 为什么需要打包（已查清上游约束的原话）：
 *   vendor/dsh-pet/src/shared/index.ts:6
 *     「host 半侧**不得** import 本目录（DSH 单文件加载约束会拆 chunk 导致加载失败）」
 *   也就是说：约束的真实含义是「宿主半侧必须是一个自包含的单文件」，
 *   而 host 目录**内部**的相对 import 是允许的（上游自己就是多文件 + 打包）。
 *
 * 为什么自己写而不是引 tsdown：
 *   本项目其余部分（客户端 bundle）已经是零依赖手写构建。
 *   引入 TypeScript 工具链只为这一步，代价与收益不成比例。
 *   而类型剥离有官方 API 可用（实测 Node 24 提供 module.stripTypeScriptTypes），
 *   不必自己做正则式剥离。
 *
 * 产物形态：
 *   - 每个模块包成一个惰性求值的 IIFE，按依赖顺序声明为 const
 *   - 相对 import 改写为「取那个 const 的成员」
 *   - 裸模块（node:fs / @deepseek-ai/... / zod 等）用 createRequire 在运行时 require
 *   - 顶层导出：apply / inject / name
 *
 * 用法：node scripts/build-host.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const buildVendor = join(pkgRoot, 'build', 'vendor');
const ourHostSrc = join(pkgRoot, 'src', 'host', 'index.js');
const outFile = join(pkgRoot, 'lib', 'index.js');

// ---- 组合入口 ----
// 本包要提供【一个】宿主插件，而它由两部分组成：
//   · 宠物宿主 = vendor 自 dsh-pet（build/vendor/host/**）
//   · 效率宿主 = 本仓库的 src/host/index.js（提问捕获 / HTTP 路由 / 客户端日志回流）
//
// 为什么用「合成入口」而不是让两边各自成为入口：
//   dsh 以【单文件】加载宿主插件，而一个包只能有一个入口（package.json main）。
//   所以必须合成成一个模块，导出一套 apply / inject / name。
//
// inject 取两边并集：宠物要 webServer/agentDefaultModel/credentials/llm/commands，
// 我们要 webServer/userQuestions → 并集去重。
//
// 合成入口写到 build/ 下（生成物，不入库），路径与 vendor 一致（都在 build/ 内），
// 这样打包器的相对解析规则不用改。
const syntheticEntry = join(pkgRoot, 'build', 'host-entry.ts');
const entry = syntheticEntry;

/** 先把合成入口写出来（每次构建重写，保证与源一致） */
function writeSyntheticEntry() {
  mkdirSync(dirname(syntheticEntry), { recursive: true });
  // 相对路径必须从【合成入口所在目录】起算，而不是从包根。
  // ⚠️ 踩过：按"从 build/ 起算"去剥前缀，得出 `./src/host/index.js`，
  //    实际解析成 build/src/host/index.js（不存在）→ import 变注释 → 变量未定义。
  const relFromEntryDir = (abs) => {
    const r = relative(dirname(syntheticEntry), abs).replace(/\\/g, '/');
    return r.startsWith('.') ? r : `./${r}`;
  };
  writeFileSync(
    syntheticEntry,
    `// 由 scripts/build-host.mjs 生成 —— 请勿手改。
// 组合两个宿主插件：宠物（vendor/dsh-pet）+ 效率助手（本仓库 src/host）。
import * as pet from '${relFromEntryDir(join(buildVendor, 'host', 'index.ts'))}';
import * as own from '${relFromEntryDir(ourHostSrc)}';

export const name = 'dsh-efficiency';
export const inject = [...new Set([...(pet.inject ?? []), ...(own.inject ?? [])])];

export function apply(ctx) {
  // 先跑宠物宿主：它注册 /dsh-pet-7340/* 与桌面 helper 拉起
  pet.apply(ctx);
  // 再跑我们的宿主：它注册 /dsh-efficiency/api/* 并监听提问
  own.apply(ctx);
}
`,
    'utf8',
  );
}
writeSyntheticEntry();

if (!existsSync(ourHostSrc)) {
  console.error(`[host] 找不到本仓库宿主源码: ${ourHostSrc}`);
  process.exit(1);
}

const warnings = [];

/** 把绝对路径缩成相对 vendor 根的短名，便于看日志 */
const relOf = (f) => f.replace(buildVendor, '').replace(/\\\\/g, '/');

/**
 * 把 import 说明符解析为磁盘路径。
 * 支持 .ts（vendor 转译产物）与 .js（本仓库的宿主源码）两种，
 * 也支持 TS 的「.js 说明符指向 .ts 文件」约定。
 * ⚠️ 曾经的实现只认 .ts，导致 `../src/host/index.js` 解析失败，
 *    而失败的表现是「import 变成注释 → 变量未定义」，很难一眼看出（踩过）。
 */
function resolveRel(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const cands = [base];
  if (!/\.(ts|js|mjs|cjs)$/.test(base)) {
    cands.push(`${base}.ts`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js'));
  } else {
    // `./x.js` 可能实际是 `./x.ts`（TS 的 NodeNext 约定）
    cands.push(base.replace(/\.js$/, '.ts'));
  }
  for (const c of cands) {
    if (existsSync(c) && !statSync(c).isDirectory()) return c;
  }
  return null;
}

/**
 * 解析一个模块里的所有 import 语句。
 * 返回 { deps: 相对依赖的绝对路径[], externals: 裸模块名集合, hoisted: node: 前缀集合 }
 */
function collectDeps(source, file) {
  const deps = [];
  const externals = new Set();
  const hoisted = new Set();

  // 匹配：import ... from 'spec';  以及  import 'spec';
  const reFrom = /\bimport\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]\s*;?/g;
  const reBare = /\bimport\s*['"]([^'"]+)['"]\s*;?/g;
  const specs = new Set();
  let m;
  while ((m = reFrom.exec(source)) !== null) specs.add(m[1]);
  while ((m = reBare.exec(source)) !== null) specs.add(m[1]);

  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const abs = resolveRel(file, spec);
      if (abs) deps.push(abs);
      else warnings.push(`${file}: 无法解析相对依赖 ${spec}`);
    } else if (spec.startsWith('node:')) {
      hoisted.add(spec);
      externals.add(spec);
    } else {
      externals.add(spec);
    }
  }
  return { deps, externals: [...externals], hoisted: [...hoisted] };
}

/** 深度优先收集模块（跳过测试文件，它们不属于运行时依赖） */
const modules = new Map(); // abs -> { code, deps, externals, hoisted }
const order = [];

function visit(file) {
  if (modules.has(file)) return;
  if (/\.test\.ts$/.test(file)) return; // 测试文件不入包
  const raw = readFileSync(file, 'utf8');
  const { deps, externals, hoisted } = collectDeps(raw, file);
  modules.set(file, { raw, deps, externals, hoisted });
  for (const d of deps) visit(d);
  order.push(file); // 后序 = 依赖在前
}

visit(entry);

console.log(`[host] 收集到 ${modules.size} 个模块（已跳过 *.test.ts）`);

/** 把一个模块的 import 语句改写成"取 const 成员 / 运行时 require" */
function rewriteImports(module, file, varNameOf) {
  let code = module.raw;

  // 1) 所有 import 语句 → CommonJS 赋值。
  //
  // ⚠️ 这里的写法踩过两个坑，都值得留着：
  //    (a) 最初分成三条正则（相对/副作用/裸模块），每条子句都用 `([\s\S]*?)`——
  //        而 `\s` **包含换行**，正则于是跨过 `from '...'` 继续吃下一条 import，
  //        产出 `import { supportsReasoningOff;` 这种残缺代码。
  //        症状：剥离器报 Expression expected，而残留 import 只有半句。
  //    (b) 改用一个宽泛子句 `([^;]*?)` 后，`import * as ns from 'x'` 匹配不到
  //        （`\s+` 吃掉了 `*`），整条语句原样残留 → 报 Expected 'from', got '*'。
  //
  //    最终写法：一条正则、一次匹配一条完整语句，子句允许 `* as X` 与
  //    `{...}` 的任意组合；并在改写后【显式检测残留】，让报错自己说清楚。
  const IMPORT_STMT = new RegExp(
    String.raw`\bimport\s+(?:type\s+)?` +
      String.raw`((?:\*\s*as\s+[A-Za-z_$][\w$]*|\{[^}]*\}|[A-Za-z_$][\w$]*)` +
      String.raw`(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*))?)` +
      String.raw`\s+from\s*['"]([^'"]+)['"]\s*;?`,
    'g',
  );

  code = code.replace(IMPORT_STMT, (whole, rawClause, spec) => {
    const clause = rawClause.trim();
    // 纯类型导入：运行期无意义，直接删（`import type {...}`）
    if (/^type\b/.test(whole.replace(/^import\s+/, ''))) return '';

    const isRel = spec.startsWith('.');
    const abs = isRel ? resolveRel(file, spec) : null;
    let ref;
    if (isRel) {
      if (!abs || !varNameOf.has(abs)) return `/* [host] 未解析的相对 import: ${spec} */`;
      ref = varNameOf.get(abs);
    } else {
      ref = `__ext_${spec.replace(/[^\w]/g, '_')}`;
    }
    const pre = isRel ? '' : `const ${ref} = __hostRequire(${JSON.stringify(spec)}); `;

    const parts = [];
    // 默认导入：`X` 或 `X, { ... }`
    if (!/^\*/.test(clause)) {
      const defM = clause.match(/^([A-Za-z_$][\w$]*)/);
      if (defM) parts.push(`const ${defM[1]} = ${ref}.default ?? ${ref};`);
    }
    // 命名空间导入：`* as X`
    const starM = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (starM) parts.push(`const ${starM[1]} = ${ref};`);
    // 具名导入：`{ a, b as c, type T }`
    const braceM = clause.match(/\{([^}]*)\}/);
    if (braceM) {
      const names = braceM[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !/^type\s/.test(s));
      for (const p of names) {
        const as = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        parts.push(as ? `const ${as[2]} = ${ref}.${as[1]};` : `const ${p} = ${ref}.${p};`);
      }
    }
    if (parts.length === 0) return pre.trimEnd() || '';
    return `${pre}${parts.join(' ')}`;
  });

  // 2) 副作用 import（import 'spec'）—— 上面那条要求有 from，这条兜住没有 from 的
  code = code.replace(/\bimport\s*['"]([^'"]+)['"]\s*;?/g, (whole, spec) => {
    if (!spec.startsWith('.')) return `__hostRequire(${JSON.stringify(spec)});`;
    const abs = resolveRel(file, spec);
    return abs && varNameOf.has(abs) ? `${varNameOf.get(abs)};` : '/* [host] 未解析的副作用 import */';
  });


  // 4) export 语句 → 收集导出名。
  //
  // ⚠️ 这里的策略很重要，踩过坑：
  //    最初我试图用正则【删除】`export interface` / `export type` 整块，
  //    结果跨行的 type 声明被吞掉、而 `export interface` 又漏掉，
  //    留下 `export interface X {` 让 stripTypeScriptTypes 报 Expression expected。
  //    根因是"用正则处理跨行 TS 语法"本身就不可靠。
  //
  //    改成【只剥掉 export 关键字，不删声明】：
  //      · `export interface X {...}` → `interface X {...}`
  //        （interface 是纯类型，剥离器会处理，不会进产物）
  //      · `export type X = ...;`     → 剥掉 export 即可（同上）
  //    这样正则只需处理关键字，不用理解语句边界。
  const exported = new Set();
  code = code
    .replace(
      // 注意捕获 async 本身：`export async function f()` 里 `async` 出现在 export 之后，
      // 不显式捕获就会在替换时丢掉它，函数变成非 async 却仍 await → 剥离器报
      // "await isn't allowed in non-async function"（踩过）。
      /^(\s*)export\s+((?:async\s+)?)(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
      (m, indent, asyncKw, kind, n) => {
        exported.add(n);
        return `${indent}${asyncKw}${kind} ${n}`;
      },
    )
    // interface / type 声明：剥离器会移除，但 export 关键字必须先去掉，
    // 否则 "export interface" 会被 stripTypeScriptTypes 视为非法
    .replace(/^(\s*)export\s+(interface|type|declare)\s+/gm, '$1$2 ')
    .replace(/^(\s*)export\s*\{([^}]+)\}\s*;?/gm, (m, indent, names) => {
      for (const part of names.split(',')) {
        const p = part.trim();
        if (!p) continue;
        const as = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        const name = as ? as[2] : p.replace(/^type\s+/, '');
        if (name && !/^type\s/.test(p)) exported.add(name);
      }
      return '';
    })
    .replace(/^(\s*)export\s+default\s+/gm, '$1const __default = ');

  return { code, exported };
}

// 先分配变量名
const varNameOf = new Map();
let n = 0;
for (const f of order) varNameOf.set(f, `__m${n++}`);

// 逐模块改写 + 剥离类型
const chunks = [];
const entryExports = new Set();
for (const f of order) {
  const module = modules.get(f);
  const { code, exported } = rewriteImports(module, f, varNameOf);
  if (f === entry) {
    for (const e of exported) entryExports.add(e);
    // 入口必须恰好提供插件三件套；缺任何一个都要在构建期就报出来并指出首次出现位置，
    // 而不是等到运行时（曾出现「脚本报告导出 apply，产物里却没有该绑定」）。
    const missing = ['apply', 'inject', 'name'].filter((n) => !exported.has(n));
    if (missing.length) {
      console.error(`[host] ❌ 入口缺少导出: ${missing.join(', ')}`);
      for (const want of missing) {
        const hit = code
          .split('\n')
          .map((l, i) => [i + 1, l])
          .find(([, l]) => new RegExp(`\\b${want}\\b`).test(l));
        console.error(`[host]   ${want} 首次出现于 L${hit ? hit[0] : '?'}: ${hit ? hit[1].trim().slice(0, 90) : '(未出现)'}`);
      }
      process.exit(1);
    }
  }

  // 改写后先自检：残留的 import/export 说明我们的改写没覆盖到，
  // 这种错误交给剥离器会变成难懂的语法错（"Expression expected"），
  // 所以在这里就明确报出来，并指出具体哪一行。
  const leftovers = code
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /^\s*(import|export)\s/.test(l));
  if (leftovers.length > 0) {
    const dumpPath = join(pkgRoot, 'build', 'host-failed.ts');
    mkdirSync(dirname(dumpPath), { recursive: true });
    writeFileSync(dumpPath, code, 'utf8');
    console.error(`[host] ${relOf(f)} 改写后仍残留模块语法（共 ${leftovers.length} 行）：`);
    for (const [n, l] of leftovers.slice(0, 8)) console.error(`[host]   L${n}: ${l.trim()}`);
    console.error('[host]   中间代码已落盘: build/host-failed.ts');
    process.exit(1);
  }

  let stripped;
  try {
    stripped = stripTypeScriptTypes(code, { mode: 'strip' });
  } catch (err) {
    // 排障：把出问题的中间代码落盘，便于精确定位（而不是靠猜）
    const dumpPath = join(pkgRoot, 'build', 'host-failed.ts');
    mkdirSync(dirname(dumpPath), { recursive: true });
    writeFileSync(dumpPath, code, 'utf8');
    console.error(`[host] 类型剥离失败于 ${f}`);
    console.error(`[host]   错误: ${String(err)}`);
    console.error(`[host]   中间代码已落盘: build/host-failed.ts`);

    // 二分定位：按"只保留前 N 个完整语句"的方式找不到边界，
    // 因为截断处必然产生未闭合的注释/括号 —— 直接改用错误行号 + 上下文。
    const lineMatch = String(err).match(/\((\d+):(\d+)\)/) || String(err.message).match(/position (\d+)/);
    const lines = code.split('\n');
    console.error(`[host]   中间代码共 ${lines.length} 行`);
    if (lineMatch) {
      const ln = Number(lineMatch[1]);
      if (Number.isFinite(ln) && ln > 0) {
        for (let i = Math.max(0, ln - 6); i < Math.min(lines.length, ln + 4); i++) {
          const mark = i + 1 === ln ? '>>' : '  ';
          console.error(`[host]   ${mark} ${i + 1}: ${lines[i]}`);
        }
      }
    }
    process.exit(1);
  }
  chunks.push(
    `// ======== ${f.replace(buildVendor, '').replace(/\\/g, '/')} ========\n` +
      `const ${varNameOf.get(f)} = (function () {\n${stripped}\nreturn { ${[...exported].join(', ')} };\n})();`,
  );
}

const relEntry = f => f.replace(buildVendor, '').replace(/\\/g, '/');
const body = chunks.join('\n\n');

// ⚠️ 导出必须【从入口 IIFE 的返回值里解构出来】，不能直接写
//      export { apply, inject, name };
//    因为每个模块都被包进 IIFE，其内部声明不会泄漏到模块作用域 ——
//    直接 export 会报 "Export 'apply' is not defined in module"（踩过）。
//    （当时 name/inject 看似没问题只是巧合：错误只报了第一个缺失的绑定。）
const entryVar = varNameOf.get(entry);
const decls = [...entryExports].map((n) => `const ${n} = ${entryVar}.${n};`).join('\n');
const out = `// 由 packages/dsh-efficiency/scripts/build-host.mjs 生成 —— 请勿手改。
//
// 来源：vendor/dsh-pet/src/host/**（上游 PC2005-cloud/dsh-pet，MIT，见 vendor/dsh-pet/LICENSE）
// 本文件把宿主半侧打成【自包含单文件】—— 上游约束原话见 src/shared/index.ts:6：
//   "host 半侧不得 import 本目录（DSH 单文件加载约束会拆 chunk 导致加载失败）"
//
// 生成方式：零依赖打包器（不引 tsdown），类型剥离用 Node 内置 module.stripTypeScriptTypes。
// 入口：${relEntry(entry)}
// 模块数：${modules.size}
//
import { createRequire } from 'node:module';
const __hostRequire = createRequire(import.meta.url);

${body}

// 从入口 IIFE 的返回值解构出插件三件套（见上方说明：不能直接 export）
${decls}
export { ${[...entryExports].join(', ')} };
`;

mkdirSync(dirname(outFile), { recursive: true });

// 产出自检：写出前先验证这个 bundle 真能被解析并求值。
// 为什么必须做：曾出现「脚本报告导出 apply，但产物里根本没有该绑定」的情况，
// 而产物照样落盘 → 直到运行时才炸，且报错指向无关的行。
//
// ⚠️ 自检必须用【真实文件】而不是 data: URL ——
//    产物里有 createRequire(import.meta.url)，data: URL 不是合法 filename，
//    会抛 ERR_INVALID_ARG_VALUE（踩过，那是自检方式的问题，不是产物的问题）。
const probeFile = join(pkgRoot, 'build', '.host-probe.mjs');
writeFileSync(probeFile, out, 'utf8');
try {
  const mod = await import(`${pathToFileURL(probeFile).href}?t=${Date.now()}`);
  const missing = [...entryExports].filter((n) => mod[n] === undefined);
  if (missing.length) {
    throw new Error(`导出的绑定为 undefined: ${missing.join(', ')}`);
  }
} catch (err) {
  const dumpPath = join(pkgRoot, 'build', 'host-bundle-failed.js');
  writeFileSync(dumpPath, out, 'utf8');
  console.error('[host] ❌ 产出自检失败（bundle 无法被解析/求值）');
  console.error(`[host]   ${String(err).split('\n')[0]}`);
  console.error(`[host]   入口导出集: ${[...entryExports].join(', ') || '(空)'}`);
  console.error('[host]   已落盘: build/host-bundle-failed.js');
  process.exit(1);
} finally {
  try { rmSync(probeFile, { force: true }); } catch { /* ignore */ }
}

writeFileSync(outFile, out, 'utf8');

if (warnings.length) {
  console.log(`[host] ${warnings.length} 条告警：`);
  for (const w of warnings.slice(0, 10)) console.log(`   - ${w}`);
}
console.log(`[host] lib/index.js <- ${modules.size} 个模块（${out.length} B）`);
console.log(`[host] 入口导出: ${[...entryExports].join(', ') || '(空！)'}`);
