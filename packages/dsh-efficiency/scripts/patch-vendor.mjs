/**
 * 对我们 vendor 进来的 dsh-pet 代码施加改动。
 *
 * 为什么单独写成脚本而不是直接手改 vendor 文件：
 *   vendor 目录是上游的副本，将来升级上游时要整体覆盖。手改会在覆盖时丢失，
 *   而且很难回忆"我们到底改了哪些地方"。
 *   把改动收敛成一个**幂等的补丁脚本**，升级流程就变成：
 *     覆盖 vendor/ → 跑 build-vendor → 跑本脚本 → 跑构建
 *   并且每处改动都在文件里留下 [dsh-app] 标记，与上游 diff 时一眼可辨。
 *
 * 幂等保证：每处改动都先检查标记是否存在，已打过就跳过。
 *
 * 用法：node scripts/patch-vendor.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const vendorSrc = join(pkgRoot, 'vendor', 'dsh-pet');

const MARK = '[dsh-app]';

let applied = 0;
let skipped = 0;
const failures = [];

/**
 * 在文件里做一次「标记 + 替换」。
 *
 * ⚠️ 实现要点（踩过）：**不能用 split/join**。
 *    最初写成 `src.split(find)` … `parts.join(find)`，而替换文本自身就包含
 *    `find` 那段原文（我们是在它前面加护栏），join 会把 find 又插回去，
 *    结果是文件被写坏：标记跑到文件开头、目标行重复了一段。
 *    正确做法是按【匹配位置】切片，只替换匹配到的那一段，其余原样保留。
 *
 * @param {string} rel      相对 vendor/dsh-pet 的路径
 * @param {string} find     要替换的原文
 * @param {string} replace  替换后的内容（应含 MARK）
 * @param {string} what     这次改动是什么（用于日志）
 * @param {number} [nth]    目标原文若出现多次，指定要替换第几处（1-based）。
 *                          不传且出现多次 → 报错（迫使调用方明确指定，避免改错地方）
 */
function patch(rel, find, replace, what, nth) {
  const abs = join(vendorSrc, rel);
  if (!existsSync(abs)) {
    failures.push(`${rel}: 文件不存在`);
    return;
  }
  const raw = readFileSync(abs, 'utf8');

  // 换行符规范化：本仓库检出的 Windows 副本是 CRLF，而补丁里的多行锚点用 \n 写。
  // 不处理的话「多行锚点」永远匹配不上（单行锚点不受影响，所以症状很迷惑：
  // 同一批补丁里有的成功有的"找不到目标原文"）。写完再还原原来的换行风格。
  const crlf = raw.includes('\r\n');
  const src = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const findLf = find.replace(/\r\n/g, '\n');
  const replaceLf = replace.replace(/\r\n/g, '\n');

  // 幂等：替换内容里的标记句已存在 → 视为已打过
  const markerLine = replaceLf.split('\n').find((l) => l.includes(MARK));
  if (markerLine && src.includes(markerLine.trim())) {
    skipped += 1;
    console.log(`  = ${rel}: 已打过（${what}）`);
    return;
  }

  // 找出所有匹配位置（不切分字符串，避免污染）
  const positions = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf(findLf, from);
    if (i < 0) break;
    positions.push(i);
    from = i + findLf.length;
  }
  const hits = positions.length;
  if (hits === 0) {
    failures.push(`${rel}: 找不到目标原文（${what}）—— 上游可能已变更，请人工核对`);
    return;
  }
  if (hits > 1 && nth === undefined) {
    failures.push(`${rel}: 目标原文出现 ${hits} 次，请用第 5 个参数指定第几处（${what}）`);
    return;
  }
  const idx = (nth ?? 1) - 1;
  if (idx < 0 || idx >= hits) {
    failures.push(`${rel}: 指定第 ${nth} 处，但实际只有 ${hits} 处（${what}）`);
    return;
  }

  const at = positions[idx];
  let out = src.slice(0, at) + replaceLf + src.slice(at + findLf.length);
  if (crlf) out = out.replace(/\n/g, '\r\n');
  writeFileSync(abs, out, 'utf8');
  applied += 1;
  console.log(`  + ${rel}: ${what}${hits > 1 ? `（第 ${nth} 处 / 共 ${hits} 处）` : ''}`);
}

