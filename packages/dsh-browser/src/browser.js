/**
 * 浏览器适配器：用 `playwright-core` 的 **connectOverCDP** 连**同一个容器里**那个
 * headed Chromium（由 docker/entrypoint.sh 启动）。
 *
 * 关键取舍：
 *   1. **不下载第二个浏览器**。镜像里装的是发行版的 chromium，Playwright 只做 CDP 客户端。
 *      → 镜像小、构建快、版本与 noVNC 里人看到的那一份永远是同一个。
 *   2. **只使用 Chromium 的默认 context**。登录 cookie 在默认 profile 里；
 *      若另开 incognito context，人工登录的会话对 agent 不可见（最常见的坑）。
 *   3. **每次调用先 ensure：连不上就重连、旧 page 关了就在现有 context 里再找/新建**。
 *      容器重启、Chromium 崩溃重启、人在窗口里把标签页关掉，都会走到这条路径。
 *   4. **只在浏览器真不可用时抛 503**，其它尽力而为：`/open` 超时也返回 ok+timedOut，
 *      好让上层继续 `/snapshot` 判断到底是不是登录页。
 */

import { chromium } from 'playwright-core';

import { classifyNeedsUser } from './classify.js';

const OBSERVE_SCRIPT = () => {
  const body = document.body;
  const text = body ? body.innerText || '' : '';
  const count = (selector) => document.querySelectorAll(selector).length;
  const iframeUrls = [];
  for (const frame of document.querySelectorAll('iframe')) {
    if (frame.src) iframeUrls.push(frame.src);
    if (iframeUrls.length >= 40) break;
  }
  return {
    url: location.href,
    title: document.title,
    // 1 MB 上限：正常页面远小于此，异常页面（超长邮件/日志）不至于把 CDP 撑爆
    text: text.slice(0, 1_000_000),
    readyState: document.readyState,
    passwordFieldCount: count('input[type="password"]'),
    interactiveCount: Math.min(
      count('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"]'),
      5_000,
    ),
    captchaDom: count(
      [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="turnstile"]',
        'iframe[src*="captcha"]',
        '[data-sitekey]',
        'img[src*="captcha" i]',
        '[class*="captcha" i]',
        '[id*="captcha" i]',
      ].join(','),
    ) > 0,
    iframeUrls,
  };
};

export class BrowserUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BrowserUnavailableError';
    this.code = 'browser_unavailable';
    this.status = 503;
  }
}

export class BrowserActionError extends Error {
  constructor(message, { cause, status = 500 } = {}) {
    super(message, { cause });
    this.name = 'BrowserActionError';
    this.code = 'action_failed';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function messageOf(error) {
  return String(error?.message ?? error);
}

function isTimeoutError(error) {
  return /Timeout|timed out/i.test(messageOf(error));
}

function isAbortError(error) {
  return /net::ERR_ABORTED/i.test(messageOf(error));
}

/**
 * @param {object} options
 * @param {string} options.cdpUrl                 如 http://127.0.0.1:9222
 * @param {number} [options.actionTimeoutMs]      默认动作/导航超时
 * @param {number} [options.maxActionTimeoutMs]   调用方传入 timeoutMs 的上限
 * @param {number} [options.connectTimeoutMs]     connectOverCDP 握手超时
 * @param {number} [options.settleMs]             导航后等待正文出现的宽限
 * @param {Function} [options.logger]
 * @param {object} [options.playwright]           (测试/替换用)，默认 playwright-core 的 chromium
 */
export function createBrowserController({
  cdpUrl,
  actionTimeoutMs = 20_000,
  maxActionTimeoutMs = 60_000,
  connectTimeoutMs = 5_000,
  settleMs = 1_500,
  logger = () => {},
  playwright = chromium,
} = {}) {
  if (!cdpUrl) throw new Error('createBrowserController 需要 cdpUrl');

  /** @type {import('playwright-core').Browser|null} */
  let browser = null;
  /** @type {import('playwright-core').BrowserContext|null} */
  let context = null;
  /** @type {import('playwright-core').Page|null} */
  let page = null;
  /** 最近一次导航的 HTTP 状态（重定向后的最终响应），/snapshot 用来判 403/429 */
  let lastHttpStatus = null;

  function reset() {
    browser = null;
    context = null;
    page = null;
  }

  function clampTimeout(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return actionTimeoutMs;
    return Math.min(Math.max(n, 100), maxActionTimeoutMs);
  }

  async function pickPage() {
    if (!context) return null;
    const pages = context.pages().filter((p) => !p.isClosed());
    if (pages.length > 0) {
      // 人在 noVNC 里通常会新开/切到自己需要的标签页：用最后一个可见标签
      return pages[pages.length - 1];
    }
    return context.newPage();
  }

  /** 连上 Chromium，并拿到一个可用的 page。 */
  async function ensurePage() {
    if (browser && browser.isConnected() && page && !page.isClosed()) return page;

    if (browser && browser.isConnected()) {
      // 浏览器还在，只是 page 被关了 / 换了：在现有 context 里再找一个
      context = browser.contexts()[0] ?? null;
      if (context) {
        page = await pickPage();
        if (page) {
          page.setDefaultTimeout(actionTimeoutMs);
          return page;
        }
      }
    }

    reset();
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        browser = await playwright.connectOverCDP(cdpUrl, { timeout: connectTimeoutMs });
        break;
      } catch (error) {
        lastError = error;
        await sleep(500 * (attempt + 1));
      }
    }
    if (!browser) {
      throw new BrowserUnavailableError(
        `连不上 Chromium 的 CDP（${cdpUrl}）：${messageOf(lastError)}（容器里 Chromium 可能还没起来）`,
        { cause: lastError },
      );
    }

    context = browser.contexts()[0] ?? null;
    if (!context) {
      // 极罕见：CDP 连上了但没有默认 context。退回新建（注意：新 context 不共享登录 cookie）
      logger('warn', 'no_default_context');
      try {
        context = await browser.newContext();
      } catch (error) {
        throw new BrowserUnavailableError(`Chromium 没有可用的 browser context：${messageOf(error)}`);
      }
    }

    page = await pickPage();
    if (!page) throw new BrowserUnavailableError('Chromium 没有可用的页面（tab）');
    page.setDefaultTimeout(actionTimeoutMs);
    logger('info', 'cdp_connected', { cdpUrl, pages: context.pages().length });
    return page;
  }

