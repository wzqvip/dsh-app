/**
 * 部署前预检（只读，不改任何东西）。
 *
 * 用途：维护者说"可以部署了"之后，先跑这个 —— 它把目标里那些要求逐条核一遍，
 * 而不是靠记忆。全绿再用 npm run deploy。
 *
 * 检查项（每条都对应目标里的一句话）：
 *   1. 工作区干净、本地与远端一致（避免部署了没入库的东西）
 *   2. vendor 只含【代码】，且带上游 MIT LICENSE 原文，且不含任何素材
 *   3. 署名与许可文件齐备（LICENSE / THIRD-PARTY-NOTICES / 上游 LICENSE）
 *   4. 五道 deploy 门禁全绿
 *   5. release/ 产物完整（lib + runtime + 许可）
 *   6. 生产当前【没有】加载本插件（确认我们的操作没有意外影响生产）
 *   7. 沙箱在跑、且素材来自已安装的 dsh-pet 包
 *
 * 用法：node scripts/preflight.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');

let failures = 0;
let warnings = 0;
const ok = (label, extra = '') => console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`);
const bad = (label, extra = '') => {
  console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`);
  failures += 1;
};
const warn = (label, extra = '') => {
  console.log(`  ⚠️  ${label}${extra ? `  ${extra}` : ''}`);
  warnings += 1;
};
const info = (label) => console.log(`     ${label}`);

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch (err) {
    return `__ERR__ ${String(err.message).split('\n')[0]}`;
  }
};

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';

// ---------------------------------------------------------------------------
console.log('[preflight] 1) 仓库状态');
const dirty = git(['status', '--porcelain']);
// release/DEPLOY.json 每次 deploy 都会改，属预期噪音
const dirtyLines = dirty ? dirty.split('\n').filter((l) => l.trim()) : [];
const meaningful = dirtyLines.filter((l) => !/release[\\/]DEPLOY\.json$/.test(l));
if (meaningful.length === 0) {
  ok('工作区干净（release/DEPLOY.json 的时间戳漂移不算）');
} else {
  bad('工作区有未提交改动，先提交再部署', meaningful.slice(0, 5).join(' | '));
}
const head = git(['rev-parse', 'HEAD']);
const origin = git(['rev-parse', 'origin/main']);
if (head && origin && head === origin) ok('本地与 origin/main 一致', head.slice(0, 8));
else bad('本地与远端不一致', `${head?.slice(0, 8)} vs ${origin?.slice(0, 8)}`);

// ---------------------------------------------------------------------------
console.log('');
console.log('[preflight] 2) vendor 只含代码、带 MIT LICENSE、不含素材');
const vendorDir = join(pkgRoot, 'vendor', 'dsh-pet');
if (!existsSync(vendorDir)) {
  bad('vendor/dsh-pet 不存在');
} else {
  const upstreamLicense = join(vendorDir, 'LICENSE');
  if (existsSync(upstreamLicense)) {
    const txt = readFileSync(upstreamLicense, 'utf8');
    if (/MIT License/i.test(txt) && /PC2005-cloud/.test(txt)) ok('上游 MIT LICENSE 原文在库（含版权行）');
    else bad('上游 LICENSE 内容不像 MIT/缺版权行');
  } else {
    bad('缺上游 LICENSE 原文（MIT 要求保留）');
  }

  // 递归找素材类文件
  const mediaExt = /\.(png|jpe?g|gif|webp|svg|webm|mov|mp4|ttf|otf|woff2?|mp3|wav)$/i;
  const media = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (mediaExt.test(name)) media.push(p.replace(vendorDir, '').replace(/\\/g, '/'));
    }
  };
  walk(vendorDir);
  if (media.length === 0) ok('vendor 内没有任何素材文件（上游素材禁商用，不能进仓库）');
  else bad(`vendor 里出现素材文件 ${media.length} 个`, media.slice(0, 5).join(', '));

  if (existsSync(join(vendorDir, 'README.dsh-app.md'))) ok('出处说明 README.dsh-app.md 在库');
  else warn('缺 vendor/dsh-pet/README.dsh-app.md（出处说明）');

  // ---- 代码完整性 + 改动边界 + 来源可追溯（AGENTS.md §4.1 的三条规则）----
  // ① 代码完整：src/ 与 runtime/ 的文件数必须与**已安装的上游包**一致。
  //    只验"没有素材"是不够的 —— 漏 vendor 某个源文件要到运行时才炸。
  const upPkg = join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-pet');
  if (existsSync(upPkg)) {
    for (const sub of ['src', 'runtime']) {
      const a = join(upPkg, sub);
      const b = join(vendorDir, sub);
      if (!existsSync(a) || !existsSync(b)) continue;
      const count = (dir) => {
        let n = 0;
        const w = (d) => {
          for (const name of readdirSync(d)) {
            const p = join(d, name);
            if (statSync(p).isDirectory()) w(p);
            else n += 1;
          }
        };
        w(dir);
        return n;
      };
      const nUp = count(a);
      const nOurs = count(b);
      if (nOurs === nUp) ok(`vendor/${sub} 代码完整`, `${nOurs}/${nUp} 文件`);
      else bad(`vendor/${sub} 文件数不一致`, `上游 ${nUp} / 我们 ${nOurs}`);
    }
    // 版本一致性（记录 vs 实际安装的上游）
    try {
      const upVer = JSON.parse(readFileSync(join(upPkg, 'package.json'), 'utf8')).version;
      const rd = join(vendorDir, 'README.dsh-app.md');
      if (existsSync(rd)) {
        const txt = readFileSync(rd, 'utf8');
        if (txt.includes(`\`${upVer}\``)) ok('记录的上游版本与实际安装的一致', upVer);
        else bad('记录的上游版本与实际安装的不一致', `实际 ${upVer}`);
        if (/\b[0-9a-f]{40}\b/.test(txt)) ok('记录了上游 commit 哈希（可精确回溯）');
        else warn('未记录上游 commit 哈希');
      }
    } catch {
      warn('读上游 package.json 失败，跳过版本核对');
    }
  } else {
    warn('找不到已安装的上游 dsh-pet，跳过代码完整性核对');
  }

  // ② 改动边界可辨：我们改过的每个文件都必须带 [dsh-app] 标记。
  //    改动的文件清单从 patch-vendor.mjs 里抽（那是唯一真相来源）。
  const patcher = join(pkgRoot, 'scripts', 'patch-vendor.mjs');
  if (existsSync(patcher)) {
    const src = readFileSync(patcher, 'utf8');
    const rels = new Set();
    for (const m of src.matchAll(/join\(\s*'([a-zA-Z0-9_.-]+)'\s*,\s*'([a-zA-Z0-9_.-]+)'\s*,\s*'([a-zA-Z0-9_.-]+)'\s*\)/g)) {
      rels.add(join(m[1], m[2], m[3]));
    }
    let marked = 0;
    const unmarked = [];
    for (const rel of rels) {
      const p = join(vendorDir, rel);
      if (!existsSync(p)) {
        unmarked.push(`${rel}(缺失)`);
        continue;
      }
      if (readFileSync(p, 'utf8').includes('[dsh-app]')) marked += 1;
      else unmarked.push(rel);
    }
    if (unmarked.length === 0) ok(`改动过的 ${marked} 个文件都带 [dsh-app] 标记（改动边界可辨）`);
    else bad('有改动文件缺 [dsh-app] 标记（边界不可辨）', unmarked.join(', '));
  }
}

// ---------------------------------------------------------------------------
console.log('');
console.log('[preflight] 3) 署名与许可文件');
for (const f of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  const p = join(pkgRoot, f);
  if (!existsSync(p)) {
    bad(`缺包根 ${f}`);
    continue;
  }
  const txt = readFileSync(p, 'utf8');
  if (f === 'THIRD-PARTY-NOTICES.md') {
    if (/PC2005-cloud\/dsh-pet/.test(txt) && /禁止商用|禁商用/.test(txt)) {
      ok(`${f} 写明上游出处与素材禁商用`);
    } else {
      bad(`${f} 缺上游署名或素材限制说明`);
    }
  } else {
    ok(`${f} 在库`);
  }
}

// ---- 署名义务覆盖（AGENTS.md §4 硬约束）----
// 逐条核对"必须在任何介绍/展示/分发处署名"这条要求是否真的落到文件上。
// ⚠️ LICENSE 本身不参与：那是**本包自己的** MIT（Copyright (c) 2026 wzqvip）。
//    第三方署名义务在 NOTICE / THIRD-PARTY-NOTICES 里 —— 一开始我误把 LICENSE
//    也当成"该有上游 URL"的地方，那是判据搞错了。
const ATTRIB = /PC2005-cloud\/dsh-pet/;
// ⚠️ 这里用 join(pkgRoot,'release') 而不是 releaseDir —— 后者在第 5 节才声明，
//    在它之前引用会抛 TDZ 错（`Cannot access 'releaseDir' before initialization`）。
const relDirEarly = join(pkgRoot, 'release');
for (const [rel, what] of [
  [join(repoRoot, 'README.md'), '仓库 README（介绍）'],
  [join(repoRoot, 'NOTICE.md'), '仓库 NOTICE（署名义务）'],
  // ⚠️ 文档结构在 2026-09-30 调整过：次要文档移进 docs/，根目录只留
  //    README / plan / todo / STATUS / AGENTS / NOTICE。
  //    这里原先写的是根目录 CONTRIBUTING.md，搬走后 preflight 立刻报
  //    "署名材料缺失" —— 正好说明这条检查是有效的。以后搬文档记得同步此处。
  [join(repoRoot, 'docs', 'CONTRIBUTING.md'), '贡献指南'],
  [join(pkgRoot, 'THIRD-PARTY-NOTICES.md'), '包内第三方声明'],
  [join(pkgRoot, 'package.json'), '包清单 contributors'],
  [join(pkgRoot, 'vendor', 'dsh-pet', 'README.dsh-app.md'), 'vendor 出处说明'],
  [join(relDirEarly, 'THIRD-PARTY-NOTICES.md'), '分发包内第三方声明'],
  [join(relDirEarly, 'vendor', 'dsh-pet', 'README.dsh-app.md'), '分发包内出处说明'],
  // ⚠️ **不要**把 vendor/dsh-pet/LICENSE 列进这张表：那是**上游自己的** MIT 原文，
  //    MIT 要求我们"原样保留" —— 它当然不含 GitHub URL，往里加 URL 反而破坏原文。
  //    一开始我把它也列了进来，于是报"缺上游署名 URL"，是判据错了。
  //    它由下面的专门检查覆盖（MIT 字样 + 版权行）。
]) {
  if (!existsSync(rel)) {
    bad(`署名材料缺失：${what}`, rel.replace(repoRoot, '').replace(pkgRoot, ''));
    continue;
  }
  const txt = readFileSync(rel, 'utf8');
  if (ATTRIB.test(txt)) ok(`署名就位：${what}`);
  else bad(`缺上游署名 URL：${what}`, rel.replace(repoRoot, '').replace(pkgRoot, ''));
}
// 分发包必须带上游 MIT 原文（MIT 的硬性要求：保留版权与许可声明）
const relUpLicense = join(relDirEarly, 'vendor', 'dsh-pet', 'LICENSE');
if (existsSync(relUpLicense)) {
  const t = readFileSync(relUpLicense, 'utf8');
  if (/MIT License/i.test(t) && /PC2005-cloud/.test(t)) ok('分发包带上游 MIT 原文（含版权行）');
  else bad('分发包里的上游 LICENSE 内容异常');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('[preflight] 4) deploy 五道门禁');
try {
  const out = execFileSync(process.execPath, [join(here, 'deploy.mjs')], {
    cwd: pkgRoot,
    encoding: 'utf8',
    timeout: 300000,
  });
  const gateLines = out.split('\n').filter((l) => /\[deploy\] .*(\.\.\. OK|门禁|全部通过)/.test(l));
  const failed = out.split('\n').filter((l) => /FAIL/.test(l));
  if (failed.length === 0) {
    ok('deploy 门禁全绿');
    for (const l of gateLines) info(l.replace('[deploy] ', '').trim());
  } else {
    bad('deploy 门禁未通过', failed.slice(0, 4).join(' | '));
  }
} catch (err) {
  bad('deploy 门禁执行失败', String(err.stdout ?? err.message).split('\n').slice(-6).join(' | '));
}

// ---------------------------------------------------------------------------
console.log('');
console.log('[preflight] 5) release/ 产物完整性');
const releaseDir = join(pkgRoot, 'release');
const need = [
  ['lib/index.js', '宿主产物'],
  ['lib/client.js', '客户端产物'],
  ['lib/runtime/electron-helper/main.js', '桌面 helper 入口'],
  ['lib/runtime/electron-helper/settings.html', '设置窗口页面'],
  ['LICENSE', '本包许可'],
  ['THIRD-PARTY-NOTICES.md', '第三方声明'],
  ['vendor/dsh-pet/LICENSE', '上游许可原文'],
  ['cordis.patch.yml', 'bundle 挂载清单'],
];
for (const [rel, what] of need) {
  const p = join(releaseDir, rel);
  if (existsSync(p)) ok(`${what} 在 release：${rel}`);
  else bad(`release 缺 ${rel}（${what}）`);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('[preflight] 6) 生产未被意外影响');
const prodPkg = join(home, '.dsh', 'profiles', 'web', 'package.json');
if (!existsSync(prodPkg)) {
  warn('找不到生产 profile（无法核对）', prodPkg);
} else {
  const j = JSON.parse(readFileSync(prodPkg, 'utf8'));
  const deps = Object.keys(j.dependencies ?? {});
  const bundles = j.dsh?.profile?.bundles ?? [];
  if (deps.includes('dsh-efficiency') || bundles.includes('dsh-efficiency')) {
    bad('生产已经加载 dsh-efficiency —— 与「部署需维护者同意」的现状不符', `bundles=${bundles.join(',')}`);
  } else {
    ok('生产当前未加载本插件', `bundles=${bundles.join(',')}`);
  }
  if (existsSync(join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-efficiency'))) {
    warn('生产 node_modules 里存在 dsh-efficiency（可能是上次部署残留）');
  }
}

// ---------------------------------------------------------------------------
console.log('');
console.log('[preflight] 7) 沙箱（验证环境）');
const sandboxHome = join(home, 'dsh-sandbox');
if (!existsSync(sandboxHome)) {
  warn('沙箱目录不存在', sandboxHome);
} else {
  const sbPkg = join(sandboxHome, 'profiles', 'web', 'package.json');
  if (existsSync(sbPkg)) {
    const j = JSON.parse(readFileSync(sbPkg, 'utf8'));
    const bundles = j.dsh?.profile?.bundles ?? [];
    if (bundles.includes('dsh-efficiency')) ok('沙箱已加载本插件', `bundles=${bundles.join(',')}`);
    else warn('沙箱 bundles 里没有 dsh-efficiency', bundles.join(','));
  } else {
    warn('沙箱 profile 不存在');
  }
  // 素材必须来自【已安装的 dsh-pet】，不能来自我们仓库
  const ourAssets = join(pkgRoot, 'assets');
  if (existsSync(ourAssets)) bad('我们包根出现了 assets/ —— 素材不应随本仓库分发');
  else ok('我们包根没有 assets/（素材不随本仓库分发）');
  const prodAssets = join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-pet', 'assets');
  if (existsSync(prodAssets)) ok('已安装的 dsh-pet 提供素材（运行时读取）');
  else warn('找不到已安装 dsh-pet 的 assets —— 宠物会缺立绘（属预期，需用户自行安装）');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log(`[preflight] PASS${warnings ? `（${warnings} 条告警，不阻断）` : ''}`);
  console.log('[preflight] 可以部署 —— 但**必须维护者明确同意**后才重启生产。');
} else {
  console.log(`[preflight] FAIL: ${failures} 项未通过${warnings ? `，${warnings} 条告警` : ''}`);
}
process.exit(failures === 0 ? 0 : 1);