console.log('[patch-vendor] 施加我们对上游代码的改动');

// ---------------------------------------------------------------------------
// 改动 2：素材根从「本包」改为「已安装的 dsh-pet 包」
//
// 问题：上游按 `PACKAGE_ROOT/assets` 找素材（PACKAGE_ROOT = 本包根）。
//   本仓库按合规要求【不带素材】（dsh-pet 素材禁商用，不能 vendor 进我们仓库），
//   所以合并后 PACKAGE_ROOT 会指向我们包的根，那里没有 assets → 宠物无立绘、
//   无表情包、无字体。
//
// 修法：新增 resolveDshPetAssetRoot()，按**多级回退**定位已安装的 dsh-pet：
//   ① require.resolve('dsh-pet/package.json') —— 最可靠，但依赖宿主模块解析
//   ② 从起点逐级向上找 node_modules/dsh-pet
//   ③ DSH_HOME/profiles/<任一 profile>/node_modules/dsh-pet
//   ④ ~/.dsh/profiles/...
//   ⑤ 从本文件所在目录向上找 dsh-pet 包（兜底）
//   找不到时【大声报错】并继续（宠物缺素材仍能跑，但要让人知道为什么）
// ---------------------------------------------------------------------------
patch(
  join('src', 'host', 'index.ts'),
  `/** 包内 assets 根（表情包池解析用：assets/memes/<名称>.png） */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, 'assets');`,
  `/**
 * [dsh-app] 定位已安装的 dsh-pet 包根目录。
 *
 * 为什么需要：上游按 \`PACKAGE_ROOT/assets\` 找素材，而本仓库**不带素材**
 * （dsh-pet 素材禁商用，不能 vendor 进本仓库）。合并后 PACKAGE_ROOT 指向我们
 * 自己的包根，那里没有 assets。所以素材必须从【已安装的 dsh-pet】读取。
 *
 * 多级回退，尽量在不依赖宿主模块解析的前提下也能找到；全失败时大声报错。
 */
function resolveDshPetRoot(): string | undefined {
  // 动态取 Node 内建模块：避免改动 vendor 文件顶部的 import 区
  // （那里是上游的行，多动一行就多一处冲突面）。
  const nodeRequire = createRequire(import.meta.url);
  const fsSync = nodeRequire('node:fs') as typeof import('node:fs');
  const pathMod = nodeRequire('node:path') as typeof import('node:path');
  const osMod = nodeRequire('node:os') as typeof import('node:os');

  const looksRight = (dir: string): boolean =>
    fsSync.existsSync(pathMod.join(dir, 'assets')) && fsSync.existsSync(pathMod.join(dir, 'package.json'));

  // ① 交给 Node 模块解析（最可靠，但需 dsh-pet 出现在解析链上）
  try {
    const pkgJson = nodeRequire.resolve('dsh-pet/package.json');
    const dir = pathMod.dirname(pkgJson);
    if (looksRight(dir)) return dir;
  } catch {
    /* 继续回退 */
  }

  // ② 从起点逐级向上找 node_modules/dsh-pet
  const start = pathMod.dirname(fileURLToPath(import.meta.url));
  for (let d = start, i = 0; i < 12 && d; d = pathMod.dirname(d), i++) {
    const cand = pathMod.join(d, 'node_modules', 'dsh-pet');
    if (looksRight(cand)) return cand;
  }

  // ③ DSH_HOME/profiles/<任一 profile>/node_modules/dsh-pet
  const scanProfiles = (dshHome: string): string | undefined => {
    const profilesDir = pathMod.join(dshHome, 'profiles');
    if (!fsSync.existsSync(profilesDir)) return undefined;
    try {
      for (const name of fsSync.readdirSync(profilesDir)) {
        const cand = join(profilesDir, name, 'node_modules', 'dsh-pet');
        if (looksRight(cand)) return cand;
      }
    } catch {
      /* 读不了就跳过 */
    }
    return undefined;
  };

  const envHome = process.env.DSH_HOME;
  if (envHome) {
    const viaProfiles = scanProfiles(envHome);
    if (viaProfiles) return viaProfiles;
    // DSH_HOME 也可能就是 .dsh 本身
    const viaProfiles2 = scanProfiles(pathMod.join(envHome, '.dsh'));
    if (viaProfiles2) return viaProfiles2;
  }

  // ④ ~/.dsh/profiles/...
  try {
    const viaDefault = scanProfiles(pathMod.join(osMod.homedir(), '.dsh'));
    if (viaDefault) return viaDefault;
  } catch {
    /* ignore */
  }

  // ⑤ 兜底：从本文件位置向上找 dsh-pet 包（本包恰好被嵌在它里面时的情形）
  for (let d = start, i = 0; i < 12 && d; d = pathMod.dirname(d), i++) {
    if (looksRight(d)) return d;
  }
  return undefined;
}

const DSH_PET_ROOT = resolveDshPetRoot();

/**
 * [dsh-app] 素材根：优先【已安装的 dsh-pet】，找不到才回落本包。
 * 素材不随本仓库分发（上游禁商用），所以"找不到"在一台没装 dsh-pet 的机器上
 * 是预期情况 —— 必须把原因说清楚，否则很难排查。
 */
const ASSET_ROOT = join(DSH_PET_ROOT ?? PACKAGE_ROOT, 'assets');
if (!DSH_PET_ROOT) {
  console.error(
    '[dsh-app] 找不到已安装的 dsh-pet 包，宠物素材不可用（无立绘/表情包/字体/内置默认配置）。\\n' +
      '          素材不随本仓库分发（上游素材禁商用）。请先安装：\\n' +
      '            dsh plugin --profile <你的 profile> add dsh-pet\\n' +
      '          或设置环境变量 DSH_HOME 指向你的 DSH 主目录。',
  );
} else {
  console.log('[dsh-app] 素材根: ' + ASSET_ROOT);
}

/** 包内 assets 根（表情包池解析用：assets/memes/<名称>.png） */
const PACKAGE_ROOT_ASSETS = ASSET_ROOT;`,
  '定义素材根（多级回退定位已安装的 dsh-pet）',
);

