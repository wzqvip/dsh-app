/**
 * 客户端「装配层」：注入 react，组装组件并注册进 DSH 插槽。
 *
 * 注册点：
 *   - `shell.overlay`     → 待答问题面板（核心 UI）
 *   - `settings.section`  → 设置页：宠物相关开关（复用 dsh-pet 的配置接口）
 *
 * 核心链路（见 research/11、12、13）：
 *   answerer 在【客户端】。官方答案卡实测不渲染，所以本插件自己当 answerer：
 *   ctx.remote.$on('user-questions/request', …) 拿到提问 → 交给面板 → 用户点选
 *   → 把答案 return 回 waterfall。
 */

import { makeQuestionPanel } from './panel.js';
import { makeSettingsSection } from './settings.js';
import { createAnswerBridge, installAnswerer } from './answerer.js';
import { clog, installClientLogging, flush } from './logger.js';
// vendor 的桌宠客户端（由 build.mjs 从虚拟模块 '@dsh-app/pet' 注入）。
// ⚠️ 它是【库】而不是独立插件 —— 见下方 inject 处的取证说明：
//    一个客户端模块只能出一个 cordis 插件，所以宠物不能再单独 load 一个 id。
import { __petFactory } from '@dsh-app/pet';

const NS = 'dsh-efficiency';

const zh = {
  nav: '效率助手',
  title: '待回答的问题',
  liveTag: '实时',
  empty: '暂无待答问题',
  submit: '提交',
  decline: '跳过（交给官方）',
  declineHint: '不用我的面板作答，把这次提问交回官方链路',
  customPlaceholder: '或直接输入你的回答',
  answered: '已提交，agent 会收到',
  failed: '提交失败',
  timedHint: '限时提问',
  pollHint: '零额外 token',
  // 设置页
  petSection: '桌宠（dsh-pet）',
  petMissing: '未检测到 dsh-pet。装上它才能用下面的开关。',
  statusEnabled: '工作状态联动',
  statusEnabledHint: '宠物跟着会话状态切换动画与气泡（仅监听，不调用模型）。',
  notifyEnabled: '系统通知',
  notifyEnabledHint: '窗口失焦时，对话完成／需要你确认／出错会弹系统通知。',
  displayMode: '显示位置',
  displayHint: 'desktop=只在桌面小窗（默认）；web=只在网页；both=两者都显示；none=都不显示。',
  openSettingsWhere: '完整设置窗口',
  openSettingsWhereHint:
    '在【桌面小窗】的宠物上点右键 →「设置…」打开（含物理、动画池、表情包池等全部项）。' +
    '网页浮层的右键菜单里没有这一项：它要经 IPC 通知 Electron 主进程，网页端没有这条通道。',
  size: '尺寸',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  saveFailed: '保存失败',
  reload: '重新读取',
  pickerNone: '（未读取）',
};

const en = {
  nav: 'Efficiency',
  title: 'Pending questions',
  liveTag: 'live',
  empty: 'No pending questions',
  submit: 'Submit',
  decline: 'Skip (use official)',
  declineHint: 'Do not answer with this panel; hand the question back to the official chain',
  customPlaceholder: 'Or type your answer',
  answered: 'Submitted; the agent will receive it',
  failed: 'Failed',
  timedHint: 'Timed question',
  pollHint: 'No extra tokens',
  petSection: 'Desktop pet (dsh-pet)',
  petMissing: 'dsh-pet not detected. Install it to use these switches.',
  statusEnabled: 'Work-status sync',
  statusEnabledHint: 'The pet animates and speaks to the session state (listens only, no model calls).',
  notifyEnabled: 'System notifications',
  notifyEnabledHint: 'Toast on completion / question / error while the window is unfocused.',
  displayMode: 'Where to show',
  displayHint: 'desktop = floating window (default); web = browser only; both = both; none = neither.',
  openSettingsWhere: 'Full settings window',
  openSettingsWhereHint:
    'Right-click the pet in the DESKTOP window → "Settings…" (physics, animation pools, meme pool, etc.). ' +
    'The browser overlay menu does not have that item: it must reach the Electron main process over IPC.',
  size: 'Size',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Save failed',
  reload: 'Reload',
  pickerNone: '(not loaded)',
};

