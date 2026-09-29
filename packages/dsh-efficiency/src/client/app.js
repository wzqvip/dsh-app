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
  displayHint: 'web=只在网页；desktop=只在桌面小窗；both=两者都显示。',
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
  displayHint: 'web = browser only; desktop = floating window; both = both.',
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
    const { jsx: h } = require('react/jsx-runtime');

    // 单例桥：answerer 与面板通过它交换提问/答案
    const bridge = createAnswerBridge();
    const QuestionPanel = makeQuestionPanel({ h, useState, useEffect, useCallback, useRef });
    const SettingsSection = makeSettingsSection({ h, useState, useEffect, useCallback });

    const name = 'efficiency';
    // remote 提供 Remote 层（$on / userQuestions.attachWait）—— answerer 必需
    const inject = ['slots', 'locale', 'remote'];

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
