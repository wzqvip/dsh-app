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

// ---------------------------------------------------------------------------
console.log('[patch-vendor] 施加我们对上游代码的改动');

/**
 * 在文件里做一次「标记 + 替换」。
 *
 * ⚠️ 实现要点（踩过多次，都写在这）：
 *  1) **不能用 split/join**：替换文本自身包含 `find` 那段原文（我们在它前面加护栏），
 *     join 会把原文又插回去 → 文件被写坏（标记跑到开头、目标行重复）。必须按位置切片。
 *  2) **幂等靠"替换内容里的标记行是否已存在"**。由此推出两条硬规则：
 *     · 每条替换都必须带 `[dsh-app]` 标记，否则第二次运行会找不到旧锚点而报错；
 *     · **改动替换内容时必须同时改标记行**，否则被判为"已打过"而静默跳过，
 *       新内容永远写不进去（把 4 个可写字段扩成 7 个时踩过）。
 *  3) **绝对不要在补丁前删除已有的标记行**（曾试过"先清标记再重放"想提高可重复性，
 *     结果幂等判定失效 → 代码块被重复插入，`const extra` 出现两次、编译失败）。
 *     正确做法：补丁只在**干净源码**上跑；要重放时先把 vendor 重置到上游原样
 *     （`git checkout <vendor 入库那次提交> -- packages/dsh-efficiency/vendor`）再跑本脚本。
 *  4) 换行符要规范化：Windows 检出是 CRLF 而锚点用 \n 写，不处理则多行锚点永不匹配。
 *
 * @param {string} rel      相对 vendor/dsh-pet 的路径
 * @param {string} find     要替换的原文
 * @param {string} replace  替换后的内容（应含 MARK）
 * @param {string} what     这次改动是什么（用于日志）
 * @param {number} [nth]    目标原文若出现多次，指定第几处（1-based）
 */
function patch(rel, find, replace, what, nth) {
  const abs = join(vendorSrc, rel);
  if (!existsSync(abs)) {
    failures.push(`${rel}: 文件不存在`);
    return;
  }
  const raw = readFileSync(abs, 'utf8');
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
 * [dsh-app] 素材根：**优先本包自带的素材**（vendor/dsh-pet/assets），
 * 找不到才回落到已安装的 dsh-pet 包。
 *
 * 为什么改成"自带优先"（2026-09-30 维护者决定）：
 *   素材此前不随仓库分发，用户必须另装一份 dsh-pet 才能有立绘 —— 多一步操作。
 *   现在素材随包分发，用户装本包一个命令即可用。既然要自包含，
 *   就该**用自己的那份**：否则同一台机器上装了不同版本的 dsh-pet 时，
 *   实际播放的素材会取决于环境、难以复现。
 *
 * 回退链仍然保留：万一打包时漏了 assets（或有人裁剪了发布包），
 * 还能退到已安装的 dsh-pet，不至于整个宠物不可用。
 */
const BUNDLED_ASSETS = join(PACKAGE_ROOT, 'vendor', 'dsh-pet', 'assets');
const ASSET_ROOT = existsSync(BUNDLED_ASSETS)
  ? BUNDLED_ASSETS
  : join(DSH_PET_ROOT ?? PACKAGE_ROOT, 'assets');
if (existsSync(BUNDLED_ASSETS)) {
  console.log('[dsh-app] 素材根: ' + ASSET_ROOT + ' （自带）');
} else if (DSH_PET_ROOT) {
  console.log('[dsh-app] 素材根: ' + ASSET_ROOT + ' （回退到已安装的 dsh-pet）');
  console.warn('[dsh-app] 本包未自带素材（vendor/dsh-pet/assets 缺失），已回退到已安装的 dsh-pet。');
} else {
  console.error(
    '[dsh-app] 找不到宠物素材：本包未自带（vendor/dsh-pet/assets 缺失），' +
      '且系统里也没有已安装的 dsh-pet（无立绘/表情包/字体/内置默认配置）。\\n' +
      '          正常情况下本包会自带素材，出现此提示说明发布包不完整；\\n' +
      '          临时可用：dsh plugin --profile <你的 profile> add dsh-pet',
  );
}

/** 包内 assets 根（表情包池解析用：assets/memes/<名称>.png） */
const PACKAGE_ROOT_ASSETS = ASSET_ROOT;`,
  // ⚠️ 改上面的替换内容时**必须同时改这行标记**，否则幂等判定认为"已打过"而跳过
  '定义素材根（自带优先，回退到已安装的 dsh-pet）',
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

// ---------------------------------------------------------------------------
// 改动 2.5：默认显示位置从 both 改为 **desktop**
//
// 为什么（2026-09-30 维护者要求）：默认桌面宠物、需要时可切 web。
//   桌宠的价值在"不打开网页也能看到提问" —— 默认落在桌面更贴合这个定位。
//   仍可随时切回：设置窗口/设置页的「显示位置」四选一（web/desktop/both/none）。
//
// ⚠️ 必须同时改**三处**，少一处就自相矛盾：
//   ① `assets/config.jsonc` 的注释（写着"缺失按默认 both 处理"）
//   ② 同文件的默认值 `"display": "both"`
//   ③ 客户端设置分区的兜底 `: 'both'`（未读到配置时用它）
//   另：文案 displayHint 里也建议把 desktop 说在前（见 src/client/app.js）。
// ---------------------------------------------------------------------------
patch(
  join('assets', 'config.jsonc'),
  `      "display": "both",`,
  `      "display": "desktop", // [dsh-app] 默认桌面宠物；需要时可在设置里切 web/both`,
  '默认显示位置：both → desktop（默认桌面宠物）',
);
patch(
  join('assets', 'config.jsonc'),
  `  //   缺失按默认 both 处理并告警（兼容 ≤0.2.0 旧配置），写了非法值即配置错误；桌面模式渲染`,
  // ⚠️ 替换文本**必须带 [dsh-app] 标记**：幂等判定就是按它判断"是否已打过"。
  //    第一版这条忘了加标记，于是复跑时判定失效、去找已不存在的旧原文并**报错**
  //    （patch-vendor 因此从幂等变成"跑一次就坏"）。实测过。
  `  //   缺失按默认 desktop 处理并告警（本仓库改为默认桌面宠物；上游为 both），写了非法值即配置错误；桌面模式渲染 // [dsh-app]`,
  '默认显示位置注释同步：both → desktop',
);

