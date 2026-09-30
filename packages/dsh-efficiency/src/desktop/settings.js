// [dsh-app] 桌宠设置窗口的表单逻辑。
//
// 设计：**schema 驱动**。
//   表单不是手写一张固定列表，而是按「服务端返回的配置结构 + 一份字段元数据」
//   生成的。好处是：上游给 config 加字段时，这里只要补一条元数据就能出现，
//   不会出现"界面能改的字段与后端实际支持的字段对不上"这种漂移。
//
// 数据流：
//   载入 → settingsBridge.getConfig()（走 dsh-pet-bridge:// → 宿主 handlePetRoute）
//        → 按 schema 渲染 → 用户改动进 patch
//   保存 → settingsBridge.putConfig(patch) → 宿主白名单校验 → 写文件 → 重启助手

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) if (c) n.appendChild(c);
  return n;
};

/** 待提交的补丁：顶层字段直接放这里；宠物实例字段放 patch.pets[0] */
let patch = { pets: [] };
/** 当前载入的原始配置（用于展示只读信息与"改了没有"的判断） */
let loaded = null;
/** 本次要编辑的宠物下标（暂时只做第一只；多宠时这里扩展） */
const PET_INDEX = 0;

// ---------------------------------------------------------------------------
// 字段元数据：id → 展示名 / 说明 / 控件类型
// 没登记在这里的字段不会出现在界面上（避免误改未知字段）。
// ---------------------------------------------------------------------------
const PET_FIELDS = {
  name: { label: '名字', kind: 'text', desc: '显示用的名称' },
  size: { label: '大小', kind: 'range', min: 200, max: 900, step: 10, unit: 'px', desc: '宠物宽度；改完保存即生效' },
  display: {
    label: '显示方式',
    kind: 'select',
    options: [
      ['web', '仅网页浮层'],
      ['desktop', '仅桌面小窗'],
      ['both', '两者都要'],
      ['none', '都不显示'],
    ],
    desc: '网页浮层在浏览器页面里；桌面小窗是独立的透明窗口',
  },
  corner: { label: '停靠角落', kind: 'select', path: ['position', 'corner'], options: [
    ['top-left', '左上'], ['top-right', '右上'], ['bottom-left', '左下'], ['bottom-right', '右下'],
  ] },
  marginX: { label: '水平边距', kind: 'number', path: ['position', 'marginX'], unit: 'px' },
  marginY: { label: '垂直边距', kind: 'number', path: ['position', 'marginY'], unit: 'px' },
  balanceEnabled: { label: '余额提醒', kind: 'bool', desc: '按服务商公开接口查余额并播档位动画' },
  whisperEnabled: { label: '主动碎碎念', kind: 'bool', desc: '按周期自动让模型说一句话（会消耗 token）' },
  workStatusEnabled: { label: '工作状态联动', kind: 'bool', desc: '把会话进度映射成档位动画（不消耗 token）' },
};

const TOP_FIELDS = {
  notificationsEnabled: { label: '系统通知', kind: 'bool', desc: '需要你注意时发系统通知' },
  whisperImageEnabled: { label: '碎碎念配表情包', kind: 'bool', desc: '让模型从表情包池里挑一张' },
  chatImageEnabled: { label: '对话配表情包', kind: 'bool', desc: '按语境挑图，回复更生动' },
  whisperPrompt: {
    label: '人设提示词',
    kind: 'textarea',
    desc: '碎碎念与对话共用的人设。留空则用内置默认',
  },
  chatMemoryRounds: { label: '对话记忆轮数', kind: 'number', min: 0, max: 50, desc: '每次请求带多少轮历史（1 轮 = 1 问 1 答）' },
  eventsRefreshSec: { label: '事件刷新间隔', kind: 'number', min: 1, max: 3600, unit: '秒', desc: '余额等事件轮询周期' },
};

// workStatusTexts 是 6 档文案数组，单独处理（要按档位名展示）
const WORK_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'];
const WORK_STATE_LABELS = {
  thinking: '思考中',
  working: '执行中',
  result: '出结果',
  waiting: '等你回复',
  success: '成功',
  error: '出错',
};

// ---------------------------------------------------------------------------
// 取值 / 设值（支持 path）
// ---------------------------------------------------------------------------
const getAt = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    o = o[path[i]] ?? (o[path[i]] = {});
  }
  o[path[path.length - 1]] = value;
}

const pet = () => loaded?.config?.pets?.[PET_INDEX] ?? {};
const petPatch = () => {
  patch.pets[PET_INDEX] ??= {};
  return patch.pets[PET_INDEX];
};

