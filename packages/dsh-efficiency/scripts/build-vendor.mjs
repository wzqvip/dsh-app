/**
 * 把 vendor 的 dsh-pet 源码转成 Node 可直接加载的形态。
 *
 * 为什么需要这一步（已实测）：
 *   vendor 的源码是 TypeScript，但**没有用任何类型剥离不支持的特性**
 *   （实测：enum / namespace / 装饰器 / 构造函数参数属性 全为 0）。
 *   所以不需要引入 tsdown 工具链，直接用 Node 内置的类型剥离即可。
 *
 * 唯一的障碍：**63 处 import 没有 `.ts` 后缀**。
 *   上游用 tsdown 打包，打包器会做模块解析，所以上游不写后缀也不影响。
 *   但 Node 的 ESM 解析要求显式扩展名 → 必须补上。
 *
 * 本脚本做两件事：
 *   1. 把 vendor 的源码复制到 build/vendor/，并把相对 import 补上 .ts 后缀
 *   2. 保持目录结构不变（相对路径关系不变）
 *
 * 注意：dsh 宿主以单文件方式加载插件，所以宿主入口仍需要打包；
 *      这一步只负责"让源码可被 Node 解析"，打包由 build.mjs 做。
 *
 * 用法：node scripts/build-vendor.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const vendorSrc = join(pkgRoot, 'vendor', 'dsh-pet', 'src');
const outRoot = join(pkgRoot, 'build', 'vendor');

if (!existsSync(vendorSrc)) {
  console.error(`[vendor] 找不到 vendor 源码: ${vendorSrc}`);
  process.exit(1);
}

/** 递归列出所有文件 */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * 给相对 import 补 `.ts` 后缀。
 * 只处理相对路径（./ 或 ../），已带扩展名的原样保留；
 * 裸模块名（'react' 等）不在此正则的匹配范围内，天然不受影响。
 */
function addTsExtensions(source) {
  return source.replace(
    /(\bfrom\s*['"])(\.\.?\/[^'"]+)(['"])/g,
    (whole, pre, spec, post) => {
      if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(spec)) return whole;
      rewritten += 1;
      return `${pre}${spec}.ts${post}`;
    },
  );
}

/**
 * 把两个「只在需要下载 Electron 时才用到」的包改成懒加载。
 *
 * 为什么必须改：
 *   它们是**静态 import**，会让整个 helper-process 模块在加载时就要求它们存在。
 *   但真正用到只有 ensureElectronDownload() 一条路径 ——
 *   Electron 已缓存的机器（比如本机）永远走不到。
 *   静态 import 会让"没装这两个包"直接变成"插件加载失败"，代价与收益不成比例。
 *
 * 改法：去掉顶部静态 import，在下载处动态 import。
 * 注意：若确实需要下载，仍需安装它们（见下方提示），这是有意保留的显式失败。
 */
function lazifyElectronDeps(source, file) {
  if (!file.endsWith('helper-process.ts')) return source;
  let out = source
    .replace(/^import \{ downloadArtifact \} from '@electron\/get';\r?\n/m, '')
    .replace(/^import extract from '@electron-internal\/extract-zip';\r?\n/m, '');
  out = out.replace(
    /^(\s*)const zipPath = await downloadArtifact\(\{/m,
    [
      "$1// [dsh-app] 懒加载：这两个包只在「需要下载 Electron」时才用到。",
      "$1// 改成动态 import 后，未安装它们也能加载本模块（Electron 已缓存时不会走到这里）。",
      "$1// 若确实需要下载，请先安装：pnpm add @electron/get @electron-internal/extract-zip",
      "$1const { downloadArtifact } = await import('@electron/get');",
      "$1const { default: extract } = await import('@electron-internal/extract-zip');",
      "$1const zipPath = await downloadArtifact({",
    ].join('\n'),
  );
  return out;
}

let rewritten = 0;
let copies = 0;
let lazified = 0;
const files = walk(vendorSrc);

for (const abs of files) {
  const rel = relative(vendorSrc, abs);
  const dest = join(outRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });

  if (abs.endsWith('.ts')) {
    const src = readFileSync(abs, 'utf8');
    const withExt = addTsExtensions(src);
    const final = lazifyElectronDeps(withExt, rel.replace(/\\/g, '/'));
    if (final !== withExt) lazified += 1;
    writeFileSync(dest, final, 'utf8');
  } else {
    writeFileSync(dest, readFileSync(abs)); // .json 等原样复制
  }
  copies += 1;
}

console.log(`[vendor] 转译 ${copies} 个文件 -> build/vendor/`);
console.log(`[vendor] 补全 ${rewritten} 处相对 import 的 .ts 后缀`);
if (lazified) console.log(`[vendor] 懒加载化 ${lazified} 个文件的 Electron 下载依赖`);
console.log('[vendor] 无 enum/namespace/装饰器/参数属性，Node 内置类型剥离即可运行');
