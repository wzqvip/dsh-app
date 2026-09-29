/**
 * 设置页一栏：说明本插件做什么、当前状态与后续开关位置。
 *
 * 目前只做「说明 + 实时状态」，避免过早引入设置持久化
 * （注意：非 loopback 页面下 dsh-settings 不落盘，见 ARCHITECTURE.md §7）。
 */

const API = '/dsh-efficiency/api';

const s = {
  wrap: { padding: '4px 0', fontSize: 13, lineHeight: 1.7 },
  title: { fontWeight: 600, marginBottom: 6 },
  row: { display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 6 },
  k: { opacity: 0.6, minWidth: 96 },
  v: { fontWeight: 500 },
  hint: { opacity: 0.6, fontSize: 12, marginTop: 10 },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.85 },
};

export function makeSettingsSection({ h, useState, useEffect }) {
  return function SettingsSection({ t }) {
    const [health, setHealth] = useState(null);

    useEffect(() => {
      let alive = true;
      const load = async () => {
        try {
          const res = await fetch(`${API}/health`, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(String(res.status));
          const data = await res.json();
          if (alive) setHealth(data);
        } catch (err) {
          if (alive) setHealth({ error: String(err) });
        }
      };
      load();
      const timer = setInterval(load, 3000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, []);

    return h(
      'div',
      { style: s.wrap },
      h('div', { style: s.title }, t('nav')),
      h('div', null, t('enabledHint')),
      h(
        'div',
        { style: s.row },
        h('span', { style: s.k }, '待答问题'),
        h('span', { style: s.v }, health?.error ? `宿主不可用（${health.error}）` : String(health?.pending ?? '—')),
      ),
      h(
        'div',
        { style: s.row },
        h('span', { style: s.k }, '已提交'),
        h('span', { style: s.v }, health?.error ? '—' : String(health?.answered ?? '—')),
      ),
      h('div', { style: s.hint }, t('pollHint')),
      h('div', { style: s.hint }, h('span', { style: s.code }, `${API}/health`)),
    );
  };
}
