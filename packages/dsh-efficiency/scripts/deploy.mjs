/**
 * 部署到 release/（生产安装目录）。
 *
 * 为什么需要这一步（见 research/14 的事故复盘）：
 *   生产 profile 过去用 file: 依赖指向本包【根目录】。pnpm 对 file: 依赖用硬链接，
 *   于是 `npm run build` 产出的 lib/ 与生产 node_modules 里的是【同一个 inode】——
 *   在仓库里构建 = 直接改生产，零缓冲。
 *
 *   事故：一次带 ReferenceError 的开发构建落盘后，生产重启即加载它，
 *   插件 apply 阶段崩溃，前端白屏。
 *
 * 本脚本建立的隔离：
 *   src/          源码，随便改
 *   lib/          开发构建产物（沙箱用）
 *   release/      已验收的发布产物（生产只用这里）
 *
 * 门禁：必须 build + smoke + placement 全绿，才允许写 release/。
 * 语义：用【复制】而不是链接，保证 release/ 与仓库不再共享 inode。
 *
 * 用法：node scripts/deploy.mjs
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, statSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const libDir = join(pkgRoot, 'lib');
const releaseDir = join(pkgRoot, 'release');
const releaseLib = join(releaseDir, 'lib');

const run = (label, script) => {
  process.stdout.write(`[deploy] ${label} ... `);
  try {
    execFileSync(process.execPath, [join(here, script)], { cwd: pkgRoot, stdio: 'pipe' });
    process.stdout.write('OK\n');
    return true;
  } catch (err) {
    process.stdout.write('FAIL\n');
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    if (out) console.error(out.split('\n').slice(-25).join('\n'));
    return false;
  }
};

console.log('[deploy] 门禁检查（全绿才允许发布）');

// 1) 构建
if (!run('build', 'build.mjs')) process.exit(1);

// 2) 冒烟：其中"apply 期间无错误日志"正是本次事故的守门断言
if (!run('smoke-client（含 apply 无错误日志断言）', 'smoke-client.mjs')) process.exit(1);

// 3) 定位单测
if (!run('test-placement', 'test-placement.mjs')) process.exit(1);

// 4) 客户端装载：模拟浏览器模块系统，确认 client.js 的模块能实例化出插件。
//    本 bundle 只提交一次 load（一个客户端模块只能出一个插件；桌宠作为库由
//    app.js 一并 apply）。"只装一个/漏一个"这类错误只会在浏览器里暴露，
//    必须在这里拦住。
if (!run('test-client-materialize（客户端模块能实例化出插件）', 'test-client-materialize.mjs')) process.exit(1);

// 5) 配置写入契约：把“保存成功但值没变”这种最坏的失败方式拦在门外
//    （上游原本只白名单 pets + 三个开关，PUT 别的字段返回 200 却静默丢弃，实测踩过）
if (!run('test-config-write（配置写入契约）', 'test-config-write.mjs')) process.exit(1);

// 5) 复制到 release/（复制，不是链接）
console.log('[deploy] 全部通过 → 写入 release/');
mkdirSync(releaseLib, { recursive: true });

const files = ['index.js', 'client.js'];
for (const f of files) {
  const src = join(libDir, f);
  if (!existsSync(src)) {
    console.error(`[deploy] 缺少构建产物: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, join(releaseLib, f));
}

// 桌面运行时代码（Electron helper）也必须进 release：
// 宿主按 PACKAGE_ROOT/runtime/electron-helper/main.js 拉起它，
// 而生产安装的是 release/，所以这里必须带上，否则桌面模式起不来。
const runtimeSrc = join(libDir, 'runtime');
if (!existsSync(runtimeSrc)) {
  console.error('[deploy] 缺少 lib/runtime/ —— 先跑 node scripts/build-runtime.mjs');
  process.exit(1);
}
cpSync(runtimeSrc, join(releaseLib, 'runtime'), { recursive: true });

// cordis.patch.yml 也要进 release（生产靠它挂载 bundle）
const patchSrc = join(pkgRoot, 'cordis.patch.yml');
if (!existsSync(patchSrc)) {
  console.error(`[deploy] 缺少 ${patchSrc}`);
  process.exit(1);
}
copyFileSync(patchSrc, join(releaseDir, 'cordis.patch.yml'));

// ---- release/package.json：每次 deploy 都从主清单**重新生成** ----
// ⚠️ 为什么必须重新生成（实测踩过）：
//   `dsh plugin add file:<dir>` 会**按 package.json 的 files 白名单过滤**要拷的文件。
//   这个文件此前是"一次写好就不再更新"，于是我在主 package.json 里加了
//   `vendor/dsh-pet/assets` 之后，release 里那份仍是旧的 ——
//   结果装到沙箱的包里**没有素材**（vendor/ 整个被过滤掉），
//   而 release 目录里明明有 143 个素材文件。排查花了很久。
//   现在每次 deploy 从 pkg 的 package.json 派生，只覆盖 release 专属字段。
const srcPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const relPkgPath = join(releaseDir, 'package.json');
const prevRel = existsSync(relPkgPath) ? JSON.parse(readFileSync(relPkgPath, 'utf8')) : {};
const relPkg = {
  ...srcPkg,
  // 以下字段是 release 产物专属（或需要覆盖主清单的）
  private: true,
  main: 'lib/index.js',
  exports: prevRel.exports ?? srcPkg.exports,
  files: srcPkg.files, // ← 必须跟着主清单走，否则会漏拷文件
};
delete relPkg.scripts; // release 不需要构建脚本
writeFileSync(relPkgPath, JSON.stringify(relPkg, null, 2), 'utf8');
console.log(`[deploy] release/package.json 已同步（files: ${(relPkg.files ?? []).join(', ')}）`);

// ---- 许可与第三方署名（发布门禁的一部分） ----
// 本包内含 vendor 自 dsh-pet 的代码（MIT）。按 MIT 与上游二创约定，
// 分发时必须带上版权声明、许可原文与署名。漏掉就等于违反许可，
// 所以这里把"许可文件存在"也做成硬门禁，而不是尽力而为。
for (const f of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  const src = join(pkgRoot, f);
  if (!existsSync(src)) {
    console.error(`[deploy] 缺少许可文件 ${f} —— 本包含第三方代码，必须随之分发`);
    process.exit(1);
  }
  copyFileSync(src, join(releaseDir, f));
}

// 上游 LICENSE 原文与出处说明也要带上（MIT 要求保留版权与许可原文）
const upstreamDir = join(pkgRoot, 'vendor', 'dsh-pet');
for (const rel of [join('vendor', 'dsh-pet', 'LICENSE'), join('vendor', 'dsh-pet', 'README.dsh-app.md')]) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) {
    console.error(`[deploy] 缺少 ${rel} —— vendor 代码的许可/出处说明必须随之分发`);
    process.exit(1);
  }
  const dest = join(releaseDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
void upstreamDir;

// 素材：随包分发（维护者 2026-09-30 决定「接受再分发与体积」）。
// 目的：用户装本包一个命令即可用，不必再单独装上游 dsh-pet 取素材。
// ⚠️ 两个前提缺一不可：
//   ① package.json 的 files 必须显式列出 vendor/dsh-pet/assets
//      （否则 `dsh plugin add` 不会带上它 —— 实测踩过）
//   ② 这里要把素材拷进 release/（否则部署装的是不含素材的版本）
const assetsSrc = join(pkgRoot, 'vendor', 'dsh-pet', 'assets');
if (!existsSync(assetsSrc)) {
  console.error('[deploy] 缺少 vendor/dsh-pet/assets —— 自带素材缺失，用户将拿不到立绘/动画/字体');
  process.exit(1);
}
const assetsDest = join(releaseDir, 'vendor', 'dsh-pet', 'assets');
cpSync(assetsSrc, assetsDest, { recursive: true });
const assetCount = (dir) => {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += assetCount(p);
    else n += 1;
  }
  return n;
};
console.log(`[deploy] 自带素材已随包分发：${assetCount(assetsDest)} 个文件`);

// 5) 写一份部署记录，便于回溯"生产上是哪次构建"
const stamp = {
  deployedAt: new Date().toISOString(),
  clientBytes: statSync(join(releaseLib, 'client.js')).size,
  hostBytes: statSync(join(releaseLib, 'index.js')).size,
  source: 'packages/dsh-efficiency/lib',
};
writeFileSync(join(releaseDir, 'DEPLOY.json'), JSON.stringify(stamp, null, 2), 'utf8');

console.log(`[deploy] release/lib/client.js  ${stamp.clientBytes} B`);
console.log(`[deploy] release/lib/index.js   ${stamp.hostBytes} B`);
console.log('[deploy] 完成。生产若指向 release/，重启后即生效。');
