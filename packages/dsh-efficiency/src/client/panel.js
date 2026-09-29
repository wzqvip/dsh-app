/**
 * 待答问题面板 —— 本项目核心 UI。
 *
 * 定位：补 dsh-pet 的缺口。它在等待确认时只播动画 + 一句通用气泡
 * （"需要你确认一下呢"），**不含问题内容、不含选项、不能作答**。
 * 本面板做三件事：
 *   1. 把问题内容与选项**原样**呈现出来
 *   2. 让人**点一下就作答**，不必回浏览器里翻那段对话
 *   3. 贴在宠物旁边，视线不用来回跳
 *
 * 数据流：轮询宿主侧 /dsh-efficiency/api/pending → 提交到 /answer
 * （宿主侧用官方 ctx.userQuestions.answer 把回复 steer 回 agent）
 */

import { fetchPetLayout, computePanelPlacement } from './placement.js';

const POLL_MS = 1500;
const API = '/dsh-efficiency/api';

const S = {
  card: {
    background: 'var(--dsw-alias-bg-elevated, #1f1f22)',
    color: 'var(--dsw-alias-text-primary, #f5f5f5)',
    border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    borderRadius: 12,
    padding: '12px 14px',
    boxShadow: '0 8px 28px rgba(0,0,0,.42)',
    fontSize: 13,
    lineHeight: 1.55,
    overflowY: 'auto',
  },
  head: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontWeight: 600 },
  badge: {
    background: '#c0392b', color: '#fff', borderRadius: 9,
    padding: '0 7px', fontSize: 11, lineHeight: '18px',
  },
  close: {
    marginLeft: 'auto', cursor: 'pointer', border: 'none', background: 'transparent',
    color: 'inherit', opacity: 0.55, fontSize: 15, lineHeight: 1, padding: '0 2px', fontFamily: 'inherit',
  },
  qBlock: { marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)' },
  qBlockLast: { marginBottom: 6 },
  header: { opacity: 0.62, fontSize: 11, marginBottom: 2 },
  question: { marginBottom: 4 },
  detail: { opacity: 0.72, fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' },
  options: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  option: (active) => ({
    cursor: 'pointer',
    border: `1px solid ${active ? '#4a90d9' : 'var(--dsw-alias-border-secondary, #3a3a3f)'}`,
    background: active ? 'rgba(74,144,217,.20)' : 'transparent',
    color: 'inherit', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontFamily: 'inherit',
    textAlign: 'left',
  }),
  multi: { opacity: 0.55, fontSize: 11, marginLeft: 4 },
  input: {
    width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '6px 8px',
    borderRadius: 8, border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12,
  },
  row: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' },
  primary: {
    cursor: 'pointer', border: 'none', borderRadius: 8, background: '#4a90d9',
    color: '#fff', padding: '6px 16px', fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
  },
  primaryOff: { cursor: 'not-allowed', opacity: 0.45 },
  err: { color: '#e74c3c', fontSize: 12, marginTop: 6 },
  ok: { color: '#27ae60', fontSize: 12, marginTop: 6 },
  hint: { opacity: 0.55, fontSize: 11 },
  countdown: { opacity: 0.62, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
};

/** 限时提问的提示（宿主暂不提供精确到期时间，故只做定性提示） */
const TIMED_HINT = '限时提问';

export function makeQuestionPanel({ h, useState, useEffect, useCallback, useRef }) {
  return function QuestionPanel({ t }) {
    const [items, setItems] = useState([]);
    const [dismissed, setDismissed] = useState(() => new Set());
    // callId -> { answers: { [qid]: { selected: string[], custom: string } } }
    const [draft, setDraft] = useState({});
    const [status, setStatus] = useState({});
    const [petLayout, setPetLayout] = useState(null);
    const [viewport, setViewport] = useState({ width: 1280, height: 800 });
    const alive = useRef(true);

    const poll = useCallback(async () => {
      try {
        const res = await fetch(`${API}/pending`, { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive.current) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
      } catch {
        /* 宿主不可用时静默，不影响页面其它功能 */
      }
    }, []);

    useEffect(() => {
      alive.current = true;
      poll();
      const timer = setInterval(poll, POLL_MS);
      return () => { alive.current = false; clearInterval(timer); };
    }, [poll]);

    // 宠物布局（用于就近定位）；设置页可能改动，故定期刷新
    useEffect(() => {
      let a = true;
      const load = async () => {
        const l = await fetchPetLayout();
        if (a) setPetLayout(l);
      };
      load();
      const timer = setInterval(load, 10000);
      return () => { a = false; clearInterval(timer); };
    }, []);

    useEffect(() => {
      const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
      update();
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }, []);

    const visible = items.filter((it) => !dismissed.has(it.callId));
    if (visible.length === 0) return null;

    const placement = computePanelPlacement(petLayout, viewport);

    /** 取得（或初始化）某条提问的草稿 */
    const getDraft = (item) => {
      const d = draft[item.callId];
      if (d) return d;
      const answers = {};
      for (const q of item.questions) answers[q.id] = { selected: [], custom: '' };
      return { answers };
    };

    const patchAnswer = (item, qid, patch) => {
      setDraft((prev) => {
        const cur = prev[item.callId] ?? getDraft(item);
        const a = cur.answers[qid] ?? { selected: [], custom: '' };
        return { ...prev, [item.callId]: { answers: { ...cur.answers, [qid]: { ...a, ...patch } } } };
      });
    };

    const toggleOption = (item, q, label) => {
      const cur = draft[item.callId] ?? getDraft(item);
      const a = cur.answers[q.id] ?? { selected: [], custom: '' };
      const has = a.selected.includes(label);
      const selected = q.multiSelect
        ? (has ? a.selected.filter((x) => x !== label) : [...a.selected, label])
        : (has ? [] : [label]);
      patchAnswer(item, q.id, { selected });
    };

    const hasAnyAnswer = (item) => {
      const cur = draft[item.callId];
      if (!cur) return false;
      return item.questions.some((q) => {
        const a = cur.answers?.[q.id];
        return !!a && ((a.selected?.length ?? 0) > 0 || (a.custom ?? '').trim().length > 0);
      });
    };

    const submit = async (item) => {
      const cur = draft[item.callId] ?? getDraft(item);
      // 官方要求：每个问题恰有一条回答。无条件为每题生成条目，
      // 未作答的用 selected: []（合法形态，语义是"跳过"）。
      const answers = item.questions.map((q) => {
        const a = cur.answers[q.id] ?? { selected: [], custom: '' };
        const entry = { id: q.id, selected: Array.isArray(a.selected) ? a.selected : [] };
        const custom = (a.custom ?? '').trim();
        if (custom) entry.custom = custom;
        return entry;
      });
      try {
        const res = await fetch(`${API}/answer`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ callId: item.callId, answers }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok) {
          setStatus((s) => ({ ...s, [item.callId]: { kind: 'ok', text: t('answered') } }));
          setTimeout(poll, 300);
        } else {
          setStatus((s) => ({ ...s, [item.callId]: { kind: 'err', text: `${t('failed')}: ${data?.error ?? res.status}` } }));
        }
      } catch (err) {
        setStatus((s) => ({ ...s, [item.callId]: { kind: 'err', text: `${t('failed')}: ${String(err)}` } }));
      }
    };

    return h(
      'div',
      { style: placement.style, 'data-dsh-efficiency': 'questions', 'data-anchor': placement.anchor },
      ...visible.map((item) => {
        const cur = draft[item.callId] ?? getDraft(item);
        const st = status[item.callId];
        const multiQ = item.questions.length > 1;
        const canSubmit = hasAnyAnswer(item);

        return h(
          'div',
          { key: item.callId, style: S.card },
          h(
            'div',
            { style: S.head },
            h('span', { style: S.badge }, String(visible.length)),
            h('span', null, t('title')),
            h('button', {
              type: 'button', style: S.close, title: t('dismiss'),
              onClick: () => setDismissed((d) => new Set(d).add(item.callId)),
            }, '×'),
          ),
          ...item.questions.map((q, qi) =>
            h(
              'div',
              { key: q.id ?? qi, style: qi === item.questions.length - 1 ? S.qBlockLast : S.qBlock },
              q.header ? h('div', { style: S.header }, q.header) : null,
              h('div', { style: S.question },
                multiQ ? h('span', { style: S.hint }, `${qi + 1}. `) : null,
                q.question,
              ),
              q.detail ? h('div', { style: S.detail }, q.detail) : null,
              Array.isArray(q.options) && q.options.length
                ? h('div', { style: S.options },
                    ...q.options.map((opt) =>
                      h('button', {
                        key: opt.label,
                        type: 'button',
                        title: opt.description ?? '',
                        style: S.option((cur.answers[q.id]?.selected ?? []).includes(opt.label)),
                        onClick: () => toggleOption(item, q, opt.label),
                      }, opt.label),
                    ),
                  )
                : null,
              h('input', {
                style: S.input,
                placeholder: t('customPlaceholder'),
                value: cur.answers[q.id]?.custom ?? '',
                onChange: (e) => patchAnswer(item, q.id, { custom: e.target.value }),
              }),
            ),
          ),
          st ? h('div', { style: st.kind === 'ok' ? S.ok : S.err }, st.text) : null,
          h(
            'div',
            { style: S.row },
            h('button', {
              type: 'button',
              style: { ...S.primary, ...(canSubmit ? {} : S.primaryOff) },
              disabled: !canSubmit,
              onClick: () => submit(item),
            }, t('submit')),
            h('span', { style: S.hint }, item.timed ? TIMED_HINT : t('pollHint')),
          ),
        );
      }),
    );
  };
}