export function makeFactory() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (require) => {
    const module = { exports: {} };

    const react = require('react');
    const { useEffect, useState, useCallback, useRef } = react;
    // ⚠️ 必须用 createElement，**不能**用 react/jsx-runtime 的 jsx。
    //
    // 曾经写成 `const { jsx: h } = require('react/jsx-runtime')`，结果是
    // 提问面板"容器渲染了但子元素全空"（实测 childNodes: 0、innerHTML 为空、
    // 客户端日志却明确写着"面板开始渲染 1 条"）。
    // 根因：jsx 的签名是 `jsx(type, config, key)` —— **第三个参数是 key，不是 children**，
    // children 必须放在 config.children 里。而我们所有组件都按 createElement 的语义写
    // （children 作为第 3、4、5… 个参数展开传），于是 children 被**静默丢弃**。
    // 设置页看起来正常只是因为它的表单行每个元素只传一个 children，恰好落在
    // jsx 能容忍的范围内。
    //
    // 教训：`h` 这个名字掩盖了两套不同的调用约定；发现"元素在、内容空"时，
    // 先怀疑 children 传递方式，而不是怀疑数据。
    const h = react.createElement;

    // 单例桥：answerer 与面板通过它交换提问/答案
    const bridge = createAnswerBridge();
    const QuestionPanel = makeQuestionPanel({ h, useState, useEffect, useCallback, useRef });
    const SettingsSection = makeSettingsSection({ h, useState, useEffect, useCallback });

    // ---- 桌宠插件：当作【库】而不是独立插件（见下方 inject 说明）----
    // 由 build.mjs 从虚拟模块注入（vendor 的客户端产物，导出 __petFactory(require)）。
    let petPlugin = null;
    try {
      petPlugin = __petFactory(require);
      clog('info', `桌宠插件已实例化: name=${petPlugin?.name}`);
    } catch (err) {
      clog('error', `桌宠插件实例化失败: ${String(err)}`, { stack: err?.stack });
    }

    const name = 'efficiency';
    // remote 提供 Remote 层（$on / userQuestions.attachWait）—— answerer 必需。
    //
    // ⚠️ 为什么把宠物要求的服务也并进来（而不是让宠物自己作为一个 entry）：
    //    取证结论（读 @deepseek-ai/dsh-client-modules 与 cordis-plugin-loader）：
    //    客户端 boot 清单里【每个包只对应一个客户端模块 id】，
    //    loader.create({name}) 会为该模块建【一个】cordis entry，并取它的导出
    //    当作【一个】插件（unwrapExports 只接受单对象/函数，没有数组或多插件字段）。
    //    所以"同一份 client.js 里 load 两个 id"是行不通的 —— 第二个 id 没有清单条目
    //    引用，永远不会被物化（实测：它的 factory 一次都没被调用，且不报错）。
    //    因此改为：宠物作为库，由我们这一条 entry 一并 apply。
    const ownInject = ['slots', 'locale', 'remote'];
    const petInject = Array.isArray(petPlugin?.inject) ? petPlugin.inject : [];
    const inject = [...new Set([...ownInject, ...petInject])];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function apply(ctx) {
      // 先把排障通道装上：后面的一切都会回流到宿主日志（AI 读得到）
      installClientLogging();
      clog('info', 'apply() 开始');
      const safe = (fn) => { try { return fn(); } catch { return false; } };
      clog('info', '注入面检查', {
        slots: safe(() => !!ctx?.slots),
        locale: safe(() => !!ctx?.locale),
        remote: safe(() => !!ctx?.remote),
        remoteOn: safe(() => typeof ctx?.remote?.$on === 'function'),
        effect: safe(() => typeof ctx?.effect === 'function'),
      });

      // 整体 try/catch：插件 apply 抛错时，框架多半用【自己的 logger】记录，
      // 浏览器全局 onerror 未必收到 —— 实测就丢过一次关键堆栈。
      // 所以这里自己兜一层并回流，保证异常一定可见。
      // （这个兜底立刻抓到过一个真实 ReferenceError，见提交说明。）
      try {
        // 桌宠先 apply：它注册 shell.overlay 的宠物浮层、系统通知轮询、
        // 状态联动等。放在前面是为了让宠物的插槽注册先落地（overlay 里
        // 宠物与我们的提问面板是并列的两个注册项，互不依赖）。
        // 失败不阻断我们的功能：桌宠是载体，核心（提问触达）必须仍可用
        // —— 这条与 AGENTS.md「核心层不得依赖承载层」一致。
        if (petPlugin && typeof petPlugin.apply === 'function') {
          try {
            petPlugin.apply(ctx);
            clog('info', '桌宠插件 apply 完成');
          } catch (err) {
            clog('error', `桌宠插件 apply 抛错（不影响本插件功能）: ${String(err)}`, {
              stack: err?.stack ? String(err.stack).slice(0, 1200) : undefined,
            });
          }
        } else {
          clog('warn', '桌宠插件不可用，跳过（本插件功能不受影响）');
        }

        applyBody(ctx, { clog, bridge, QuestionPanel, SettingsSection });
      } catch (err) {
        clog('error', `apply 主体抛出: ${String(err)}`, {
          stack: err?.stack ? String(err.stack).slice(0, 1500) : undefined,
        });
        void flush();
        throw err;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function applyBody(ctx, { clog: clogFn, bridge: b, QuestionPanel: Panel, SettingsSection: Settings }) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-efficiency: dictionaries');
      clogFn('info', 'locale 注册完成');

      const tBound = ctx.locale.bind(NS);

      // 核心：注册 answerer。任何不确定的情况都会让位给官方链路。
      try {
        installAnswerer(ctx, b, (m) => clogFn('info', `answerer: ${m}`));
        clogFn('info', 'answerer 注册流程返回');
      } catch (err) {
        clogFn('error', `answerer 装配异常: ${String(err)}`, { stack: err?.stack });
      }

      // overlay：待答面板
      // ⚠️ 必须用 generator（yield 注册结果），照抄已验证可用的第三方插件。
      try {
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register(
            { name: 'shell.overlay', id: 'efficiency-questions', order: 900 },
            () => h(Panel, { t: tBound, bridge: b }),
          );
        });
        clogFn('info', '已注册 shell.overlay: efficiency-questions');
      } catch (err) {
        clogFn('error', `注册 shell.overlay 失败: ${String(err)}`, { stack: err?.stack });
      }

      try {
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'efficiency-config', order: 40, label: () => tBound('nav'), inject: () => ({ t: tBound }) },
            () => h(Settings, { t: tBound }),
          );
        });
        clogFn('info', '已注册 settings.section: efficiency-config');
      } catch (err) {
        clogFn('error', `注册 settings.section 失败: ${String(err)}`, { stack: err?.stack });
      }

      clogFn('info', '装配完成');
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