  async function safeTitle(target) {
    try {
      return await target.title();
    } catch {
      return '';
    }
  }

  /**
   * 导航后别急着取正文：SPA 在 domcontentloaded 之后才渲染。
   * 最多等 settleMs，正文一出现就走。
   */
  async function settle(target) {
    const deadline = Date.now() + Math.max(0, settleMs);
    while (Date.now() < deadline) {
      try {
        const ready = await target.evaluate(
          () => document.readyState === 'complete' && (document.body?.innerText ?? '').trim().length > 0,
        );
        if (ready) return;
      } catch {
        // 页面正在跳转时 evaluate 会失败，继续等
      }
      await sleep(150);
    }
  }

  async function health() {
    try {
      const target = await ensurePage();
      return {
        browserUp: true,
        page: {
          url: target.url(),
          title: await safeTitle(target),
          pageCount: context ? context.pages().length : 1,
        },
      };
    } catch (error) {
      return { browserUp: false, error: messageOf(error) };
    }
  }

  async function open(url, { timeoutMs } = {}) {
    const target = await ensurePage();
    const timeout = clampTimeout(timeoutMs);
    lastHttpStatus = null;
    let timedOut = false;

    try {
      const response = await target.goto(url, { waitUntil: 'domcontentloaded', timeout });
      lastHttpStatus = response ? response.status() : null;
    } catch (error) {
      if (isTimeoutError(error)) {
        timedOut = true;
        logger('warn', 'open_timeout', { url, timeout });
      } else if (isAbortError(error)) {
        // 页面自己在跳（常见于 SSO 中转）：不当失败
        logger('info', 'open_aborted', { url });
      } else {
        throw new BrowserActionError(`打开 ${url} 失败：${messageOf(error)}`, { cause: error, status: 502 });
      }
    }

    await settle(target);
    return {
      ok: true,
      title: await safeTitle(target),
      finalUrl: target.url(),
      timedOut,
      httpStatus: lastHttpStatus,
    };
  }

  async function snapshot() {
    const target = await ensurePage();
    // 点击/跳转之后页面可能还在加载：此时 innerText 是空的，
    // 上层会误以为"没内容"。先给它 settleMs 让正文出现（一旦出现立刻返回）。
    await settle(target);
    let raw;
    try {
      raw = await target.evaluate(OBSERVE_SCRIPT);
    } catch (error) {
      throw new BrowserActionError(`读取页面失败：${messageOf(error)}`, { cause: error, status: 502 });
    }
    const observation = {
      ...raw,
      httpStatus: lastHttpStatus,
      loadError: '',
    };
    return observation;
  }

  async function act({ action, selector, text, timeoutMs } = {}) {
    const target = await ensurePage();
    const timeout = clampTimeout(timeoutMs);
    const locator = target.locator(selector).first();
    // 点击可能触发跳转，之后 lastHttpStatus 就属于"上一页"了 —— 清掉，
    // 别让旧的 200 掩盖新页面的 403。
    lastHttpStatus = null;

    try {
      if (action === 'click') {
        await locator.click({ timeout });
      } else if (action === 'waitFor') {
        await locator.waitFor({ state: 'visible', timeout });
      } else if (action === 'type') {
        await locator.click({ timeout });
        try {
          await locator.fill(text ?? '', { timeout });
        } catch (error) {
          // contenteditable / 自定义控件不支持 fill → 逐字符敲
          logger('info', 'type_fallback_press', { selector, error: messageOf(error) });
          await locator.pressSequentially(text ?? '', { timeout });
        }
      } else {
        throw new BrowserActionError(`不支持的动作：${action}`, { status: 400 });
      }
    } catch (error) {
      if (error instanceof BrowserActionError) throw error;
      throw new BrowserActionError(`动作 ${action} 失败：${messageOf(error)}`, {
        cause: error,
        status: isTimeoutError(error) ? 408 : 500,
      });
    }

    return { ok: true };
  }

  return {
    health,
    open,
    snapshot,
    act,
    /** 只断开 CDP 连接，**不关**那个人正在用的浏览器。 */
    disconnect() {
      try {
        browser?.close();
      } catch {
        // 忽略：退出路径上不值得再报错
      }
      reset();
    },
    /** 供排错用：当前 URL（连不上就 null）。单测之外别依赖它。 */
    currentUrl() {
      return page && !page.isClosed() ? page.url() : null;
    },
    classify: classifyNeedsUser,
  };
}
