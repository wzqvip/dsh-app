/**
 * 设置页：效率助手的开关集合。
 *
 * 设计要点：
 *   1. **不重写 dsh-pet 的设置面板** —— 直接调用它的公开 HTTP 契约
 *      （GET/PUT /dsh-pet-7340/config，见 research/13）。理由：
 *      它的 PUT 已有白名单校验、会保留用户手改的精调字段、且保存后
 *      自动重启桌面 Helper（display/size 变化无需手动重启）。
 *   2. **必须优雅降级**：按 ARCHITECTURE.md §9 的 L1/L2 分层，
 *      核心层不得依赖承载层。dsh-pet 不在时隐藏整个分区，不报错。
 *   3. 只提交白名单字段，其余字段由宿主自己透传保留（源码已保证）。
 */

const PET_API = '/dsh-pet-7340';
const DISPLAYS = ['web', 'desktop', 'both', 'none'];

const S = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
  legend: { fontWeight: 600, fontSize: 13, opacity: 0.9 },
  row: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  rowLabel: { flex: '0 0 auto', minWidth: 96, fontSize: 13, paddingTop: 2 },
  control: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
  hint: { opacity: 0.6, fontSize: 11, lineHeight: 1.5 },
  select: {
    background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    borderRadius: 6, padding: '3px 6px', fontFamily: 'inherit', fontSize: 12, maxWidth: 200,
  },
  input: {
    background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    borderRadius: 6, padding: '3px 6px', fontFamily: 'inherit', fontSize: 12, width: 90,
  },
  btn: {
    cursor: 'pointer', border: 'none', borderRadius: 6, background: '#4d6bfe',
    color: '#fff', padding: '5px 14px', fontSize: 12, fontFamily: 'inherit',
  },
  btnOff: { cursor: 'not-allowed', opacity: 0.45 },
  ghost: {
    cursor: 'pointer', border: '1px solid var(--dsw-alias-border-secondary, #3a3a3f)',
    background: 'transparent', color: 'inherit', borderRadius: 6, padding: '5px 12px',
    fontSize: 12, fontFamily: 'inherit',
  },
  footer: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 },
  ok: { color: '#1a7f37', fontSize: 12 },
  err: { color: '#b42318', fontSize: 12 },
  missing: {
    fontSize: 12, opacity: 0.75, padding: '8px 10px',
    border: '1px dashed var(--dsw-alias-border-secondary, #3a3a3f)', borderRadius: 8,
  },
  checkbox: { margin: 0, cursor: 'pointer' },
};

/** 从成品配置里取出 main 条目的第一只宠物 */
function mainPet(config) {
  const main = config?.main;
  if (!main) return null;
  const pets = Array.isArray(main.pets) ? main.pets : [];
  return pets[0] ?? null;
}