// ---------------------------------------------------------------------------
// 控件构造
// ---------------------------------------------------------------------------
function buildControl(meta, current, onInput) {
  const { kind } = meta;
  if (kind === 'bool') {
    const input = el('input', { type: 'checkbox' });
    input.checked = current === true;
    input.addEventListener('change', () => onInput(input.checked));
    return el('div', { class: 'switch' }, [input, el('span', { text: input.checked ? '开启' : '关闭' })]);
  }
  if (kind === 'select') {
    const sel = el('select');
    for (const [v, label] of meta.options) {
      const opt = el('option', { value: v, text: label });
      if (String(current) === String(v)) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onInput(sel.value));
    return sel;
  }
  if (kind === 'range') {
    const num = el('span', { class: 'num', text: `${current ?? ''}${meta.unit ?? ''}` });
    const input = el('input', { type: 'range', min: meta.min, max: meta.max, step: meta.step ?? 1 });
    input.value = String(current ?? meta.min);
    input.addEventListener('input', () => {
      num.textContent = `${input.value}${meta.unit ?? ''}`;
      onInput(Number(input.value));
    });
    return el('div', { class: 'value-line' }, [input, num]);
  }
  if (kind === 'number') {
    const input = el('input', { type: 'number' });
    if (meta.min !== undefined) input.min = String(meta.min);
    if (meta.max !== undefined) input.max = String(meta.max);
    input.value = current === undefined || current === null ? '' : String(current);
    input.addEventListener('input', () => {
      const v = input.value.trim();
      onInput(v === '' ? undefined : Number(v));
    });
    return meta.unit ? el('div', { class: 'value-line' }, [input, el('span', { class: 'num', text: meta.unit })]) : input;
  }
  if (kind === 'textarea') {
    const input = el('textarea');
    input.value = current ?? '';
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }
  const input = el('input', { type: 'text' });
  input.value = current ?? '';
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function buildRow(meta, current, onInput) {
  const desc = meta.desc ? el('span', { class: 'desc', text: meta.desc }) : null;
  const label = el('label', {}, [el('span', { text: meta.label }), desc]);
  const control = buildControl(meta, current, onInput);
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  label.setAttribute('for', id);
  control.id = id;
  return el('div', { class: 'row' }, [label, control]);
}

function buildCard(title, hint, rows) {
  const card = el('section', { class: 'card' }, [el('h2', { text: title })]);
  if (hint) card.appendChild(el('p', { class: 'hint', text: hint }));
  for (const r of rows) card.appendChild(r);
  return card;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function render() {
  const p = pet();
  const cfg = loaded?.config ?? {};
  const root = $('#sections');
  root.textContent = '';

  // 1) 宠物实例
  const petRows = [];
  let petMeta = {};
  for (const [key, meta] of Object.entries(PET_FIELDS)) {
    const path = meta.path ?? [key];
    const current = getAt(p, path);
    petMeta[key] = meta;
    petRows.push(
      buildRow(meta, current, (v) => {
        setAt(petPatch(), path, v);
        markDirty();
      }),
    );
  }
  root.appendChild(buildCard('宠物', '外观与显示方式', petRows));

  // 2) 提醒与联动（顶层开关）
  const topRows = [];
  for (const [key, meta] of Object.entries(TOP_FIELDS)) {
    const current = cfg[key];
    topRows.push(
      buildRow(meta, current, (v) => {
        patch[key] = v;
        markDirty();
      }),
    );
  }
  root.appendChild(buildCard('提醒与对话', '气泡、通知与模型相关设置', topRows));

  // 3) 工作状态文案（6 档）
  const wsRows = [];
  const texts = cfg.workStatusTexts;
  for (let i = 0; i < WORK_STATES.length; i++) {
    const state = WORK_STATES[i];
    const cur = Array.isArray(texts) ? texts[i] : undefined;
    const shown = Array.isArray(cur) ? cur.join(' / ') : cur ?? '';
    wsRows.push(
      buildRow(
        { label: WORK_STATE_LABELS[state] ?? state, kind: 'textarea', desc: '多句用 / 分隔，随机抽一句' },
        shown,
        (v) => {
          const arr = String(v)
            .split('/')
            .map((s) => s.trim())
            .filter(Boolean);
          patch.workStatusTexts ??= (Array.isArray(texts) ? texts.slice() : new Array(WORK_STATES.length).fill([]));
          patch.workStatusTexts[i] = arr;
          markDirty();
        },
      ),
    );
  }
  root.appendChild(buildCard('工作状态文案', '对应「思考中 / 执行中 / 出结果 / 等你回复 / 成功 / 出错」六档', wsRows));

  // 4) 只读诊断信息（帮助排障，不做成可改）
  //    注意：GET /config 不返回"配置文件路径/素材根"这类元信息
  //    （实测响应只有按桶分组的配置），所以这里只展示确定有的东西，
  //    不编造不存在的字段。
  const infoRows = [
    el('div', { class: 'row' }, [
      el('label', { text: '宠物标识' }),
      el('div', { class: 'readonly' }, [el('code', { text: String(p.id ?? '(无)') })]),
    ]),
    el('div', { class: 'row' }, [
      el('label', { text: '配置桶' }),
      el('div', { class: 'readonly' }, [el('code', { text: String(loaded?.bucketName ?? '(未知)') })]),
    ]),
    el('div', { class: 'row' }, [
      el('label', { text: '宠物总数' }),
      el('div', { class: 'readonly' }, [el('code', { text: String(Array.isArray(cfg.pets) ? cfg.pets.length : 0) })]),
    ]),
  ];
  root.appendChild(buildCard('诊断信息', '排障时把这些贴出来即可定位问题', infoRows));

  void petMeta;
  updateMeta();
}

function updateMeta() {
  const n = countPatch();
  $('#meta').textContent = n === 0 ? '尚未修改' : `${n} 处待保存`;
}

function countPatch() {
  let n = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'pets') {
      for (const pe of v) n += pe ? Object.keys(pe).length : 0;
    } else if (v !== undefined) {
      n += 1;
    }
  }
  return n;
}