// ---------------------------------------------------------------------------
// 改动 3：扩大配置写入白名单，让设置 GUI 能真正管到这些字段
//
// 问题：上游 saveUserConfig 的白名单只有 pets + 三个全局开关。
//   实测：PUT 里带 whisperPrompt / chatMemoryRounds 会返回 200，
//   但值【静默不生效】（被当"非白名单"丢掉，走 existing 透传旧值）。
//   对设置窗口来说这是最坏的失败方式 —— 用户以为保存了。
//
// 修法：新增 4 个可写字段，每个都做类型/范围校验
//   （非法就 return null → 宿主回 400 并说明，不静默忽略）：
//     whisperPrompt      string，≤2000
//     chatMemoryRounds   int 0..50
//     eventsRefreshSec   int 1..3600
//     workStatusTexts    长度 6 的 string[]（每档 ≤20 句，每句 ≤200）
//   physics / animations / animationWeights / memes 仍走透传保留，不在本期范围。
// ---------------------------------------------------------------------------
patch(
  join('src', 'host', 'config.ts'),
  `  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;`,
  `  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;
  // [dsh-app] 以下 7 个字段新增为可写：本仓库的设置 GUI 需要它们。
  //   （whisperPrompt / chatMemoryRounds / eventsRefreshSec / workStatusTexts /
  //     physics / animationWeights —— 前 4 个 + 后 2 个）
  // ⚠️ 幂等陷阱：改动这段替换内容时**必须同时改这行标记**，
  //    否则该补丁的幂等判定（按标记行判断"是否已打过"）会认为已应用而直接跳过，
  //    新内容永远写不进去（本轮就踩了：把 4 个字段扩到 7 个，标记没改，patch 报"已打过"）。
  // 每个都显式校验；非法一律 return null（宿主回 400 并给出原因），
  // 绝不静默丢弃 —— "保存成功但值没变"是最难排查的失败方式（实测过）。
  const extra = {};
  const wp = o.whisperPrompt;
  if (wp !== undefined) {
    if (typeof wp !== 'string' || wp.length > 2000) return null;
    extra.whisperPrompt = wp;
  }
  const cmr = o.chatMemoryRounds;
  if (cmr !== undefined) {
    if (typeof cmr !== 'number' || !Number.isInteger(cmr) || cmr < 0 || cmr > 50) return null;
    extra.chatMemoryRounds = cmr;
  }
  // ⚠️ eventsRefreshSec 是【按事件键的对象】（{balance, whisper}），不是单个整数。
  //    我最初按整数写，结果它被合并器静默丢弃、退回内置默认
  //    （实测：写了 30，磁盘上根本没有这个字段，接口仍返回 {balance:1800,whisper:300}）。
  //    这正是"保存成功但值没变"那类最难发现的失败，所以这里改成对象并逐键校验。
  const ers = o.eventsRefreshSec;
  if (ers !== undefined) {
    if (!ers || typeof ers !== 'object' || Array.isArray(ers)) return null;
    const allowed = ['balance', 'whisper'];
    const cleanErs = {};
    for (const key of Object.keys(ers)) {
      if (!allowed.includes(key)) return null; // 未知键：显式拒绝，不静默丢
      const v = ers[key];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 86400) return null;
      cleanErs[key] = v;
    }
    if (Object.keys(cleanErs).length === 0) return null;
    extra.eventsRefreshSec = cleanErs;
  }
  // physics：与内置默认同形的 6 个键，逐个做范围校验
  const phy = o.physics;
  if (phy !== undefined) {
    if (!phy || typeof phy !== 'object' || Array.isArray(phy)) return null;
    const ranges = {
      gravity: [0, 100000],
      restitution: [0, 1],
      groundFriction: [0, 100],
      throwPower: [0, 10],
    };
    const bools = ['ceilingBounce', 'petCollision'];
    const cleanPhy = {};
    for (const key of Object.keys(phy)) {
      const v = phy[key];
      if (ranges[key]) {
        const [lo, hi] = ranges[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return null;
        cleanPhy[key] = v;
      } else if (bools.includes(key)) {
        if (typeof v !== 'boolean') return null;
        cleanPhy[key] = v;
      } else {
        return null; // 未知键：显式拒绝
      }
    }
    if (Object.keys(cleanPhy).length === 0) return null;
    // ⚠️ physics 的校验（topFieldValid → physicsValid）要求**全部 6 个键**都在，
    //    只传一部分会被判非法、退回内置默认 —— 表现为"PUT 返回 200 但值没变"
    //    （而且磁盘上明明写进去了，PUT 响应体却是默认值；设置窗口随后用响应体
    //     刷新界面，用户就看到"保存没生效"）。实测踩过。
    //    所以这里把请求体里的部分对象**与用户层现有值合并**，写成完整对象。
    const existPhy = existing && typeof existing === 'object' ? existing.physics : undefined;
    extra.physics = {
      ...(existPhy && typeof existPhy === 'object' ? existPhy : {}),
      ...cleanPhy,
    };
  }
  // animationWeights：idle/turn/move 三个非负整数权重
  const aw = o.animationWeights;
  if (aw !== undefined) {
    if (!aw || typeof aw !== 'object' || Array.isArray(aw)) return null;
    const allowedAw = ['idle', 'turn', 'move'];
    const cleanAw = {};
    for (const key of Object.keys(aw)) {
      if (!allowedAw.includes(key)) return null;
      const v = aw[key];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1000) return null;
      cleanAw[key] = v;
    }
    if (Object.keys(cleanAw).length === 0) return null;
    // 同 physics：weightsValid 要求 idle/turn/move **三个键都在**，部分对象会被
    // 判非法并退回默认。与用户层现有值合并成完整对象再写。
    const existAw = existing && typeof existing === 'object' ? existing.animationWeights : undefined;
    extra.animationWeights = {
      ...(existAw && typeof existAw === 'object' ? existAw : {}),
      ...cleanAw,
    };
  }
  const wst = o.workStatusTexts;
  if (wst !== undefined) {
    if (!Array.isArray(wst) || wst.length !== 6) return null;
    for (const group of wst) {
      if (!Array.isArray(group) || group.length > 20) return null;
      for (const line of group) {
        if (typeof line !== 'string' || line.length > 200) return null;
      }
    }
    extra.workStatusTexts = wst;
  }
  // memes：表情包池（键 = assets/memes/<键>.png 的文件名，值 = 该图的内容描述）。
  // ⚠️ 与 physics/animationWeights 不同：memes **不在** topFieldValid 里
  //    （走 default: return true），所以写入不会被退回默认；
  //    非法值由 readMemePool 兜底成空池（不会崩）。但"静默变空池"同样难发现，
  //    所以这里自己做严格校验：
  //      · 键/值都必须是字符串；键不能含路径分隔符（它会被拼进文件路径）
  //      · 键长度 ≤64、值长度 ≤300；条数 ≤200（防配置爆炸）
  //      · 允许传空对象（= 清空表情包池），但不允许非对象
  const memes = o.memes;
  if (memes !== undefined) {
    if (!memes || typeof memes !== 'object' || Array.isArray(memes)) return null;
    const keys = Object.keys(memes);
    if (keys.length > 200) return null;
    const cleanMemes = {};
    for (const k of keys) {
      if (typeof k !== 'string' || k.length === 0 || k.length > 64) return null;
      // 键会被拼进文件路径（assets/memes/<键>.png），所以禁止分隔符与 . / ..
      // ⚠️ 这里【既不用正则、也不写字面反斜杠】：这段代码要经过本脚本的模板字符串，
      //    正则 /[/\\]/ 会被处理成非法正则（实测 Unterminated regexp literal）；
      //    写四个反斜杠又会折叠成单个、变成非法字符串（实测 Expected ident）。
      //    用 charCode 最稳。
      const BACKSLASH = String.fromCharCode(92);
      if (k.includes('/') || k.includes(BACKSLASH) || k === '.' || k === '..') return null;
      const v = memes[k];
      if (typeof v !== 'string' || v.length > 300) return null;
      cleanMemes[k] = v;
    }
    extra.memes = cleanMemes;
  }
  // animations：动画池。
  // ⚠️ animationsValid（topFieldValid 的分支）要求**整个结构都完整**：
  //      idle/turn/drag/clicks 必须是数组、moves.default 与 moves.actions 必须在、
  //      categories 必须是数组、events 每个池必须**非空**且成员非空串。
  //    缺任何一项 → 判非法 → 退回内置默认（又是"磁盘写了、响应是默认值"）。
  //    所以这里把请求体与用户层现有值合并，再逐项校验结构完整性；
  //    设置 GUI 本来就是在完整结构上改，提交的就是完整对象。
  const anims = o.animations;
  if (anims !== undefined) {
    if (!anims || typeof anims !== 'object' || Array.isArray(anims)) return null;
    // ⚠️ 这里**不做部分合并** —— 必须是完整结构。
    //    曾经的做法是"与 existing 浅合并再校验"，结果是：调用方只发
    //    {idle,...} 而缺 moves 时，moves 被我的合并补上 → 通过校验 → 落盘。
    //    而调用方那份对象里 clicks: [] 之类会把用户的既有清单**清空**，
    //    接口返回的却是合并后的"看起来正常"的值 —— 又一次静默失真（本轮实测踩到：
    //    磁盘上 animations.clicks 变成 0 项，而 curl 看到的却是默认 5 项）。
    //    所以：要么给完整结构，要么别传这个字段。
    for (const k of ['idle', 'turn', 'drag', 'clicks']) {
      if (!Array.isArray(anims[k])) return null;
    }
    const mv = anims.moves;
    if (!mv || typeof mv !== 'object' || Array.isArray(mv)) return null;
    if (!mv.default || typeof mv.default !== 'object' || Array.isArray(mv.default)) return null;
    if (!Array.isArray(mv.actions)) return null;
    if (!Array.isArray(anims.categories)) return null;
    const ev = anims.events;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
    const evKeys = Object.keys(ev);
    if (evKeys.length === 0) return null;
    for (const ek of evKeys) {
      const pool = ev[ek];
      if (!Array.isArray(pool) || pool.length === 0) return null;
      for (const slot of pool) {
        if (typeof slot === 'string') {
          if (slot.length === 0) return null;
        } else if (Array.isArray(slot)) {
          if (slot.length === 0) return null;
          for (const nm of slot) {
            if (typeof nm !== 'string' || nm.length === 0) return null;
          }
        } else {
          return null;
        }
      }
    }
    extra.animations = anims;
  }`,
  '配置写入白名单：新增 whisperPrompt / chatMemoryRounds / eventsRefreshSec / workStatusTexts / physics / animationWeights / memes / animations（含校验）',
);

