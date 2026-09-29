/**
 * 待答问题浮层 —— 本项目的核心 UI。
 *
 * 行为：
 *   - 轮询 /dsh-efficiency/api/pending
 *   - 有则显示卡片：题干 + 选项按钮（多选支持）+「其他」自由文本
 *   - 点选后 POST /dsh-efficiency/api/answer
 *   - 无则完全不渲染（不占屏幕、不打扰）
 */

const POLL_MS = 1500;
const API = '/dsh-efficiency/api';

const styles = {
  wrap: {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 9999,
    maxWidth: 380,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    pointerEvents: 'auto',
  },
  card: {
    background: 'var(--dsw-alias-bg-elevated, #1f1f22)',
    color: 'var(--dsw-alias-text-primary, #f5f5f5)',
    border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    borderRadius: 12,
    padding: '12px 14px',
    boxShadow: '0 6px 24px rgba(0,0,0,.35)',
    fontSize: 13,
    lineHeight: 1.5,
  },
  head: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontWeight: 600 },
  badge: {
    background: '#c0392b',
    color: '#fff',
    borderRadius: 9,
    padding: '0 7px',
    fontSize: 11,
    lineHeight: '18px',
  },
  q: { marginBottom: 8 },
  detail: { opacity: 0.72, fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' },
  options: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  option: (active) => ({
    cursor: 'pointer',
    border: `1px solid ${active ? '#4a90d9' : 'var(--dsw-alias-border-secondary, #3a3a3f)'}`,
    background: active ? 'rgba(74,144,217,.18)' : 'transparent',
    color: 'inherit',
    borderRadius: 8,
    padding: '4px 10px',
    fontSize: 12,
    fontFamily: 'inherit',
  }),
  input: {
    width: '100%',
    boxSizing: 'border-box',
    marginTop: 8,
    padding: '6px 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    background: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 12,
  },
  row: { display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' },
  primary: {
    cursor: 'pointer',
    border: 'none',
    borderRadius: 8,
    background: '#4a90d9',
    color: '#fff',
    padding: '5px 14px',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  ghost: {
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    background: 'transparent',
    color: 'inherit',
    borderRadius: 8,
    padding: '5px 12px',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  err: { color: '#e74c3c', fontSize: 12, marginTop: 6 },
  ok: { color: '#27ae60', fontSize: 12, marginTop: 6 },
  hint: { opacity: 0.6, fontSize: 11, marginTop: 6 },
};

export function makeQuestionPanel({ h, useState, useEffect, useCallback, useRef }) {
  return function QuestionPanel({ t }) {
    const [items, setItems] = useState([]);
    // callId -> { selected: string[], custom: string }
    const [draft, setDraft] = useState({});
    const [status, setStatus] = useState({}); // callId -> { kind:'ok'|'err', text }
    const alive = useRef(true);

    const poll = useCallback(async () => {
      try {
        const res = await fetch(`${API}/pending`, { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive.current) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
      } catch {
        /* 宿主不可用时静默，不影响页面 */
      }
    }, []);

    useEffect(() => {
      alive.current = true;
      poll();
      const timer = setInterval(poll, POLL_MS);
      return () => {
        alive.current = false;
        clearInterval(timer);
      };
    }, [poll]);

    if (items.length === 0) return null;

    const toggle = (callId, label, multi) => {
      setDraft((prev) => {
        const cur = prev[callId] ?? { selected: [], custom: '' };
        const has = cur.selected.includes(label);
        const selected = multi
          ? has
            ? cur.selected.filter((x) => x !== label)
            : [...cur.selected, label]
          : has
            ? []
            : [label];
        return { ...prev, [callId]: { ...cur, selected } };
      });
    };

    const setCustom = (callId, custom) => {
      setDraft((prev) => ({ ...prev, [callId]: { ...(prev[callId] ?? { selected: [], custom: '' }), custom } }));
    };

    const submit = async (item) => {
      const cur = draft[item.callId] ?? { selected: [], custom: '' };
      // 官方要求：每个问题恰有一条回答（跳过的用 selected: []）
      const answers = item.questions.map((q, idx) => {
        const single = item.questions.length === 1;
        const base = single ? cur : { selected: [], custom: '' };
        const entry = { id: q.id, selected: base.selected ?? [] };
        const custom = (base.custom ?? '').trim();
        if (custom) entry.custom = custom;
        // 保证既有回答形态：跳过的问题也保留条目
        return entry;
      });
      // 多问题场景：先在单项上简化 —— 只提交第一题的作答，其余标为跳过
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
      { style: styles.wrap },
      ...items.map((item) => {
        const cur = draft[item.callId] ?? { selected: [], custom: '' };
        const st = status[item.callId];
        return h(
          'div',
          { key: item.callId, style: styles.card },
          h(
            'div',
            { style: styles.head },
            h('span', { style: styles.badge }, String(items.length)),
            h('span', null, t('title')),
            item.timed ? h('span', { style: styles.hint }, t('multiHint') === '' ? '' : '⏱') : null,
          ),
          ...item.questions.map((q, qi) =>
            h(
              'div',
              { key: q.id ?? qi, style: styles.q },
              q.header ? h('div', { style: styles.hint }, q.header) : null,
              h('div', null, q.question),
              q.detail ? h('div', { style: styles.detail }, q.detail) : null,
              Array.isArray(q.options) && q.options.length
                ? h(
                    'div',
                    { style: styles.options },
                    ...q.options.map((opt) =>
                      h(
                        'button',
                        {
                          key: opt.label,
                          type: 'button',
                          style: styles.option(cur.selected.includes(opt.label)),
                          title: opt.description ?? '',
                          onClick: () => toggle(item.callId, opt.label, q.multiSelect === true),
                        },
                        opt.label,
                      ),
                    ),
                  )
                : null,
            ),
          ),
          h('input', {
            style: styles.input,
            placeholder: t('customPlaceholder'),
            value: cur.custom ?? '',
            onChange: (e) => setCustom(item.callId, e.target.value),
          }),
          st ? h('div', { style: st.kind === 'ok' ? styles.ok : styles.err }, st.text) : null,
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { type: 'button', style: styles.primary, onClick: () => submit(item) },
              t('submit'),
            ),
            h('span', { style: styles.hint }, t('pollHint')),
          ),
        );
      }),
    );
  };
}
