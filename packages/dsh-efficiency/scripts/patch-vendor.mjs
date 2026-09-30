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
  const src = readFileSync(abs, 'utf8');

  // 幂等：替换内容里的标记句已存在 → 视为已打过
  const markerLine = replace.split('\n').find((l) => l.includes(MARK));
  if (markerLine && src.includes(markerLine.trim())) {
    skipped += 1;
    console.log(`  = ${rel}: 已打过（${what}）`);
    return;
  }

  // 找出所有匹配位置（不切分字符串，避免污染）
  const positions = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf(find, from);
    if (i < 0) break;
    positions.push(i);
    from = i + find.length;
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
  const out = src.slice(0, at) + replace + src.slice(at + find.length);
  writeFileSync(abs, out, 'utf8');
  applied += 1;
  console.log(`  + ${rel}: ${what}${hits > 1 ? `（第 ${nth} 处 / 共 ${hits} 处）` : ''}`);
}

console.log('[patch-vendor] 施加我们对上游代码的改动');

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
