/**
 * 把桌面运行时代码放进 lib/runtime/，供宿主按 PACKAGE_ROOT/runtime/... 拉起。
 *
 * 为什么需要：宿主侧 helper-process.ts 里
 *   packageRoot = resolve(<本文件所在目录>, '..')
 *   defaultHelperMain = packageRoot + '/runtime/electron-helper/main.js'
 * 而宿主产物现在是 lib/index.js，所以 packageRoot = <包根>/lib，
 * 于是它期望 <包根>/lib/runtime/electron-helper/main.js。
 *
 * 两个必须处理的点：
 *  1) 直接复制整目录。help 代码是手写 JS（不是构建产物），
 *     上游把它放在 runtime/ 而不是 lib/，我们这里放进 lib/ 即可对齐。
 *  2) ⚠️ helper 是 **CommonJS**（用 require / exports.xxx），
 *     而本包 package.json 是 "type": "module" → 复制的 .js 会被当 ESM 解析而报错。
 *     所以必须给 helper 目录写一份自己的 package.json 声明 commonjs
 *     （上游包内 helper 目录本来就有 package.json，但没有 type 字段，
 *      因为上游包整体不是 type:module；我们必须显式声明）。
 *
 * 用法：node scripts/build-runtime.mjs
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const src = join(pkgRoot, 'vendor', 'dsh-pet', 'runtime', 'electron-helper');
const dest = join(pkgRoot, 'lib', 'runtime', 'electron-helper');

if (!existsSync(src)) {
  console.error(`[runtime] 找不到桌面 helper 源码: ${src}`);
  process.exit(1);
}

// 先清掉旧产物，避免残留已删除的文件（上游可能删过文件）
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });

// 覆写 helper 自己的 package.json：声明 CommonJS + 入口。
// 不写这一份的话，lib/ 会继承外层 "type": "module"，helper 的 require 会直接报错。
const upstreamPkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
writeFileSync(
  join(dest, 'package.json'),
  `${JSON.stringify(
    {
      name: upstreamPkg.name ?? 'dsh-pet-electron-helper',
      version: upstreamPkg.version ?? '0.0.0',
      private: true,
      // [dsh-app] 必须显式声明：本包外层是 "type": "module"，而 helper 是 CommonJS
      type: 'commonjs',
      main: 'main.js',
      description: upstreamPkg.description ?? 'desktop helper',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const files = readdirSync(dest);
console.log(`[runtime] lib/runtime/electron-helper/ <- ${files.length} 个文件（含自己声明的 package.json）`);
console.log('[runtime] 已声明 type=commonjs（外层是 type=module，不声明会报 require is not defined）');
