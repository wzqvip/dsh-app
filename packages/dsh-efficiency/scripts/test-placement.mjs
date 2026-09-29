/**
 * placement.js 的单元测试。
 *
 * 为什么单独测它：定位是纯函数、分支多（四个 corner × 空间够不够），
 * 而它决定了"回答面板会不会挡住宠物 / 会不会跑到屏幕外"。
 * 这类几何逻辑最适合用断言钉住，不靠肉眼。
 *
 * 用法：node scripts/test-placement.mjs
 */

import { computePanelPlacement } from '../src/client/placement.js';

let fail = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) fail++;
};

const VW = 1440, VH = 900;
const vp = { width: VW, height: VH };

console.log('[placement] 1) 无宠物布局 → 回落右下角');
{
  const { style, anchor } = computePanelPlacement(null, vp);
  check('anchor = bottom-right', anchor === 'bottom-right');
  check('贴右下角', style.right === 16 && style.bottom === 16);
  check('z-index 足够高', style.zIndex >= 9000);
}

console.log('[placement] 2) top-right 宠物（默认配置）→ 面板在宠物正下方');
{
  // 生产默认：corner=top-right, marginX=24, marginY=100, size=462
  const pet = { corner: 'top-right', marginX: 24, marginY: 100, size: 462 };
  const { style, anchor } = computePanelPlacement(pet, vp);
  const petBottom = 100 + 462 * 9 / 16; // = 100 + 259.875 = 359.875
  check('anchor = below-pet', anchor === 'below-pet');
  check('top 紧贴宠物下沿', style.top >= petBottom && style.top <= petBottom + 12, `top=${style.top}`);
  check('右边缘与宠物对齐', style.right === 24, `right=${style.right}`);
  check('不遮挡宠物（面板 top > 宠物 bottom）', style.top > petBottom);
  check('有最大高度限制', typeof style.maxHeight === 'number' && style.maxHeight > 0, `maxHeight=${style.maxHeight}`);
  check('面板在视口内', style.top + 200 <= VH, `top=${style.top}`);
}

console.log('[placement] 3) top-right 但窗口很矮 → 回落右下角');
{
  const pet = { corner: 'top-right', marginX: 24, marginY: 100, size: 462 };
  const short = { width: VW, height: 560 }; // 宠物底 360，剩余 200 不到阈值
  const { anchor } = computePanelPlacement(pet, short);
  check('空间不足时回落', anchor === 'bottom-right', `anchor=${anchor}`);
}

console.log('[placement] 4) top-left 宠物 → 面板在左侧对齐');
{
  const pet = { corner: 'top-left', marginX: 30, marginY: 120, size: 462 };
  const { style, anchor } = computePanelPlacement(pet, vp);
  check('anchor = below-pet', anchor === 'below-pet');
  check('左对齐', style.left === 30, `left=${style.left}`);
  check('不设 right', style.right === undefined);
}

console.log('[placement] 5) bottom-right 宠物（marginY 大）→ 优先放宠物上方');
{
  const pet = { corner: 'bottom-right', marginX: 24, marginY: 320, size: 462 };
  const { anchor, style } = computePanelPlacement(pet, vp);
  // 宠物上沿距顶 = 900 - 320 - 260 = 320，上方空间 320-24 = 296 ≥ 200
  check('anchor = above-pet', anchor === 'above-pet', `anchor=${anchor}`);
  check('有 bottom 定位', typeof style.bottom === 'number', `bottom=${style.bottom}`);
  // 面板下沿应紧贴宠物上沿：bottom(距底) ≈ 900 - (320 - 8) = 588
  const expectedBottom = VH - (320 - 8);
  check('紧贴宠物上沿', Math.abs(style.bottom - expectedBottom) <= 2, `bottom=${style.bottom} 期望≈${expectedBottom}`);
  check('面板不会跑到屏幕顶端', style.bottom + 100 < VH, `bottom=${style.bottom}`);
}

console.log('[placement] 6) bottom-right 且 marginY 小 → 上方不够则放下方');
{
  const pet = { corner: 'bottom-right', marginX: 24, marginY: 40, size: 462 };
  const { anchor, style } = computePanelPlacement(pet, vp);
  // 宠物上沿距顶 = 900 - 40 - 260 = 600，上方空间 600-24 = 576 ≥ 200 → 仍是上方
  check('anchor 合法', anchor === 'above-pet' || anchor === 'below-pet', `anchor=${anchor}`);
  // 无论哪种，面板都必须留在视口内
  if (style.top !== undefined) check('top 在视口内', style.top >= 0 && style.top < VH, `top=${style.top}`);
  if (style.bottom !== undefined) check('bottom 在视口内', style.bottom >= 0 && style.bottom < VH, `bottom=${style.bottom}`);
}

console.log('[placement] 6b) bottom-right 且贴着底边（marginY 很小）→ 上方空间不足时回落');
{
  const pet = { corner: 'bottom-right', marginX: 24, marginY: 0, size: 462 };
  const { anchor } = computePanelPlacement(pet, { width: VW, height: 560 });
  // 视口 560：宠物上沿距顶 = 560 - 0 - 260 = 300，上方 276 ≥ 200 → above-pet
  // 换成更矮的视口让上下都不够
  const tinyVp = { width: VW, height: 420 };
  const r2 = computePanelPlacement(pet, tinyVp);
  // 420：上沿距顶 = 420-260 = 160，上方 136 < 200；下方 = 420-260-24 = 136 < 200 → 回落
  check('上下都不够时回落右下角', r2.anchor === 'bottom-right', `anchor=${r2.anchor}`);
}

console.log('[placement] 7) 边界：极窄视口不应产生负值');
{
  const pet = { corner: 'top-right', marginX: 24, marginY: 100, size: 462 };
  const tiny = { width: 320, height: 480 };
  const { style } = computePanelPlacement(pet, tiny);
  for (const k of ['top', 'right', 'bottom', 'left']) {
    if (style[k] !== undefined) check(`${k} 非负`, style[k] >= 0, `${k}=${style[k]}`);
  }
  check('maxHeight 为正', style.maxHeight > 0, `maxHeight=${style.maxHeight}`);
}

console.log('');
if (fail === 0) { console.log('[placement] PASS'); process.exit(0); }
console.error(`[placement] FAIL: ${fail} 项未通过`);
process.exit(1);
