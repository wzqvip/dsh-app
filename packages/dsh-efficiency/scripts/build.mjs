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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const srcDir = join(pkgRoot, 'src');
const outDir = join(pkgRoot, 'lib');

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const PKG_ID = pkg.name;

mkdirSync(outDir, { recursive: true });

// ---------- 宿主半：原样复制（Node 直接跑 ESM） ----------
const hostSrc = readFileSync(join(srcDir, 'host', 'index.js'), 'utf8');
writeFileSync(join(outDir, 'index.js'), hostSrc, 'utf8');
console.log(`[build] lib/index.js  <- src/host/index.js (${hostSrc.length} B)`);

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

// 顺序：被依赖者在前。placement ← panel（panel 用它的定位函数）
const placementWrapped = wrap(readFileSync(join(srcDir, 'client', 'placement.js'), 'utf8'), 'placement.js');
const panelWrapped = wrap(readFileSync(join(srcDir, 'client', 'panel.js'), 'utf8'), 'panel.js');
const settingsWrapped = wrap(readFileSync(join(srcDir, 'client', 'settings.js'), 'utf8'), 'settings.js');
const probeWrapped = wrap(readFileSync(join(srcDir, 'client', 'probe.js'), 'utf8'), 'probe.js');

// app.js 用相对 import 引用本地模块；拼接后要指向各自 IIFE 的返回值。
// 用表格驱动，新增本地模块时只需在这里加一行。
const localModules = {
  './placement.js': PLACEMENT,
  './panel.js': PANEL,
  './settings.js': SETTINGS,
  './probe.js': PROBE,
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

const appRaw = rewriteLocalImports(readFileSync(join(srcDir, 'client', 'app.js'), 'utf8'));
const appWrapped = wrap(appRaw, 'app.js');

const clientBody = [placementWrapped, panelWrapped, settingsWrapped, probeWrapped, appWrapped].join('\n');

const client = `// 由 packages/dsh-efficiency/scripts/build.mjs 生成 —— 请勿手改。
// 契约：window.__ModuleLoader__.load({ id: '<npm 包名>', factory: (require) => module })
(function () {
${clientBody}
  window.__ModuleLoader__.load({
    id: ${JSON.stringify(PKG_ID)},
    factory: ${moduleVar('app.js')}.makeFactory(),
  });
})();
`;

writeFileSync(join(outDir, 'client.js'), client, 'utf8');
console.log(`[build] lib/client.js <- src/client/*.js (${client.length} B)`);
