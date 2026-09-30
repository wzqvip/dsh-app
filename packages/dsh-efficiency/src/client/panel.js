/**
 * 待答问题面板 —— 本项目核心 UI。
 *
 * 两种数据来源（同时支持）：
 *   A. answerer 模式（主）：客户端 answerer 把问题直接投递进来，
 *      用户点选后把答案 return 回 waterfall。**不依赖官方 UI**。
 *   B. 轮询模式（辅）：轮询宿主 /dsh-efficiency/api/pending。
 *      用于宿主侧确实拿到提问的场景（当前宿主侧收不到，保留作降级/未来用）。
 *
 * 定位目标：把问题内容与选项**原样**呈现、**点一下就作答**、贴在宠物旁边。
 *
 * 安全契约：任何不确定的情况都让位（见 answerer.js），
 *           所以面板的"放弃"必须真的把控制权交回去，不能吞掉提问。
 */

import { fetchPetLayout, computePanelPlacement } from './placement.js';
import { clog } from './logger.js';

const POLL_MS = 2000;
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
  sourceTag: { opacity: 0.5, fontSize: 10, marginLeft: 4 },
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
  input: {
    width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '6px 8px',
    borderRadius: 8, border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12,
  },
  row: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' },
  primary: {
    cursor: 'pointer', border: 'none', borderRadius: 8, background: '#4a90d9',
    color: '#fff', padding: '6px 16px', fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
  },
  primaryOff: { cursor: 'not-allowed', opacity: 0.45 },
  ghost: {
    cursor: 'pointer', border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    background: 'transparent', color: 'inherit', borderRadius: 8, padding: '6px 12px',
    fontSize: 12, fontFamily: 'inherit',
  },
  err: { color: '#e74c3c', fontSize: 12, marginTop: 6 },
  ok: { color: '#27ae60', fontSize: 12, marginTop: 6 },
  hint: { opacity: 0.55, fontSize: 11 },
};

/**
 * 构造 answers。官方要求每个问题恰有一条回答；
 * 未作答的用 selected: [] 表示"跳过"（合法形态）。
 */
function buildAnswers(questions, draft) {
  return questions.map((q) => {
    const a = draft?.[q.id] ?? { selected: [], custom: '' };
    const entry = { id: q.id, selected: Array.isArray(a.selected) ? a.selected : [] };
    const custom = (a.custom ?? '').trim();
    if (custom) entry.custom = custom;
    return entry;
  });
}

function hasAnyAnswer(questions, draft) {
  if (!draft) return false;
  return questions.some((q) => {
    const a = draft[q.id];
    return !!a && ((a.selected?.length ?? 0) > 0 || (a.custom ?? '').trim().length > 0);
  });
}

function emptyDraft(questions) {
  const d = {};
  for (const q of questions) d[q.id] = { selected: [], custom: '' };
  return d;
}

