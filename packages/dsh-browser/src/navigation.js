/**
 * 导航的两个"说真话"工具：
 *   1. **对话框处理** —— Canvas 答题页这类页面注册了 `beforeunload`，离开时会弹确认框。
 *      Playwright 在没注册 `dialog` 监听时**自动 dismiss**，而 dismiss = "留在本页"，
 *      于是 `goto` 被取消、URL 没变 —— 但旧实现把这种情况当成功返回了
 *      （日志里只会看到一句被吞掉的 `net::ERR_ABORTED`）。
 *      现在：`beforeunload` → **accept**（允许离开）；其它类型 → dismiss（等价于 Playwright
 *      默认行为，避免"自动确认删除/提交"这类危险操作）。
 *   2. **导航是否真的发生** —— 由 `navigationApplied` 如实回答，别再让上层猜。
 *
 * 单独成模块是为了能单测：这里没有 Playwright 依赖，只吃鸭子类型的 dialog/page。
 */

function safeUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return String(raw ?? '');
  }
}

function hostOf(raw) {
  try {
    return new URL(String(raw)).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 导航到底有没有发生？
 *
 * 判据（任一成立即算"发生了"）：
 *   · 最终 URL 与导航前不同 —— 一般来说这就是导航成功了（含 SSO 跨域跳转）
 *   · 最终 URL 与请求的 URL **同 host** —— 覆盖"重新加载同一页"的情况
 *
 * 反例（task 现场）：请求 example.com，最终仍停在 Canvas 答题页且与导航前相同
 * → 没发生 → false。
 *
 * @param {{beforeUrl:string, requestedUrl:string, finalUrl:string}} input
 */
export function isNavigationApplied({ beforeUrl, requestedUrl, finalUrl } = {}) {
  const final = String(finalUrl ?? '');
  if (!final) return false;

  const before = String(beforeUrl ?? '');
  // 跨域跳转（SSO）也算导航成功：URL 变了就是走了
  if (before !== '' && final !== before) return true;

  const requestedHost = hostOf(requestedUrl);
  const finalHost = hostOf(final);
  if (!requestedHost || !finalHost) return false;
  return requestedHost === finalHost;
}

/**
 * 生成 `page.on('dialog')` 的处理函数。
 *
 * 返回值永远不抛：页面弹框期间抛错会把后续整条 CDP 调用链带崩，
 * 这里把失败降级成一条 warn 日志。
 *
 * @param {{logger?:Function}} [options]
 * @returns {(dialog:object)=>Promise<{type:string, action:'accept'|'dismiss'}>}
 */
export function createDialogHandler({ logger = () => {} } = {}) {
  return async function handleDialog(dialog) {
    let type = 'unknown';
    let message = '';
    try {
      type = String(dialog?.type?.() ?? 'unknown');
      message = String(dialog?.message?.() ?? '');
    } catch {
      // 读属性失败也不影响下面的决策：按"未知类型"处理
    }

    // 只对 beforeunload 放行；其它（alert/confirm/prompt）dismiss，
    // 与 Playwright 的默认行为一致 —— 不替使用者确认危险操作。
    const action = type === 'beforeunload' ? 'accept' : 'dismiss';
    try {
      if (action === 'accept') await dialog.accept();
      else await dialog.dismiss();
      logger('info', 'dialog_handled', {
        type,
        action,
        // 弹框文案可能含页面内容，截断后再记
        message: message.slice(0, 160),
      });
    } catch (error) {
      logger('warn', 'dialog_handle_failed', { type, action, error: String(error?.message ?? error) });
    }
    return { type, action };
  };
}

/** 日志里用：把 URL 缩成 host+path，避免把查询串（可能带 token）写进日志。 */
export const briefUrl = safeUrl;