patch(
  join('src', 'host', 'config.ts'),
  `  if (cie !== undefined) outConfig.chatImageEnabled = cie;`,
  `  if (cie !== undefined) outConfig.chatImageEnabled = cie;
  // [dsh-app] 新增可写字段：只在请求体携带时写入（未携带则走下方透传保留磁盘旧值）
  for (const k of Object.keys(extra)) {
    outConfig[k] = extra[k];
  }`,
  '配置写入白名单：把新增字段写进结果',
);

patch(
  join('src', 'host', 'config.ts'),
  `  if (cie !== undefined) bodyOwned.add('chatImageEnabled');`,
  `  if (cie !== undefined) bodyOwned.add('chatImageEnabled');
  // [dsh-app] 新增可写字段同样标记为"由请求体拥有"，否则会被下方透传逻辑用磁盘旧值覆盖
  for (const k of Object.keys(extra)) {
    bodyOwned.add(k);
  }`,
  '配置写入白名单：新增字段标记为请求体所有（否则被磁盘旧值覆盖）',
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
// 改动 4：桌面宠物右键菜单新增「设置…」入口
//
// 四处联动（缺任何一处，菜单点了都没反应）：
//   a) sprite.js   tools 数组加一项（菜单里出现）
//   b) sprite.js   onMenuAction 加分支（点了做事）
//   c) preload.js  暴露 openSettings 桥方法（渲染层 -> 主进程）
//   d) main.js     监听 IPC 并开设置窗口
//
// 为什么设置窗口由【主进程】开、而不是宿主开（很重要）：
//   配置保存后会触发宿主侧 restartHelper（syncSavedConfig 重解析桌面宠物）。
//   若设置窗口挂在助手进程上，用户每改一项保存就会被连窗一起重启掉。
//   主进程持有该窗口即可避开这个循环。
//
// 设置窗口自身的文件（settings.html/css/js + settings-preload.js）是**我们自研**的，
// 不放 vendor —— 它们在 src/desktop/，由 build-runtime.mjs 叠加进 lib/runtime/。
// ---------------------------------------------------------------------------

// a) 菜单项
patch(
  join('runtime', 'electron-helper', 'sprite.js'),
  `      { label: '对话', action: 'chat' },
      { label: '回到初始位置', action: 'home' },`,
  `      { label: '对话', action: 'chat' },
      // ${MARK} 设置入口：开本仓库自己的设置窗口（不是浏览器）
      { label: '设置…', action: 'settings' },
      { label: '回到初始位置', action: 'home' },`,
  '右键菜单新增「设置…」项',
);

// b) 菜单动作分支
patch(
  join('runtime', 'electron-helper', 'sprite.js'),
  `    if (leaf.action === 'home') {`,
  `    // ${MARK} 设置：交给主进程开一个普通设置窗口（幂等）。
    // 不在渲染进程里造窗口 —— 渲染层是透明小窗，承载不了常规表单。
    if (leaf.action === 'settings') {
      if (window.petBridge && typeof window.petBridge.openSettings === 'function') {
        window.petBridge.openSettings();
      } else {
        console.error('[dsh-app] petBridge.openSettings 不可用，无法打开设置窗口');
      }
      return;
    }
    if (leaf.action === 'home') {`,
  '菜单动作分发「设置…」',
);

// c) preload 桥方法
patch(
  join('runtime', 'electron-helper', 'preload.js'),
  `  // ---- 宠物间碰撞（跨窗 broker）----`,
  `  // ${MARK} 右键菜单「设置…」：主进程开一个普通设置窗口（幂等，已开则聚焦）
  openSettings() {
    ipcRenderer.send('pet:open-settings');
  },
  // ---- 宠物间碰撞（跨窗 broker）----`,
  'preload 暴露 openSettings 桥方法',
);

// d) 主进程开窗 + 关窗 IPC
// 锚点用 open-site 处理器的收尾（那一段在本文件里唯一）
patch(
  join('runtime', 'electron-helper', 'main.js'),
  `      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  });`,
  `      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  });

  // ${MARK} 右键菜单「设置…」：开一个**普通的设置窗口**（不是透明小窗）。
  //
  // 为什么单独做窗口而不是交给系统浏览器：
  //   设置项要频繁试改（大小/位置/开关），每次跳浏览器割裂感太强；
  //   而且用户可能根本没开网页端。这是本仓库新增的能力。
  //
  // 为什么由主进程持有：
  //   保存配置会触发宿主 restartHelper，若窗口挂在助手进程上就会被一起重启。
  //
  // 幂等：已开着则聚焦复用，不重复开窗。
  let settingsWin = null;
  ipcMain.on('pet:open-settings', () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show();
      settingsWin.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 720,
      height: 760,
      minWidth: 520,
      minHeight: 480,
      title: '桌宠设置',
      autoHideMenuBar: true,
      backgroundColor: '#f6f7f9',
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.removeMenu();
    win.loadFile('settings.html');
    win.on('closed', () => {
      settingsWin = null;
    });
    settingsWin = win;
  });
  // 设置窗口自己的关闭按钮：只关它，不影响宠物窗口
  ipcMain.on('pet:settings-close', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) w.close();
  });`,
  '主进程开设置窗口 + 关窗 IPC',
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