export function makeSettingsSection({ h, useState, useEffect, useCallback }) {
  return function SettingsSection({ t }) {
    const [config, setConfig] = useState(null);
    const [available, setAvailable] = useState(null); // null=未知 true/false
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState(null);
    const [edit, setEdit] = useState(null);

    const load = useCallback(async () => {
      try {
        const res = await fetch(`${PET_API}/config`, { credentials: 'same-origin' });
        if (!res.ok) { setAvailable(false); return; }
        const data = await res.json();
        const pet = mainPet(data);
        if (!pet) { setAvailable(false); return; }
        setAvailable(true);
        setConfig(data);
        setEdit({
          workStatusEnabled: pet.workStatusEnabled === true,
          notificationsEnabled: data.main.notificationsEnabled === true,
          // 兜底与内置默认一致：**desktop**（本仓库默认桌面宠物；上游默认是 both）。
      // 这里若写成 both 会与 config.jsonc 的默认不一致 —— 未读到配置时行为就变了。
      display: DISPLAYS.includes(pet.display) ? pet.display : 'desktop',
          size: typeof pet.size === 'number' ? pet.size : 462,
        });
      } catch {
        setAvailable(false);
      }
    }, []);

    useEffect(() => { load(); }, [load]);

    const save = async () => {
      if (!edit || !config) return;
      setBusy(true);
      setStatus(null);
      const pet = mainPet(config);
      try {
        // 只提交白名单字段；physics/memes/workStatusTexts/... 由宿主读磁盘原对象后透传保留
        const body = {
          notificationsEnabled: edit.notificationsEnabled,
          pets: [{
            id: pet.id,
            name: pet.name,
            size: Number(edit.size) || pet.size,
            balanceEnabled: pet.balanceEnabled === true,
            whisperEnabled: pet.whisperEnabled === true,
            workStatusEnabled: edit.workStatusEnabled,
            display: edit.display,
            position: pet.position,
          }],
        };
        const res = await fetch(`${PET_API}/config`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setStatus({ kind: 'ok', text: t('saved') });
          setConfig(data);
        } else {
          setStatus({ kind: 'err', text: `${t('saveFailed')}: ${data?.error ?? res.status}` });
        }
      } catch (err) {
        setStatus({ kind: 'err', text: `${t('saveFailed')}: ${String(err)}` });
      } finally {
        setBusy(false);
      }
    };

    if (available === null) {
      return h('div', { style: S.wrap }, h('div', { style: S.hint }, t('saving')));
    }
    if (available === false) {
      return h('div', { style: S.wrap },
        h('div', { style: S.legend }, t('petSection')),
        h('div', { style: S.missing }, t('petMissing')),
      );
    }

    const set = (patch) => setEdit((e) => ({ ...e, ...patch }));

    return h('div', { style: S.wrap },
      h('div', { style: S.legend }, t('petSection')),

      h('div', { style: S.row },
        h('label', { style: S.rowLabel }, t('statusEnabled')),
        h('div', { style: S.control },
          h('input', {
            type: 'checkbox', style: S.checkbox, checked: !!edit.workStatusEnabled,
            onChange: (e) => set({ workStatusEnabled: e.target.checked }),
          }),
          h('div', { style: S.hint }, t('statusEnabledHint')),
        ),
      ),

      h('div', { style: S.row },
        h('label', { style: S.rowLabel }, t('notifyEnabled')),
        h('div', { style: S.control },
          h('input', {
            type: 'checkbox', style: S.checkbox, checked: !!edit.notificationsEnabled,
            onChange: (e) => set({ notificationsEnabled: e.target.checked }),
          }),
          h('div', { style: S.hint }, t('notifyEnabledHint')),
        ),
      ),

      h('div', { style: S.row },
        h('label', { style: S.rowLabel }, t('displayMode')),
        h('div', { style: S.control },
          h('select', {
            style: S.select, value: edit.display,
            onChange: (e) => set({ display: e.target.value }),
          }, ...DISPLAYS.map((d) => h('option', { key: d, value: d }, d))),
          h('div', { style: S.hint }, t('displayHint')),
        ),
      ),

      h('div', { style: S.row },
        h('label', { style: S.rowLabel }, t('size')),
        h('div', { style: S.control },
          h('input', {
            type: 'number', min: 80, max: 2000, step: 10, style: S.input,
            value: edit.size,
            onChange: (e) => set({ size: e.target.value }),
          }),
        ),
      ),

      // ⚠️ 指路提示（实测踩过）：完整的设置窗口只能从**桌面小窗**的右键菜单打开，
      //    网页浮层里没有那一项 —— 网页与桌面用的是**两套不同的工具项**：
      //      桌面（sprite.js）：打开网站 / 查看余额 / 设置… / 回到初始位置
      //      网页（client/pet.ts）：打开网站 / 查看余额 / 碎碎念 / 对话
      //    因为 openSettings 需要经 IPC 通知 Electron 主进程，网页端没有这条通道。
      //    维护者实测时就因此以为"没有设置菜单"，所以这里说清楚去哪点。
      h('div', { style: S.row },
        h('label', { style: S.rowLabel }, t('openSettingsWhere')),
        h('div', { style: S.control },
          h('div', { style: S.hint }, t('openSettingsWhereHint')),
        ),
      ),

      h('div', { style: S.footer },
        h('button', {
          type: 'button',
          style: { ...S.btn, ...(busy ? S.btnOff : {}) },
          disabled: busy,
          onClick: save,
        }, busy ? t('saving') : t('save')),
        h('button', { type: 'button', style: S.ghost, onClick: load }, t('reload')),
        status ? h('span', { style: status.kind === 'ok' ? S.ok : S.err }, status.text) : null,
      ),
    );
  };
}
