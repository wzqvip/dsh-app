/**
 * 客户端「装配层」：注入 react，组装两个组件并注册进 DSH 插槽。
 *
 * 注册点（均来自已验证的槽位契约）：
 *   - `shell.overlay`   → 全应用浮层：待答问题卡片（核心 UI）
 *   - `settings.section` → 设置页一栏：开关与说明
 *
 * 数据：HTTP 轮询宿主侧的 /dsh-efficiency/api/*（不依赖连接服务事件流）。
 */

import { makeQuestionPanel } from './panel.js';
import { makeSettingsSection } from './settings.js';

const NS = 'dsh-efficiency';

const zh = {
  nav: '效率助手',
  title: '待回答的问题',
  empty: '暂无待答问题',
  answer: '回答',
  submit: '提交',
  cancel: '取消',
  other: '其他…',
  customPlaceholder: '输入你的回答',
  answered: '已提交',
  failed: '提交失败',
  multiHint: '可多选',
  enabled: '启用提问提醒',
  enabledHint: '在浮层显示 agent 的待答问题，点选即可回答（不需要打开网页会话）。',
  pollHint: '数据来自宿主侧轮询，不额外消耗模型 token。',
};

const en = {
  nav: 'Efficiency',
  title: 'Pending questions',
  empty: 'No pending questions',
  answer: 'Answer',
  submit: 'Submit',
  cancel: 'Cancel',
  other: 'Other…',
  customPlaceholder: 'Type your answer',
  answered: 'Submitted',
  failed: 'Failed',
  multiHint: 'Multiple choice',
  enabled: 'Enable question alerts',
  enabledHint: 'Show the agent\u2019s pending questions in an overlay; answer with one click without opening the session.',
  pollHint: 'Polled from the host; costs no extra model tokens.',
};

export function makeFactory() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (require) => {
    const module = { exports: {} };

    const react = require('react');
    const { useEffect, useState, useCallback, useRef } = react;
    const { jsx: h } = require('react/jsx-runtime');

    const QuestionPanel = makeQuestionPanel({ h, useState, useEffect, useCallback, useRef });
    const SettingsSection = makeSettingsSection({ h, useState, useEffect });

    const name = 'efficiency';
    const inject = ['slots', 'locale'];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-efficiency: dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register(
          { name: 'shell.overlay', id: 'efficiency-questions', order: 900 },
          () => h(QuestionPanel, { t }),
        );
      });

      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'efficiency-config', order: 40, label: () => t('nav') },
          () => h(SettingsSection, { t }),
        );
      });
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
