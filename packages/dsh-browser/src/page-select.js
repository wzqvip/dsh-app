/**
 * 受管页面（single managed page）的选择逻辑 —— `/open` `/snapshot` `/act` `/eval`
 * **必须永远作用在同一个标签**上。
 *
 * 为什么单独成模块：
 *   2026-11-04 的 bug 就出在"怎么选页"上：旧实现是 `context.pages()` 里取**最后一个**，
 *   于是页面被关掉 / 服务重连时，会静默切到另一个标签（比如维护者的 Outlook），
 *   结果 `/open` 打开 Canvas、`/snapshot` 却读 Outlook，登录脚本误判"已登录"。
 *   选页逻辑现在没有 IO 依赖（只吃 context/page 的鸭子类型接口），可以单测钉死。
 *
 * 策略（按优先级）：
 *   1. **带标记的页**（`window.name === 'dsh-browser-managed'`）—— 重连、容器重启后
 *      仍能认出同一个标签，不靠"第几个"
 *   2. 只有**一个**标签 → 就它（维护者登录用的也是这一页，不必多开一个）
 *   3. 多个标签且没有标记 → **新建**一个受管页，**绝不**劫持别人的标签
 *      （维护者的 Outlook 标签不该被 agent 拿去导航）
 *
 * ⚠️ 为什么用 `window.name` 当标记：它是浏览上下文自己的属性，**跨导航存活**
 *    （包括跨域导航），而 Playwright 没暴露 targetId 给上层；写一个自定义值
 *    不会和其它站点冲突（普通站点不会用这个字符串）。
 */

export const MANAGED_WINDOW_NAME = 'dsh-browser-managed';

function safeUrl(page) {
  try {
    return typeof page?.url === 'function' ? page.url() : '';
  } catch {
    return '';
  }
}

/**
 * 读一个页面的标记。页面正在跳转 / 是错误页时 evaluate 会抛，一律当"没有标记"。
 * @param {object} page 鸭子类型：需要有 evaluate(fn, arg)
 * @returns {Promise<string>}
 */
export async function readPageMarker(page, marker = MANAGED_WINDOW_NAME) {
  try {
    const value = await page.evaluate(() => window.name);
    return typeof value === 'string' && value === marker ? value : '';
  } catch {
    return '';
  }
}

/**
 * 给页面打上标记（导航后站点可能改写过 window.name，所以每次 /open 之后要补一次）。
 * @returns {Promise<boolean>} 是否写成功
 */
export async function markManagedPage(page, marker = MANAGED_WINDOW_NAME) {
  try {
    await page.evaluate((name) => {
      window.name = name;
    }, marker);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取得受管页面：优先已标记的，其次"唯一标签"（仅限刚连上时），否则新建。
 *
 * @param {object} context 鸭子类型：需要 pages() 与 newPage()
 * @param {{marker?:string, logger?:Function, allowAdoptSingleTab?:boolean}} [options]
 *   allowAdoptSingleTab：只有**刚建立 CDP 连接**时允许"独生子标签就是受管页"。
 *   受管页被关掉后再取页必须传 false —— 否则会顺手接管人仅剩的那个标签
 *   （实测：关掉受管页后 /snapshot 读到了维护者的标签，这正是不该发生的）。
 */
export async function acquireManagedPage(
  context,
  { marker = MANAGED_WINDOW_NAME, logger = () => {}, allowAdoptSingleTab = true } = {},
) {
  if (!context || typeof context.pages !== 'function') {
    throw new Error('acquireManagedPage 需要 browser context');
  }
  const pages = context.pages().filter((page) => !page.isClosed?.());

  // 1) 已标记的受管页
  for (const page of pages) {
    if ((await readPageMarker(page, marker)) === marker) {
      logger('debug', 'managed_page_found', { url: safeUrl(page) });
      return page;
    }
  }

  // 2) 只有一个标签、且允许采用（只发生在刚连上时）→ 就它
  if (allowAdoptSingleTab && pages.length === 1) {
    await markManagedPage(pages[0], marker);
    logger('info', 'managed_page_adopted', { url: safeUrl(pages[0]) });
    return pages[0];
  }

  // 3) 其它情况一律**新建**，别动别人的标签
  const created = await context.newPage();
  await markManagedPage(created, marker);
  logger('info', 'managed_page_created', { existing: pages.length, adopted: false });
  return created;
}
