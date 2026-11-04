/**
 * `/act {action:'type'}` 的输入策略 —— 单独成模块是为了能单测（浏览器起不来也能测）。
 *
 * 背景（2026-11-04 实测）：Microsoft 登录页在输入框上盖了一层 `#footerLinks` 浮层，
 * `locator.click()` 会被判成 "subtree intercepts pointer events" 并等到超时；
 * 而旧实现是"先 click 再 fill"，于是**整条 type 链路失败** —— 登录脚本唯一的输入通道
 * 直接断掉。但 `fill` 本身不需要命中点（它直接设值并派发 input 事件），
 * 所以正确顺序是：**能点击就点（用于聚焦），点不动就跳过 click 直接 fill**。
 *
 * ⚠️ 两件不能做错的事：
 *   1. **不能永远跳过 click**：`contenteditable` / 富文本编辑器必须先真正聚焦，
 *      fill 不一定生效（那时才轮到逐字符输入）。
 *   2. **绝不能把 `text` 写进日志/返回**：那可能是密码。日志里只有选择器、错误和阶段。
 *
 * 返回值都是纯 JSON，便于 HTTP 层透传：
 *   { ok:true,  inputMode:'fill'|'press', degraded:boolean, reason?:'click_failed'|'fill_failed' }
 *   { ok:false, error:string, timedOut:boolean, stages:string[] }
 */

function messageOf(error) {
  return String(error?.message ?? error);
}

function isTimeoutLike(error) {
  return /timeout|timed out/i.test(messageOf(error));
}

/**
 * @param {object} args
 * @param {object} args.locator        Playwright 风格定位器（click/fill/pressSequentially）
 * @param {string} args.text           要输入的文本（'' = 清空）
 * @param {number} args.timeout        每一步的超时
 * @param {Function} [args.logger]     (level, message, extra) => void —— 不要传 text 进去
 */
export async function typeIntoLocator({ locator, text = '', timeout, logger = () => {} }) {
  const stages = [];
  /** @type {string|null} */
  let degradedReason = null;

  // ① 试着点击聚焦。失败**不**中断：很多页面只是"点不到"，不代表"填不进"
  try {
    await locator.click({ timeout });
    stages.push('click');
  } catch (error) {
    degradedReason = 'click_failed';
    stages.push('click_failed');
    logger('warn', 'type_click_failed_fallback_fill', {
      error: messageOf(error),
      // 只记错误摘要，不记 text
    });
  }

  // ② 设值（不需要命中点）
  try {
    await locator.fill(text, { timeout });
    stages.push('fill');
    return {
      ok: true,
      inputMode: 'fill',
      degraded: degradedReason !== null,
      ...(degradedReason ? { reason: degradedReason } : {}),
      stages,
    };
  } catch (fillError) {
    stages.push('fill_failed');
    logger('info', 'type_fill_failed_press', { error: messageOf(fillError) });

    // ③ 逐字符输入：给 contenteditable / 自定义控件兜底（需要聚焦，click 失败时可能也失败）
    try {
      await locator.pressSequentially(text, { timeout });
      stages.push('press');
      return {
        ok: true,
        inputMode: 'press',
        degraded: true,
        reason: degradedReason ?? 'fill_failed',
        stages,
      };
    } catch (pressError) {
      stages.push('press_failed');
      return {
        ok: false,
        error: messageOf(pressError),
        timedOut: isTimeoutLike(pressError) || isTimeoutLike(fillError),
        stages,
      };
    }
  }
}
