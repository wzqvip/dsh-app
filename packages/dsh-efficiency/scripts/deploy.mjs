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
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
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

// 4) 复制到 release/（复制，不是链接）
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

// cordis.patch.yml 也要进 release（生产靠它挂载 bundle）
const patchSrc = join(pkgRoot, 'cordis.patch.yml');
if (!existsSync(patchSrc)) {
  console.error(`[deploy] 缺少 ${patchSrc}`);
  process.exit(1);
}
copyFileSync(patchSrc, join(releaseDir, 'cordis.patch.yml'));

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
