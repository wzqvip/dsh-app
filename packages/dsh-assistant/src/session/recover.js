/**
 * 会话自愈尝试：当检测到"需要人"时，先用**安全动作**试着把登录态恢复回来，
 * 失败才打扰维护者。
 *
 * 维护者的诉求（"我保存密码了，你可以自己登录吗"）：
 *   Chromium profile 里已经存了密码、2FA 也勾了"保持登录"，
 *   那么重新走一遍登录页往往只需要**点几下**（选账户 → 下一步 → 保持登录），
 *   不需要人再输任何东西。
 *
 * 铁律（不可越界）：
 *   · **绝不读取/输入密码**，也**绝不输入验证码**。
 *     我们只点按钮，全靠浏览器自己的 autofill。
 *   · 只对 `login_required` / `blocked` 尝试；`mfa_required` / `captcha` 直接交给人
 *     （那两类本来就必须人来做）。
 *   · 最多 3 步；每步后重新快照判断，成功即停。
 */

/** 安全可点的候选选择器（只点"继续/下一步/是"，不碰输入框） */
export const SAFE_CLICK_SELECTORS = Object.freeze([
  // 账户选择页：已登录过的账户磁贴
  '[data-test-id="tile"]',
  '#tilesHolder div[role="button"]',
  'div[role="button"][data-test-id="tile"]',
  // "继续 / 下一步 / 登录" 按钮
  '#idSIButton9',
  'input[type="submit"][value*="Next"]',
  'input[type="submit"][value*="下一步"]',
  // "保持登录?" → 是
  '#idBtn_Back',
]);

/** 哪些 reason 值得尝试自愈（其余必须人工） */
export function shouldAttemptRecovery(reason) {
  return reason === 'login_required' || reason === 'blocked' || reason === null;
}

/**
 * 尝试自愈。纯编排：依赖注入 open/snapshot/click，便于单测。
 *
 * @param {object} options
 * @param {(url:string)=>Promise<object>} options.open
 * @param {()=>Promise<object>} options.snapshot
 * @param {(selector:string)=>Promise<object>} options.click
 * @param {string} options.url 登录入口
 * @param {number} [options.maxSteps]
 * @param {(msg:string)=>void} [options.log]
 * @returns {Promise<{recovered:boolean, attempts:object[], final:object}>}
 */
export async function attemptAutoRecover({
  open,
  snapshot,
  click,
  url,
  maxSteps = 3,
  log = () => {},
} = {}) {
  const attempts = [];

  // 先回登录入口（可能是 signout 页，直接重进 mail 更稳）
  await open(url);
  let snap = await snapshot();
  if (!snap?.needsUser) {
    log('自愈：重新打开后已恢复');
    return { recovered: true, attempts, final: snap };
  }

  if (!shouldAttemptRecovery(snap.reason)) {
    log(`自愈：reason=${snap.reason} 必须人工，跳过`);
    return { recovered: false, attempts, final: snap };
  }

  for (const selector of SAFE_CLICK_SELECTORS) {
    if (attempts.filter((a) => a.ok).length >= maxSteps) break;
    let clicked;
    try {
      clicked = await click(selector);
    } catch (error) {
      clicked = { ok: false, error: String(error?.message ?? error) };
    }
    attempts.push({ selector, ok: clicked?.ok === true, error: clicked?.error });
    if (!clicked?.ok) {
      // 记下为什么点不中：选择器不存在 / 超时 / 元素不可见，排错时全靠这行
      log(`自愈：${selector} 点不中（${clicked?.error ?? 'not found'}）`);
      continue;
    }

    log(`自愈：点了 ${selector}`);
    snap = await snapshot();
    if (!snap?.needsUser) {
      log('自愈：点击后已恢复');
      return { recovered: true, attempts, final: snap };
    }
  }

  return { recovered: false, attempts, final: snap };
}
