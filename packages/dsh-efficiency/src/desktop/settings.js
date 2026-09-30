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
  // ⚠️ eventsRefreshSec 是**按事件键的对象**（{balance, whisper}），不是单个秒数。
  //    我最初按整数做成一个输入框，结果被宿主合并器静默丢弃、退回内置默认
  //    （实测：写了 30，磁盘上没有该字段，接口仍返回 {balance:1800,whisper:300}）——
  //    典型的"保存成功但值没变"。所以改成按事件键逐项渲染。
  eventsRefreshSec: {
    label: '事件刷新间隔',
    kind: 'keyed',
    keys: [
      { key: 'balance', label: '余额', min: 1, max: 86400, desc: '余额轮询周期（秒）' },
      { key: 'whisper', label: '碎碎念', min: 1, max: 86400, desc: '碎碎念轮询周期（秒）' },
    ],
    desc: '按事件分别设置轮询周期（秒）',
  },
};

/** 物理引擎参数（与内置默认同形的 6 个键） */
const PHYSICS_FIELDS = [
  { key: 'gravity', label: '重力', kind: 'number', min: 0, max: 100000, desc: '越大掉落越快' },
  { key: 'restitution', label: '弹性', kind: 'number', min: 0, max: 1, step: 0.01, desc: '0 = 不弹，1 = 完全弹性' },
  { key: 'groundFriction', label: '地面摩擦', kind: 'number', min: 0, max: 100, step: 0.1, desc: '落地后减速快慢' },
  { key: 'throwPower', label: '抛掷力度', kind: 'number', min: 0, max: 10, step: 0.1, desc: '拖拽甩出的力度倍率' },
  { key: 'ceilingBounce', label: '顶部反弹', kind: 'bool', desc: '撞到屏幕顶部是否反弹' },
  { key: 'petCollision', label: '宠物互撞', kind: 'bool', desc: '多只宠物之间是否发生碰撞' },
];