// ---- 其余素材引用点统一改指向 ASSET_ROOT ----
// ⚠️ 实测教训：只改 PACKAGE_ROOT_ASSETS 一处【不够】。
//    素材路径在源文件里有 5 处独立引用，漏一处就会在运行时报
//    「内置默认配置缺失或解析失败（安装损坏）」——因为 readAllConfig 拿不到
//    内置默认的 assets/config.jsonc。
//    逐条列出而不是一次全局替换：每处改动在日志里都可见，
//    上游若改了哪一行也能立刻从"找不到锚点"看出来。
//
// ⚠️ 每条替换都带 [dsh-app] 行尾注释 —— patch() 的幂等判定靠"替换内容里的
//    标记句是否已存在"。这 5 处替换若不带标记，第二次运行会找不到旧锚点而报错
//    （踩过）。行尾注释对 JS 语义无影响，但让幂等判定成立。
patch(
  join('src', 'host', 'index.ts'),
  `defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),`,
  `defaultFile: join(ASSET_ROOT, 'config.jsonc'), // ${MARK} 素材在已安装的 dsh-pet 里`,
  '素材路径 → ASSET_ROOT：内置默认配置 defaultFile',
);
patch(
  join('src', 'host', 'index.ts'),
  `    default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),`,
  `    default: join(ASSET_ROOT, 'config.jsonc'), // [dsh-app] 素材在已安装的 dsh-pet 里`,
  '素材路径 → ASSET_ROOT：config/meta 的 default 路径',
);
patch(
  join('src', 'host', 'index.ts'),
  `const assetRootFor = (ext: string): string => join(PACKAGE_ROOT, 'assets', animSubdirFor(ext));`,
  `const assetRootFor = (ext: string): string => join(ASSET_ROOT, animSubdirFor(ext)); // [dsh-app]`,
  '素材路径 → ASSET_ROOT：动画素材根 assetRootFor',
);
patch(
  join('src', 'host', 'index.ts'),
  `const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');`,
  `const fontRoot = join(ASSET_ROOT, 'fonts'); // [dsh-app]`,
  '素材路径 → ASSET_ROOT：字体根 fontRoot',
);
patch(
  join('src', 'host', 'index.ts'),
  `const picRoot = join(PACKAGE_ROOT, 'assets', isMeme ? 'memes' : 'pic');`,
  `const picRoot = join(ASSET_ROOT, isMeme ? 'memes' : 'pic'); // [dsh-app]`,
  '素材路径 → ASSET_ROOT：图片根 picRoot',
);

