/**
 * 宠物感知定位：算出「待答面板」应该放在哪。
 *
 * 为什么需要它：
 *   dsh-pet 在等待确认时只播动画 + 一句通用气泡（"需要你确认一下呢"），
 *   **不含问题内容、不含选项、不能作答**。要"从宠物直接回答"，
 *   就得让回答 UI 出现在宠物旁边，而不是让人回浏览器里找那段对话。
 *
 * 定位算法（来自 dsh-pet 的 src/client/pet.ts，已核对）：
 *   .dsh-pet-root  position:fixed; z-index:40
 *   [data-corner=top-right]  right: marginX; top: marginY
 *   .dsh-pet-stage           宽 = size；高 = size * 9/16
 *   → 宠物占用矩形（视口坐标）：
 *       top    = marginY
 *       bottom = marginY + size * 9/16
 *       right 边缘距视口右侧 marginX
 *
 * 面板放在宠物**正下方**、右边缘对齐。若下方空间不足（小窗口），
 * 改为贴右下角 —— 宁可离宠物远一点，也要保证能被看到和点击。
 *
 * 注意：position 是宠物配置里的【初始值】；拖拽后宠物会移动，本模块不追踪
 * 拖拽（那需要读 dsh-pet 的内部状态，属于跨插件耦合）。因此定位是"就近"而非"跟随"。
 */

const DEFAULT_SIZE = 462;
const ASPECT = 9 / 16;

/** 读 dsh-pet 的成品配置；失败返回 null（不抛错、不影响主流程） */
export async function fetchPetLayout() {
  try {
    const res = await fetch('/dsh-pet-7340/config', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    const main = data?.main;
    if (!main) return null;
    const pets = Array.isArray(main.pets) ? main.pets : [];
    // 取第一个在网页上显示的宠物
    const pet = pets.find((p) => p.display === 'web' || p.display === 'both') ?? pets[0];
    if (!pet) return null;
    const pos = pet.position ?? {};
    return {
      corner: pos.corner ?? 'top-right',
      marginX: typeof pos.marginX === 'number' ? pos.marginX : 24,
      marginY: typeof pos.marginY === 'number' ? pos.marginY : 100,
      size: typeof pet.size === 'number' ? pet.size : DEFAULT_SIZE,
      id: pet.id,
      name: pet.name,
    };
  } catch {
    return null;
  }
}

/**
 * 依据宠物布局算出面板样式。
 * @param {object|null} petLayout - fetchPetLayout() 的返回值
 * @param {{width?:number, height?:number}} viewport - 当前视口尺寸
 * @returns {{style: object, anchor: 'below-pet'|'bottom-right'}}
 */
export function computePanelPlacement(petLayout, viewport) {
  const vw = viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const vh = viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 800);

  const panelMaxW = 380;
  const panelMaxH = Math.min(520, Math.max(240, vh - 160)); // 留出上下余量

  const fallback = {
    style: {
      position: 'fixed',
      right: 16,
      bottom: 16,
      zIndex: 9000,
      maxWidth: panelMaxW,
      maxHeight: panelMaxH,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      pointerEvents: 'auto',
    },
    anchor: 'bottom-right',
  };

  if (!petLayout) return fallback;

  const { corner, marginX, marginY, size } = petLayout;
  const petH = size * ASPECT;
  const isRight = corner === 'top-right' || corner === 'bottom-right';
  const isTop = corner === 'top-right' || corner === 'top-left';
  const horizontal = isRight ? { right: Math.round(marginX) } : { left: Math.round(marginX) };

  // 统一换算成「距视口上沿/下沿的像素」，避免混用 top/bottom 两套坐标算出荒谬值。
  //   top 系宠物：上沿距顶 = marginY，下沿距顶 = marginY + petH
  //   bottom 系宠物：下沿距底 = marginY，上沿距顶 = vh - marginY - petH
  const petTopY = isTop ? marginY : vh - marginY - petH;
  const petBottomY = petTopY + petH;

  const GAP = 8;
  const MIN_PANEL = 200;

  const belowStyle = (space) => ({
    position: 'fixed',
    top: Math.round(petBottomY + GAP),
    ...horizontal,
    zIndex: 9000,
    maxWidth: panelMaxW,
    maxHeight: Math.min(panelMaxH, Math.round(space)),
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    pointerEvents: 'auto',
  });
  const aboveStyle = (space) => ({
    position: 'fixed',
    bottom: Math.round(vh - (petTopY - GAP)),
    ...horizontal,
    zIndex: 9000,
    maxWidth: panelMaxW,
    maxHeight: Math.min(panelMaxH, Math.round(space)),
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    pointerEvents: 'auto',
  });

  const spaceBelow = vh - petBottomY - GAP - 16;
  const spaceAbove = petTopY - GAP - 16;
  const canBelow = spaceBelow >= MIN_PANEL;
  const canAbove = spaceAbove >= MIN_PANEL;

  // 优先级随宠物位置选择，保证面板始终留在视口内：
  //   宠物在上方 → 优先放下方（往下读更自然）
  //   宠物在下方 → 优先放上方（否则会被推到屏幕底边）
  const preferBelow = isTop;
  if (preferBelow ? canBelow : !canAbove) {
    if (canBelow) return { style: belowStyle(spaceBelow), anchor: 'below-pet' };
  }
  if (canAbove) return { style: aboveStyle(spaceAbove), anchor: 'above-pet' };
  if (canBelow) return { style: belowStyle(spaceBelow), anchor: 'below-pet' };

  // 上下都不够 → 贴右下角，保证可用
  return fallback;
}