let dirty = false;
function markDirty() {
  dirty = true;
  const n = countPatch();
  setStatus(n ? `${n} 处待保存` : '尚未修改', '');
  $('#save').disabled = n === 0;
  updateMeta();
}

function setStatus(text, kind) {
  const s = $('#status');
  s.textContent = text;
  s.className = 'status' + (kind ? ` is-${kind}` : '');
}

// ---------------------------------------------------------------------------
// 载入 / 保存
// ---------------------------------------------------------------------------
async function load() {
  setStatus('读取中…', '');
  $('#save').disabled = true;
  try {
    const res = await window.settingsBridge.getConfig();
    // ⚠️ 真实契约（实测）：GET /dsh-pet-7340/config 返回的是**按"种类桶"分组的聚合**
    //    { main: {pets, whisperPrompt, ...}, test1: {...} }
    //    （宿主原话：readAllConfig 返回绝对正确的完成品聚合，调用方直接消费）
    //    不是 { ok, config }。取第一个桶即可 —— 所有桶共享同一份顶层设置。
    if (!res.json || typeof res.json !== 'object' || res.json.error) {
      setStatus(`读取失败：${res.json?.error ?? res.status}`, 'err');
      return;
    }
    const bucketName = Object.keys(res.json)[0];
    if (!bucketName) {
      setStatus('配置为空', 'err');
      return;
    }
    loaded = { config: res.json[bucketName], bucketName };
    patch = { pets: [] };
    dirty = false;
    render();
    setStatus('已载入', 'ok');
    $('#save').disabled = true;
  } catch (err) {
    setStatus(`读取异常：${String(err && err.message ? err.message : err)}`, 'err');
  }
}

async function save() {
  const n = countPatch();
  if (n === 0) return;
  $('#save').disabled = true;
  setStatus('保存中…', '');
  try {
    const { payload, changed } = buildPayload();
    if (!changed) {
      setStatus('没有实际改动', '');
      patch = { pets: [] };
      return;
    }
    const res = await window.settingsBridge.putConfig(payload);
    // 契约：成功 → 返回保存后的成品聚合（同 GET）；失败 → { error }
    if (!res.json || res.json.error || res.status >= 400) {
      setStatus(`保存失败：${res.json?.error ?? res.status}`, 'err');
      $('#save').disabled = false;
      return;
    }
    setStatus('已保存 ✓', 'ok');
    patch = { pets: [] };
    dirty = false;
    // 用服务端返回的成品刷新界面：能立刻看出哪些字段没被接受
    const bucketName = Object.keys(res.json)[0];
    if (bucketName) {
      loaded = { config: res.json[bucketName], bucketName };
      render();
    }
  } catch (err) {
    setStatus(`保存异常：${String(err && err.message ? err.message : err)}`, 'err');
    $('#save').disabled = false;
  }
}

/**
 * 组装 PUT 负载。
 * ⚠️ 宿主的校验要求 pets 是【必填且非空】数组（实测：不带 pets 直接回 400），
 *    所以即便只改了一个顶层开关，也要把该宠物的完整实例带上。
 * 返回 { payload, changed }：changed=false 表示与载入值完全一致，不必发请求。
 */
function buildPayload() {
  const p = pet();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const payload = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'pets') continue;
    if (!same(getAt(loaded.config, [k]), v)) payload[k] = v;
  }
  // 宠物实例：原值 + 本次改动合并后整体提交
  const merged = { ...p };
  const pp = patch.pets?.[PET_INDEX];
  if (pp) {
    for (const [k, v] of Object.entries(pp)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) merged[k] = { ...(merged[k] ?? {}), ...v };
      else merged[k] = v;
    }
  }
  const petChanged = pp ? Object.keys(pp).length > 0 : false;
  payload.pets = [merged];
  return { payload, changed: petChanged || Object.keys(payload).some((k) => k !== 'pets') };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
$('#save').addEventListener('click', save);
$('#reload').addEventListener('click', load);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});
load();
