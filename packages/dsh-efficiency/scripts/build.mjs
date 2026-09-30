/**
 * 零依赖构建脚本：把 src/ 下的源码打成 DSH 需要的形式。
 *
 * 为什么不用 tsdown：
 *   - DSH 官方的共享 tsdown 预设【未随 npm 发布】，第三方必须自备配置；
 *   - 客户端产物只需满足一个明确契约（见 research/01 §8.2）：
 *     window.__ModuleLoader__.load({ id: '<npm 包名>', factory: (require) => module })
 *   - 本插件没有 npm 依赖、模块很少，因此「源码拼接 + 包一层外壳」即可，
 *     不引入打包器 —— 构建可复现、无供应链负担。
 *
 * 拼接规则（仅适用于本项目这种零依赖、无循环引用的源码）：
 *   - 去掉顶层 `import ... from '...'`：react 等从 factory 的 require 取
 *   - 去掉本地相对 import（模块已按顺序拼在同一作用域）
 *   - 去掉 `export` 关键字（拼接后自然共享作用域）
 *   - 拼接顺序：被依赖者在前
 *
 * 产物：
 *   lib/index.js   宿主半（原样复制，保持 ESM 具名导出）
 *   lib/client.js  客户端半（module-loader 外壳 + 拼接后的源码）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const srcDir = join(pkgRoot, 'src');
const outDir = join(pkgRoot, 'lib');

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const PKG_ID = pkg.name;

mkdirSync(outDir, { recursive: true });

// ---------- 宿主半 ----------
// ⚠️ 宿主产物【不再由本脚本写】。
// 原因：宿主现在是「宠物宿主（vendor/dsh-pet）+ 效率宿主（本仓库）」的组合，
// 必须打成自包含单文件，由 scripts/build-host.mjs 负责（它会把两边合成一个入口）。
// 本脚本若也写 lib/index.js，就会覆盖掉那个组合产物（踩过：
// 构建后 lib/index.js 又变回单文件 8 KB，宠物宿主丢失）。
// 本脚本只负责客户端半。

// ---------- 客户端半：拼接 ----------
// 每个源文件包一层 IIFE，避免模块间的顶层标识符互相污染
// （已踩过：panel.js 与 settings.js 都声明了 `const API`）。
// 具名导出通过 IIFE 的返回值绑定到 __m_<file>，供后续模块引用。
const moduleVar = (fileName) => `__m_${fileName.replace(/\W/g, '_')}`;

const wrap = (source, fileName) => {
  const v = moduleVar(fileName);
  const names = new Set();

  let out = source
    // 去掉顶层（及缩进后的）import 语句
    .replace(/^[ \t]*import\s+[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    // export [async] function x -> function x（并记录导出名）
    // ⚠️ 必须处理 async 修饰符：漏掉会留下 `export async function`，
    //    在 CJS factory 里直接 SyntaxError（已被冒烟测试抓到一次）。
    .replace(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm, (_m, n) => {
      names.add(n);
      return _m.replace(/^export\s+/, '');
    })
    // export const/let/var x -> const/let/var x（并记录）
    .replace(/^export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, n) => {
      names.add(n);
      return `${kw} ${n}`;
    })
    // export { a, b };
    .replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (_m, list) => {
      list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => names.add(s.split(/\s+as\s+/).pop().trim()));
      return '';
    })
    .replace(/^export\s+default\s+/gm, '');

  const exportObj = `{ ${[...names].join(', ')} }`;
  return `\n// ======== ${fileName} ========\nconst ${v} = (function () {\n${out}\nreturn ${exportObj};\n})();\n`;
};

// 顺序：被依赖者在前（panel / settings / probe 互不依赖，app 依赖它们）
const PANEL = moduleVar('panel.js'); // __m_panel_js
const SETTINGS = moduleVar('settings.js'); // __m_settings_js
const PLACEMENT = moduleVar('placement.js'); // __m_placement_js
const PROBE = moduleVar('probe.js'); // __m_probe_js
const ANSWERER = moduleVar('answerer.js'); // __m_answerer_js
const PETV = moduleVar('pet-vendor.js'); // __m_pet_vendor_js
const LOGGER = moduleVar('logger.js'); // __m_logger_js

// 顺序：依赖在前。所有模块统一走 readClient（重写 import 后再 wrap）

// app.js 用相对 import 引用本地模块；拼接后要指向各自 IIFE 的返回值。
// 用表格驱动，新增本地模块时只需在这里加一行。
//
// ⚠️ 顺序由依赖决定，且**必须对所有本地模块做重写**，不能只重写 app.js。
//    踩过的坑：answerer.js 也 import 了 './probe.js'，只重写 app.js 时
//    它的 import 被原样留下，运行到 handler 里就 ReferenceError。
//    node --check 查不出（语法合法），只有真正调用 handler 才炸 —— 冒烟测试抓到。
const localModules = {
  './placement.js': PLACEMENT,
  './panel.js': PANEL,
  './settings.js': SETTINGS,
  './probe.js': PROBE,
  './answerer.js': ANSWERER,
  './pet-vendor.js': PETV,
  '@dsh-app/pet': PETV,
  './logger.js': LOGGER,
};

const rewriteLocalImports = (source) => {
  let out = source;
  for (const [spec, varName] of Object.entries(localModules)) {
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${esc}['"];?`, 'g');
    out = out.replace(re, (_m, names) =>
      names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => `const ${n} = ${varName}.${n};`)
        .join('\n'),
    );
  }
  return out;
};

// 每个本地模块都先重写 import，再包 IIFE。
// 顺序 = 依赖顺序：probe（无依赖）→ placement（无依赖）→ answerer（依赖 probe）
//                → panel（依赖 placement）→ settings（无依赖）→ app（依赖全部）
const readClient = (f) => rewriteLocalImports(readFileSync(join(srcDir, 'client', f), 'utf8'));

// vendor 的宠物客户端（由 scripts/build-client-vendor.mjs 生成，20 个模块打成一个）。
// 它不是我们 src/client 下的文件，所以不参与 rewriteLocalImports；
// 它导出 __petFactory(require)，由 app.js 在 factory 内调用。
const petVendorPath = join(pkgRoot, 'build', 'client-vendor.js');
if (!existsSync(petVendorPath)) {
  console.error('[build] 缺少 build/client-vendor.js —— 先跑 node scripts/build-client-vendor.mjs');
  process.exit(1);
}
const petVendorSource = readFileSync(petVendorPath, 'utf8');
const petWrapped = wrap(petVendorSource, 'pet-vendor.js');

const loggerWrapped = wrap(readClient('logger.js'), 'logger.js');
const probeWrapped = wrap(readClient('probe.js'), 'probe.js');
const placementWrapped = wrap(readClient('placement.js'), 'placement.js');
const answererWrapped = wrap(readClient('answerer.js'), 'answerer.js');
const panelWrapped = wrap(readClient('panel.js'), 'panel.js');
const settingsWrapped = wrap(readClient('settings.js'), 'settings.js');
const appWrapped = wrap(readClient('app.js'), 'app.js');

// 宠物插件的 factory：vendor 产物导出 __petFactory(require)，
// 而 load 需要的是 (require) => module，所以直接用它即可。
const PETV_FACTORY = PETV + '.__petFactory';

const clientBody = [loggerWrapped, petWrapped, probeWrapped, placementWrapped, answererWrapped, panelWrapped, settingsWrapped, appWrapped].join('\n');

// 一个 id 只能 load 一次（契约见 dsh-client-modules 的文档注释：
//   "executing a plugin bundle only REGISTERS its factory"）。
// 本 bundle 含【两个】插件（桌宠 + 效率助手），所以对每个插件各 load 一次，
// 用不同的 id。require 由【装载器】在 materialize 时传入，我们自己造不出来，
// 因此这里只提交 factory，绝不自己调用它。
//
// 关于 id：桌宠本该是 'dsh-pet'，但那个 id 在过渡期要留给尚未卸载的
// 上游插件；等上游被彻底替换后再改回，避免与它争同一个 id。
const client = `// 由 packages/dsh-efficiency/scripts/build.mjs 生成 —— 请勿手改。
// 契约：window.__ModuleLoader__.load({ id: '<npm 包名>', factory: (require) => module })
//
// ⚠️ 本 bundle 含两个插件：效率助手（本仓库）+ 桌宠（vendor 自 dsh-pet）。
// 每个插件各提交一次 load —— 因为一次 load 只登记一个 factory，
// 而 factory 的调用（materialize）由装载器负责，require 也由它传入。
(function () {
${clientBody}
  window.__ModuleLoader__.load({
    id: ${JSON.stringify(PKG_ID)},
    factory: ${moduleVar('app.js')}.makeFactory(),
  });

  // ⚠️ 这里**不能**再为桌宠单独 load 一个 id。
  //    取证结论（读 @deepseek-ai/dsh-client-modules 与 cordis-plugin-loader）：
  //      客户端 boot 清单里每个包只对应【一个】客户端模块 id；
  //      loader.create({name}) 为该模块建【一个】cordis entry，取它的导出当
  //      【一个】插件（unwrapExports 只接受单对象/函数，无数组与多插件字段）。
  //    所以第二个 id 没有清单条目引用，永远不会被物化 —— 实测它的 factory
  //    一次都没被调用，而且**不报错**（极难排查）。
  //    现在桌宠由 app.js 作为【库】引入，并在这一个插件里一并 apply。
})();
`;

writeFileSync(join(outDir, 'client.js'), client, 'utf8');
console.log(`[build] lib/client.js <- src/client/*.js (${client.length} B)`);