export function makeQuestionPanel({ h, useState, useEffect, useCallback, useRef }) {
  return function QuestionPanel({ t, bridge }) {
    const [polled, setPolled] = useState([]);
    // answerer 投递进来的提问（同一时刻通常只有一个）
    const [local, setLocal] = useState(null);
    const [draft, setDraft] = useState({});
    const [status, setStatus] = useState({});
    const [petLayout, setPetLayout] = useState(null);
    const [viewport, setViewport] = useState({ width: 1280, height: 800 });
    const alive = useRef(true);
    const mounted = useRef(false);
    const loggedEmpty = useRef(false);
    const loggedRendered = useRef(false);

    // 组件挂载即上报一次：这是区分"没渲染"与"渲染了但看不见"的关键证据。
    // 若宿主日志里没有这一行 → 组件根本没被挂载 → 问题在槽位注册。
    // 若有这一行却没有卡片 → 组件在渲染，问题在定位/样式/数据。
    if (!mounted.current) {
      mounted.current = true;
      clog('info', 'QuestionPanel 已挂载（组件被 React 渲染）', {
        hasBridge: !!bridge,
        win: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'n/a',
      });
    }

    // ---- A. answerer 入口：把接收器交给 bridge ----
    useEffect(() => {
      if (!bridge?.setReceiver) return undefined;
      const off = bridge.setReceiver((payload, control) => {
        setLocal({ ...payload, control });
        setDraft((prev) => ({ ...prev, [payload.callId]: emptyDraft(payload.questions) }));
      });
      return off;
    }, [bridge]);

    // ---- B. 轮询宿主（辅助路径）----
    const poll = useCallback(async () => {
      try {
        const res = await fetch(`${API}/pending`, { credentials: 'same-origin' });
        if (!res.ok) {
          clog('warn', `poll /pending 非 200: ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!alive.current) return;
        const list = Array.isArray(data?.items) ? data.items : [];
        setPolled(list);
        if (list.length > 0) clog('info', `poll 得到 ${list.length} 条待答`);
      } catch (err) {
        clog('warn', `poll /pending 失败: ${String(err)}`);
      }
    }, []);

    useEffect(() => {
      alive.current = true;
      poll();
      const timer = setInterval(poll, POLL_MS);
      return () => { alive.current = false; clearInterval(timer); };
    }, [poll]);

    // ---- 宠物布局（就近定位）----
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

    // 统一视图模型：本地（answerer）优先，其后是轮询来的
    const items = [];
    if (local) items.push({ ...local, source: 'local' });
    for (const it of polled) {
      if (local && it.callId === local.callId) continue;
      items.push({ ...it, source: 'poll' });
    }
    if (items.length === 0) {
      // 没有待答：组件返回 null。这是正常状态，但要能区分"没数据"与"没渲染"。
      if (!loggedEmpty.current) {
        loggedEmpty.current = true;
        clog('info', 'QuestionPanel 渲染但无待答数据（返回 null）');
      }
      return null;
    }
    loggedEmpty.current = false;

    const placement = computePanelPlacement(petLayout, viewport);
    if (!loggedRendered.current) {
      loggedRendered.current = true;
      clog('info', `面板开始渲染 ${items.length} 条`, {
        anchor: placement.anchor,
        style: placement.style,
        petLayout,
      });
    }

    const patchAnswer = (callId, qid, patch, questions) => {
      setDraft((prev) => {
        const cur = prev[callId] ?? emptyDraft(questions);
        const a = cur[qid] ?? { selected: [], custom: '' };
        return { ...prev, [callId]: { ...cur, [qid]: { ...a, ...patch } } };
      });
    };

    const toggleOption = (item, q, label) => {
      const cur = draft[item.callId] ?? emptyDraft(item.questions);
      const a = cur[q.id] ?? { selected: [], custom: '' };
      const has = a.selected.includes(label);
      const selected = q.multiSelect
        ? (has ? a.selected.filter((x) => x !== label) : [...a.selected, label])
        : (has ? [] : [label]);
      patchAnswer(item.callId, q.id, { selected }, item.questions);
    };

    const submit = async (item) => {
      const cur = draft[item.callId] ?? emptyDraft(item.questions);
      const answers = buildAnswers(item.questions, cur);

      if (item.source === 'local') {
        // answerer 模式：把答案 return 回 waterfall，由官方链路落地
        try {
          item.control.submit({ answers });
          setStatus((s) => ({ ...s, [item.callId]: { kind: 'ok', text: t('answered') } }));
          setLocal(null);
        } catch (err) {
          setStatus((s) => ({ ...s, [item.callId]: { kind: 'err', text: `${t('failed')}: ${String(err)}` } }));
        }
        return;
      }

      // 轮询模式：POST 给宿主
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

    /** 放弃作答：answerer 模式下必须真的让位，否则会吞掉提问 */
    const decline = (item) => {
      if (item.source === 'local') {
        item.control.decline();
        setLocal(null);
        return;
      }
      setPolled((p) => p.filter((x) => x.callId !== item.callId));
    };

    return h(
      'div',
      { style: placement.style, 'data-dsh-efficiency': 'questions', 'data-anchor': placement.anchor },
      ...items.map((item) => {
        const cur = draft[item.callId] ?? emptyDraft(item.questions);
        const st = status[item.callId];
        const multiQ = item.questions.length > 1;
        const canSubmit = hasAnyAnswer(item.questions, cur);

        return h(
          'div',
          { key: item.callId, style: S.card },
          h(
            'div',
            { style: S.head },
            h('span', { style: S.badge }, String(item.questions.length)),
            // ⚠️ 第二参数必须是对象，**不能是 null**。
            //    h 是 react/jsx-runtime 的 jsx（签名 jsx(type, config, key)），
            //    它内部会读 config.key —— 传 null 直接抛
            //      TypeError: Cannot read properties of null (reading 'key')
            //    而且是【崩在宿主页面的 React 里】（错误栈指向 DSH 自己的 bundle），
            //    现场表现为 "slot entry crashed in 'shell.overlay'"，
            //    极难反推到这一行。只有真的有提问要渲染时才会走到这里，
            //    所以这个缺陷长期潜伏（踩过，记下来）。
            h('span', {}, t('title')),
            item.source === 'local' ? h('span', { style: S.sourceTag }, t('liveTag')) : null,
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
                        style: S.option((cur[q.id]?.selected ?? []).includes(opt.label)),
                        onClick: () => toggleOption(item, q, opt.label),
                      }, opt.label),
                    ),
                  )
                : null,
              h('input', {
                style: S.input,
                placeholder: t('customPlaceholder'),
                value: cur[q.id]?.custom ?? '',
                onChange: (e) => patchAnswer(item.callId, q.id, { custom: e.target.value }, item.questions),
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
            h('button', {
              type: 'button',
              style: S.ghost,
              title: t('declineHint'),
              onClick: () => decline(item),
            }, t('decline')),
            h('span', { style: S.hint }, item.timed ? t('timedHint') : t('pollHint')),
          ),
        );
      }),
    );
  };
}