/** 动画随机链权重（三个非负整数） */
const WEIGHT_FIELDS = [
  { key: 'idle', label: '待机', kind: 'number', min: 0, max: 1000, desc: '权重越大越常进入待机' },
  { key: 'turn', label: '转向', kind: 'number', min: 0, max: 1000, desc: '随机链里转向的权重' },
  { key: 'move', label: '移动', kind: 'number', min: 0, max: 1000, desc: '随机链里移动的权重' },
];

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
  if (kind === 'keyed') {
    // 按对象子键逐项渲染（用于 eventsRefreshSec 这种 {balance, whisper} 形态）。
    // 任一子键变化都回传**整个对象**（宿主按对象校验）。
    const wrap = el('div', { class: 'keyed' });
    const curObj = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const draftObj = { ...curObj };
    for (const sub of meta.keys) {
      const input = el('input', { type: 'number' });
      if (sub.min !== undefined) input.min = String(sub.min);
      if (sub.max !== undefined) input.max = String(sub.max);
      input.value = curObj[sub.key] === undefined || curObj[sub.key] === null ? '' : String(curObj[sub.key]);
      input.addEventListener('input', () => {
        const v = input.value.trim();
        if (v === '') delete draftObj[sub.key];
        else draftObj[sub.key] = Number(v);
        onInput({ ...draftObj });
      });
      wrap.appendChild(
        el('div', { class: 'keyed-row' }, [
          el('label', {}, [el('span', { text: sub.label }), sub.desc ? el('span', { class: 'desc', text: sub.desc }) : null]),
          input,
        ]),
      );
    }
    return wrap;
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
// 通用：字符串列表编辑器（增/删/改行）
//
// 用在动画池的简单数组上（idle / turn / drag / clicks / events.*），
// 以及分类里的 actions。每一项就是一个动画名。
// ---------------------------------------------------------------------------
function buildStringListEditor(list, onInput, opts = {}) {
  let draft = Array.isArray(list) ? [...list] : [];
  const wrap = el('div', { class: 'slist' });
  const min = opts.min ?? 0;

  const rerender = () => {
    wrap.textContent = '';
    if (draft.length === 0) {
      wrap.appendChild(el('p', { class: 'loading', text: opts.emptyHint ?? '（空）' }));
    }
    draft.forEach((item, i) => {
      const input = el('input', { type: 'text', class: 'slist-item' });
      input.value = item;
      input.placeholder = opts.placeholder ?? '动画名（照抄 assets 里的文件名，不含扩展名）';
      const del = el('button', { type: 'button', class: 'btn memes-del', text: '删除' });
      input.addEventListener('input', () => {
        draft[i] = input.value.trim();
        onInput([...draft]);
      });
      del.addEventListener('click', () => {
        // ⚠️ 有些池不允许为空（events.* 的校验要求每个池非空），
        //    所以设了 min 时拒绝删到低于下限，并明确提示原因。
        if (draft.length <= min) {
          opts.onReject?.(`这一类至少要保留 ${min} 项（宿主校验要求非空）`);
          return;
        }
        draft.splice(i, 1);
        onInput([...draft]);
        rerender();
      });
      wrap.appendChild(el('div', { class: 'slist-row' }, [input, del]));
    });
    const add = el('button', { type: 'button', class: 'btn', text: '＋ 添加' });
    add.addEventListener('click', () => {
      draft.push('');
      onInput([...draft]);
      rerender();
    });
    wrap.appendChild(add);
  };

  rerender();
  return wrap;
}

// ---------------------------------------------------------------------------
// 动画池编辑
//
// 结构（来自内置默认 assets/config.jsonc）：
//   idle / turn / drag / clicks : 字符串数组
//   moves  : { default:{minDist,maxDist,margin,leadSec,tailSec}, actions:[{name,params?}] }
//   categories : [{ id, weight, noMirror?, actions:[名字] }]
//   events : { balance:[...], whisper:[...], workStatus:[...] }（每池**非空**）
//
// ⚠️ 宿主校验 animationsValid 要求**整个结构都完整**：
//    四个数组必须在、moves.default 与 moves.actions 必须在、categories 必须是数组、
//    events 每个池必须**非空且成员非空串**。
//    缺任何一项 → topFieldValid 判非法 → 退回内置默认（"磁盘写了、响应是默认值"）。
//    所以这里只在**已有结构上改**，绝不构造残缺对象：
//      · 简单数组（4 个 + events 3 个 + 分类的 actions）→ 可增删改
//      · moves / 分类的 id 与 weight → 只读展示（结构与语义复杂，改错会静默回退）
//    提交时把改动合并回**原对象**，保证上面那些必需键一个都不少。
// ---------------------------------------------------------------------------
const ANIM_SIMPLE_KEYS = ['idle', 'turn', 'drag', 'clicks'];
const ANIM_EVENT_KEYS = [
  { key: 'balance', label: '余额档位（6 档：钱袋满溢 → 分文不剩）' },
  { key: 'whisper', label: '碎碎念动画池' },
  { key: 'workStatus', label: '工作状态档位（思考/忙碌/归档/踱步/庆祝/叹气）' },
];

function buildAnimationsEditor(animations, onInput, notify) {
  const wrap = el('div', { class: 'anim' });
  const cur = animations && typeof animations === 'object' && !Array.isArray(animations) ? animations : null;
  if (!cur) {
    wrap.appendChild(el('p', { class: 'loading', text: '当前没有动画配置（读不到内置默认？）—— 本编辑器只在已有结构上修改。' }));
    return wrap;
  }
  // 每次提交都基于**最新草稿**合并，避免相互覆盖
  let draft = JSON.parse(JSON.stringify(cur));
  const emit = () => onInput(JSON.parse(JSON.stringify(draft)));

  const section = (title, hint, node) => {
    const box = el('div', { class: 'anim-sec' }, [el('h3', { text: title })]);
    if (hint) box.appendChild(el('p', { class: 'hint', text: hint }));
    box.appendChild(node);
    return box;
  };

  // 1) 四个简单数组
  for (const k of ANIM_SIMPLE_KEYS) {
    if (!Array.isArray(draft[k])) continue;
    wrap.appendChild(
      section(
        `${k}（${draft[k].length} 项）`,
        k === 'clicks' ? '点击宠物时随机抽一个' : k === 'idle' ? '待机时循环的动画' : '对应动作的动画',
        buildStringListEditor(draft[k], (v) => {
          draft[k] = v;
          emit();
        }),
      ),
    );
  }

  // 2) events 三个池（每池非空 —— 宿主校验要求）
  if (draft.events && typeof draft.events === 'object') {
    for (const { key, label } of ANIM_EVENT_KEYS) {
      const pool = draft.events[key];
      if (!Array.isArray(pool)) continue;
      wrap.appendChild(
        section(
          `${label}（${pool.length} 项）`,
          '槽位可以是单个动画名，也可以是数组（同档位内随机抽一个）—— 本编辑器按单名处理，数组槽位原样保留不在这里改。',
          buildStringListEditor(
            pool.map((slot) => (Array.isArray(slot) ? slot.join(' | ') : slot)),
            (v) => {
              // 原样保留数组槽位：只有在项数不变时按位置回写，否则整体替换为字符串
              const sameLen = v.length === pool.length;
              draft.events[key] = sameLen
                ? v.map((name, i) => (Array.isArray(pool[i]) && name.includes(' | ') ? name.split(' | ').map((s) => s.trim()) : name))
                : v;
              emit();
            },
            {
              min: 1,
              onReject: (msg) => notify(msg),
            },
          ),
        ),
      );
    }
  }

  // 3) 分类（id / weight / noMirror / actions 全可改；宿主只校验 categories 是数组）
  //    三个字段都被真正消费：weight 参与加权抽取（pickWeightedCategory）、
  //    noMirror 在朝右时被排除（避免文字镜像）、id 是分类名（也用于菜单树）、
  //    actions 是该类下的动画清单。
  if (Array.isArray(draft.categories)) {
    const catWrap = el('div', { class: 'anim-cats' });

    const rerenderCats = () => {
      catWrap.textContent = '';
      draft.categories.forEach((cat, idx) => {
        const idInput = el('input', { type: 'text', class: 'anim-cat-idin' });
        idInput.value = String(cat.id ?? '');
        idInput.placeholder = '分类名';
        idInput.addEventListener('input', () => {
          draft.categories[idx].id = idInput.value;
          emit();
        });

        const wInput = el('input', { type: 'number', min: 0, max: 1000, class: 'anim-cat-w' });
        wInput.value = String(cat.weight ?? 0);
        wInput.addEventListener('input', () => {
          const v = Number(wInput.value);
          if (Number.isFinite(v) && v >= 0) {
            draft.categories[idx].weight = v;
            emit();
          }
        });

        const nm = el('input', { type: 'checkbox' });
        nm.checked = cat.noMirror === true;
        nm.addEventListener('change', () => {
          if (nm.checked) draft.categories[idx].noMirror = true;
          else delete draft.categories[idx].noMirror;
          emit();
        });

        const del = el('button', { type: 'button', class: 'btn memes-del', text: '删除此类' });
        del.addEventListener('click', () => {
          draft.categories.splice(idx, 1);
          emit();
          rerenderCats();
        });

        catWrap.appendChild(
          el('div', { class: 'anim-cat-head' }, [
            idInput,
            el('span', { class: 'desc', text: '权重' }),
            wInput,
            el('label', { class: 'anim-cat-nm' }, [nm, el('span', { text: '文字类（不镜像）' })]),
            del,
          ]),
        );
        catWrap.appendChild(
          buildStringListEditor(cat.actions ?? [], (v) => {
            draft.categories[idx].actions = v;
            emit();
          }),
        );
      });

      const addCat = el('button', { type: 'button', class: 'btn', text: '＋ 添加分类' });
      addCat.addEventListener('click', () => {
        draft.categories.push({ id: `新分类${draft.categories.length + 1}`, weight: 10, actions: [] });
        emit();
        rerenderCats();
      });
      catWrap.appendChild(addCat);
    };

    rerenderCats();
    wrap.appendChild(
      section(
        `分类（${draft.categories.length} 类）`,
        '空闲时按权重挑一个分类再从中抽动画；文字类勾上"不镜像"可避免朝右时文字反了。',
        catWrap,
      ),
    );
  }

  // 4) moves：默认移动参数 + 每个动作（可选覆盖参数）
  //    消费点：motion.ts 用 minDist/maxDist 抽移动距离、leadSec/tailSec 是前后段时长；
  //    客户端 `Object.assign({}, moves.default, chosen.params || {})` —— 每个动作的
  //    params 是**可选覆盖**，未写的键取 default。
  if (draft.moves && typeof draft.moves === 'object') {
    const MV_KEYS = [
      { key: 'minDist', label: '最小距离', min: 0, max: 5000 },
      { key: 'maxDist', label: '最大距离', min: 0, max: 5000 },
      { key: 'margin', label: '边距', min: 0, max: 1000 },
      { key: 'leadSec', label: '前段时长(秒)', min: 0, max: 60, step: 0.05 },
      { key: 'tailSec', label: '后段时长(秒)', min: 0, max: 60, step: 0.05 },
    ];
    const mvWrap = el('div', { class: 'moves' });

    const rerenderMoves = () => {
      mvWrap.textContent = '';

      // 4a) default
      const def = draft.moves.default && typeof draft.moves.default === 'object' ? draft.moves.default : {};
      draft.moves.default = def;
      const defGrid = el('div', { class: 'moves-grid' });
      for (const k of MV_KEYS) {
        const input = el('input', { type: 'number', min: k.min, max: k.max, step: k.step ?? 1 });
        input.value = def[k.key] === undefined || def[k.key] === null ? '' : String(def[k.key]);
        input.addEventListener('input', () => {
          const v = input.value.trim();
          if (v === '') delete def[k.key];
          else {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) def[k.key] = n;
          }
          emit();
        });
        defGrid.appendChild(
          el('label', { class: 'moves-cell' }, [el('span', { text: k.label }), input]),
        );
      }
      mvWrap.appendChild(el('div', { class: 'moves-sec' }, [el('h4', { text: '默认参数（所有移动动画共用）' }), defGrid]));

      // 4b) actions（每个动作名 + 可选覆盖）
      if (!Array.isArray(draft.moves.actions)) draft.moves.actions = [];
      const acts = draft.moves.actions;
      const actBox = el('div', { class: 'moves-acts' });
      acts.forEach((act, i) => {
        const nameInput = el('input', { type: 'text', class: 'moves-name' });
        nameInput.value = String(act.name ?? '');
        nameInput.placeholder = '移动动画名（照抄 assets 文件名）';
        nameInput.addEventListener('input', () => {
          acts[i].name = nameInput.value.trim();
          emit();
        });

        const ovBox = el('div', { class: 'moves-ov' });
        for (const k of MV_KEYS) {
          const has = act.params && Object.prototype.hasOwnProperty.call(act.params, k.key);
          const cb = el('input', { type: 'checkbox', title: `覆盖 ${k.label}` });
          cb.checked = !!has;
          const input = el('input', { type: 'number', min: k.min, max: k.max, step: k.step ?? 1 });
          input.value = has ? String(act.params[k.key]) : '';
          input.disabled = !has;
          input.placeholder = '默认';
          cb.addEventListener('change', () => {
            if (cb.checked) {
              acts[i].params = { ...(acts[i].params ?? {}), [k.key]: acts[i].params?.[k.key] ?? draft.moves.default?.[k.key] ?? 0 };
            } else if (acts[i].params) {
              delete acts[i].params[k.key];
              // 覆盖全空则删掉 params 字段本身，保持与内置默认同形
              if (Object.keys(acts[i].params).length === 0) delete acts[i].params;
            }
            emit();
            rerenderMoves();
          });
          input.addEventListener('input', () => {
            const v = Number(input.value);
            if (Number.isFinite(v) && v >= 0) {
              acts[i].params = { ...(acts[i].params ?? {}), [k.key]: v };
              emit();
            }
          });
          ovBox.appendChild(el('label', { class: 'moves-ov-cell', title: `覆盖 ${k.label}` }, [cb, input]));
        }

        const del = el('button', { type: 'button', class: 'btn memes-del', text: '删除' });
        del.addEventListener('click', () => {
          acts.splice(i, 1);
          emit();
          rerenderMoves();
        });

        actBox.appendChild(el('div', { class: 'moves-act' }, [nameInput, ovBox, del]));
      });

      const addAct = el('button', { type: 'button', class: 'btn', text: '＋ 添加移动动作' });
      addAct.addEventListener('click', () => {
        acts.push({ name: '' });
        emit();
        rerenderMoves();
      });
      actBox.appendChild(addAct);
      mvWrap.appendChild(
        el('div', { class: 'moves-sec' }, [el('h4', { text: `移动动作（${acts.length} 个）` }), actBox]),
      );
    };

    rerenderMoves();
    wrap.appendChild(
      section(
        '移动参数',
        'default 是所有移动动画共用的参数；每个动作可勾选若干项做覆盖（未勾的取 default）。' +
          '左侧勾选框表示"该动作覆盖这一项"。',
        mvWrap,
      ),
    );
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// 表情包池编辑（键 = assets/memes/<键>.png 的文件名，值 = 该图的内容描述）
//
// 为什么单独做一个编辑器而不是塞进 buildRow：
//   这是**键值对集合**，不是单个字段 —— 需要增/删行。
//   键必须与已安装 dsh-pet 的 assets/memes/ 下的文件名一致，所以这里
//   明确提示"键要照抄文件名"，并列出当前池里已有的键（无法读到文件名列表，
//   因为素材不在本仓库，浏览器端也没有目录浏览接口）。
// ---------------------------------------------------------------------------
function buildMemesEditor(memes, onInput) {
  // memes 可能是空对象（= 清空池）；此时从零开始
  let draft = { ...(memes && typeof memes === 'object' && !Array.isArray(memes) ? memes : {}) };
  const wrap = el('div', { class: 'memes' });

  const rerender = () => {
    wrap.textContent = '';
    const keys = Object.keys(draft);
    const list = el('div', { class: 'memes-list' });
    if (keys.length === 0) {
      list.appendChild(el('p', { class: 'loading', text: '当前表情包池为空。添加一条后，碎碎念/对话配图就会从中挑选。' }));
    }
    for (const k of keys) {
      const keyInput = el('input', { type: 'text', class: 'memes-key' });
      keyInput.value = k;
      keyInput.placeholder = '键（照抄 assets/memes 下的文件名，不含 .png）';
      const valInput = el('input', { type: 'text', class: 'memes-val' });
      valInput.value = draft[k];
      valInput.placeholder = '描述（给模型看的：这张图适合什么语境）';
      const del = el('button', { type: 'button', class: 'btn memes-del', text: '删除' });
      const row = el('div', { class: 'memes-row' }, [keyInput, valInput, del]);

      keyInput.addEventListener('input', () => {
        const nk = keyInput.value.trim();
        if (!nk || nk === k) return;
        // 重命名：保持插入顺序不被破坏（用新对象重建）
        const next = {};
        for (const kk of Object.keys(draft)) next[kk === k ? nk : kk] = draft[kk];
        draft = next;
        onInput({ ...draft });
        rerender(); // 因键变了需要重画
      });
      valInput.addEventListener('input', () => {
        draft[k] = valInput.value;
        onInput({ ...draft });
      });
      del.addEventListener('click', () => {
        delete draft[k];
        onInput({ ...draft });
        rerender();
      });
      list.appendChild(row);
    }
    wrap.appendChild(list);

    const add = el('button', { type: 'button', class: 'btn', text: '＋ 添加一条' });
    add.addEventListener('click', () => {
      let n = 1;
      while (Object.prototype.hasOwnProperty.call(draft, `新表情${n}`)) n += 1;
      draft[`新表情${n}`] = '';
      onInput({ ...draft });
      rerender();
    });
    wrap.appendChild(add);
  };

  rerender();
  return wrap;
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

  // 3b) 物理引擎（6 个键；任何一项改动都整对象提交）
  const phyCur = cfg.physics && typeof cfg.physics === 'object' ? cfg.physics : {};
  const phyRows = PHYSICS_FIELDS.map((f) =>
    buildRow(f, phyCur[f.key], (v) => {
      patch.physics = { ...(patch.physics ?? phyCur), [f.key]: v };
      markDirty();
    }),
  );
  root.appendChild(
    buildCard('物理引擎', '拖拽甩出、落地弹跳等手感；改完保存即生效（桌面端下次拉起时套用）', phyRows),
  );

  // 3c) 动画随机链权重（3 个非负整数）
  const awCur = cfg.animationWeights && typeof cfg.animationWeights === 'object' ? cfg.animationWeights : {};
  const awRows = WEIGHT_FIELDS.map((f) =>
    buildRow(f, awCur[f.key], (v) => {
      patch.animationWeights = { ...(patch.animationWeights ?? awCur), [f.key]: v };
      markDirty();
    }),
  );
  root.appendChild(
    buildCard('动画随机链权重', '宠物空闲时按权重挑下一个动画；设为 0 即让该类别不再被挑中', awRows),
  );

  // 3d) 动画池（在已有结构上改；宿主校验要求整个结构完整，所以只合并不重建）
  const animEditor = buildAnimationsEditor(cfg.animations, (v) => {
    patch.animations = v;
    markDirty();
  }, (msg) => setStatus(msg, 'err'));
  root.appendChild(
    buildCard(
      '动画池',
      '空闲时按分类权重挑动画；这里可增删各档位的动画名。' +
        '⚠️ 动画名必须与已安装 dsh-pet 的 assets 里对应文件同名，写错只会在播放时静默跳过。',
      [animEditor],
    ),
  );

  // 3e) 表情包池（键值对集合，可增删）
  const memesCur = cfg.memes && typeof cfg.memes === 'object' && !Array.isArray(cfg.memes) ? cfg.memes : {};
  const memesEditor = buildMemesEditor(memesCur, (v) => {
    // ⚠️ 每次都整对象提交：宿主按对象校验（键不能含分隔符等）。
    patch.memes = v;
    markDirty();
  });
  const memesCount = Object.keys(memesCur).length;
  root.appendChild(
    buildCard(
      `表情包池（${memesCount} 条）`,
      '键必须与已安装 dsh-pet 的 assets/memes/<键>.png 文件名一致；' +
        '值是给模型看的描述，碎碎念与对话配图都从这里挑。改完保存即生效。',
      [memesEditor],
    ),
  );

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
