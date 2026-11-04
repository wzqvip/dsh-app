/**
 * 受管页面选择逻辑的测试 —— 对应 task-4 的 bug：
 * 旧实现取 `context.pages()` 的**最后一个**，导致 `/open` 与 `/snapshot`
 * 在页面被关/重连时静默落到不同标签（Canvas 登录被误判成 Outlook 已登录）。
 *
 * 这里用鸭子类型的假 context / page 把"选哪一页"钉死：
 *   - 有标记就认标记（重连后仍找得到同一页）
 *   - 只有一个标签才采用它（不多开、不劫持）
 *   - 多标签且无标记 → **新建**，绝不拿别人的标签去导航
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGED_WINDOW_NAME,
  acquireManagedPage,
  markManagedPage,
  readPageMarker,
} from '../src/page-select.js';

/**
 * 假页面。区分两种 evaluate 用法（靠有没有传参）：
 *   - `evaluate(fn)`        → readPageMarker，返回 window.name
 *   - `evaluate(fn, name)`  → markManagedPage，把 window.name 设成 name
 */
function fakePage({ url = 'about:blank', windowName = '', closed = false, evalThrows = false } = {}) {
  const state = { url, windowName, closed, evalThrows, markCount: 0 };
  return {
    state,
    isClosed: () => state.closed,
    url: () => state.url,
    async evaluate(_fn, arg) {
      if (state.evalThrows) throw new Error('Target closed / cannot evaluate');
      if (arg === undefined) return state.windowName;
      state.windowName = arg;
      state.markCount += 1;
      return undefined;
    },
  };
}

function fakeContext(pages = []) {
  const created = [];
  return {
    created,
    pages: () => pages,
    async newPage() {
      const page = fakePage({ url: 'about:blank' });
      pages.push(page);
      created.push(page);
      return page;
    },
  };
}

test('没有标签 → 新建一个并打上标记', async () => {
  const context = fakeContext([]);
  const logs = [];
  const page = await acquireManagedPage(context, { logger: (level, msg, extra) => logs.push({ level, msg, extra }) });

  assert.equal(context.created.length, 1);
  assert.equal(page, context.created[0]);
  assert.equal(page.state.windowName, MANAGED_WINDOW_NAME);
  assert.ok(logs.some((l) => l.msg === 'managed_page_created'));
});

test('只有一个标签 → 采用它（不多开），并补上标记', async () => {
  const only = fakePage({ url: 'https://outlook.office.com/mail/' });
  const context = fakeContext([only]);
  const page = await acquireManagedPage(context);

  assert.equal(page, only);
  assert.equal(context.created.length, 0, '不该新开标签');
  assert.equal(only.state.windowName, MANAGED_WINDOW_NAME);
  assert.equal(only.state.markCount, 1);
});

test('受管页被关掉后再取页：只剩一个别人的标签也**不采用**，必须新建', async () => {
  // 对应实测 bug：关掉受管页后 /snapshot 读到了维护者的标签
  const human = fakePage({ url: 'https://outlook.cloud.microsoft/mail/' });
  const context = fakeContext([human]);

  const page = await acquireManagedPage(context, { allowAdoptSingleTab: false });
  assert.equal(context.created.length, 1, '应该新建受管页');
  assert.equal(page, context.created[0]);
  assert.notEqual(page, human);
  assert.equal(human.state.windowName, '', '不许给别人的标签打标记');
});

test('即使只剩一个标签，带标记的那页仍然优先（重连场景）', async () => {
  const marked = fakePage({ url: 'https://managed.example/', windowName: MANAGED_WINDOW_NAME });
  const context = fakeContext([marked]);
  const page = await acquireManagedPage(context, { allowAdoptSingleTab: false });
  assert.equal(page, marked);
  assert.equal(context.created.length, 0);
});

test('三个标签，中间那个有标记 → 认标记，不认"最后一个"', async () => {
  const first = fakePage({ url: 'https://a.example/', windowName: '' });
  const marked = fakePage({ url: 'https://managed.example/', windowName: MANAGED_WINDOW_NAME });
  const last = fakePage({ url: 'https://outlook.cloud.microsoft/mail/' });
  const context = fakeContext([first, marked, last]);

  const page = await acquireManagedPage(context);
  assert.equal(page, marked, '必须返回带标记的那一页（旧实现会返回 last）');
  assert.equal(context.created.length, 0);
  assert.equal(last.state.windowName, '', '不许碰别人的标签');
});

test('多个标签且都没有标记 → 新建受管页（绝不劫持维护者的 Outlook）', async () => {
  const outlook = fakePage({ url: 'https://outlook.cloud.microsoft/mail/' });
  const canvas = fakePage({ url: 'https://osu.instructure.com/' });
  const context = fakeContext([outlook, canvas]);

  const page = await acquireManagedPage(context);
  assert.equal(context.created.length, 1, '应该新建');
  assert.equal(page, context.created[0]);
  assert.notEqual(page, outlook);
  assert.notEqual(page, canvas);
  assert.equal(page.state.windowName, MANAGED_WINDOW_NAME);
});

test('已关闭的标签不参与选择（只剩一个可用页 → 采用它）', async () => {
  const closed = fakePage({ url: 'https://a.example/', closed: true });
  const alive = fakePage({ url: 'https://b.example/' });
  const context = fakeContext([closed, alive]);

  const page = await acquireManagedPage(context);
  assert.equal(page, alive);
  assert.equal(closed.state.windowName, '', '关闭的页面不该被标记');
  assert.equal(context.created.length, 0);
});

test('evaluate 失败（错误页/正在跳转）当"没有标记"，不炸', async () => {
  const broken = fakePage({ url: 'chrome-error://chromewebdata/', evalThrows: true });
  const context = fakeContext([broken]); // 唯一标签 → 采用

  const page = await acquireManagedPage(context);
  assert.equal(page, broken);

  // 多标签 + 全都 evaluate 失败 → 新建
  const broken2 = fakePage({ evalThrows: true });
  const other = fakePage({ evalThrows: true });
  const context2 = fakeContext([broken2, other]);
  const created = await acquireManagedPage(context2);
  assert.equal(context2.created.length, 1);
  assert.equal(created, context2.created[0]);
});

test('标记失败（页面拒写）不抛错，只是返回 false', async () => {
  const page = fakePage({ evalThrows: true });
  assert.equal(await markManagedPage(page), false);
  assert.equal(await readPageMarker(page), '');
});

test('自定义 marker 也能用（便于将来多实例）', async () => {
  const page = fakePage({ windowName: 'custom-marker' });
  const context = fakeContext([fakePage(), page, fakePage()]);
  const selected = await acquireManagedPage(context, { marker: 'custom-marker' });
  assert.equal(selected, page);
});

test('context 不合法时给可读错误', async () => {
  await assert.rejects(() => acquireManagedPage(null), /需要 browser context/);
  await assert.rejects(() => acquireManagedPage({}), /需要 browser context/);
});