// 素材根缺失时报警（紧跟定义之后，保证一定会打印）
patch(
  join('src', 'host', 'index.ts'),
  `import { fileURLToPath } from 'node:url';`,
  `import { fileURLToPath } from 'node:url';
// [dsh-app] 用于定位已安装的 dsh-pet 包（素材根，见下方 resolveDshPetRoot）
import { createRequire } from 'node:module';`,
  '补 createRequire 导入（供素材根解析使用）',
);

// ---------------------------------------------------------------------------
// 改动 1：同一工作状态档位内，不要反复打断正在播的动画
//
// 问题：work-status 每次 tick（每个 tool/result 事件）都重新抽一个动画并切过去。
//   虽然 pickSlot 刻意"避开当前正播动画"，但结果是每次 tick 都把正在播的那段
//   打断重开 —— 表现为「搞定一步，继续看看」这类档位动画一直被打断、永远播不完。
//
// 修法：档位【没变】时，若当前正播动画仍属于本档位，就让它继续播，不切。
//   档位变了才重新抽（这才是"切档"的本意）。
//   原代码里 stateChanged 已经算出来了，只是没用于动画决策 —— 这里补上。
// ---------------------------------------------------------------------------

// 浏览器端
patch(
  join('src', 'client', 'pet.ts'),
  `      const stateChanged = prevWorkStateRef.current !== workStatus.state;
      prevWorkStateRef.current = workStatus.state;
      stopMove();`,
  `      const stateChanged = prevWorkStateRef.current !== workStatus.state;
      prevWorkStateRef.current = workStatus.state;
      // ${MARK} 同一档位内不打断正在播的动画。
      // 原实现每次 tick 都重新抽并切换动画（即使刻意避开当前段），结果是
      // 每次 tool/result 都把正在播的那段打断重开 —— 档位动画永远播不完。
      // 档位未变且当前动画仍属于本档位时直接返回（气泡文本已在上面更新过）。
      if (!stateChanged && poolIncludes(pool, animRef.current)) {
        return;
      }
      stopMove();`,
  '同一档位内不打断正在播的动画（浏览器端）',
);

// 桌面端
patch(
  join('runtime', 'electron-helper', 'events.js'),
  `  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）`,
  `  // ${MARK} 同一档位内不打断正在播的动画（与浏览器端 pet.ts 同一处修复）。
  // 原实现每次 tick 都重新抽并切换，导致每个 tool/result 都把正在播的档位动画打断重开。
  // 档位未变且当前动画仍属本档位 → 直接返回，让当前这段播完（气泡文本随后仍会更新）。
  if (!stateChanged && S.poolIncludes(pool, this.anim)) {
    this.renderBubble();
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）`,
  '同一档位内不打断正在播的动画（桌面端）',
  1, // 同一行在 balance 处理器里也出现一次，用序号锁定 work-status 这一处
);

console.log('');
console.log(`[patch-vendor] 应用 ${applied} 处，跳过 ${skipped} 处（已打过）`);
if (failures.length) {
  console.error(`[patch-vendor] ❌ ${failures.length} 处失败：`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
