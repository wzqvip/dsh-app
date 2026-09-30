/**
 * 配置写入契约测试（host 半侧，不开网络）。
 *
 * 为什么必须有这一道：
 *   设置 GUI 最大的风险不是渲染错，而是**保存后值没变却显示成功**。
 *   上游原先只白名单 pets + 三个全局开关，PUT 里带别的字段会返回 200
 *   但静默丢弃 —— 实测踩过。我们扩大了白名单，就必须锁住这个契约，
 *   否则以后改 config.ts 很容易又退回静默丢弃。
 *
 * 做法：用 mock ctx 跑宿主插件拿到 /dsh-pet-7340 的路由处理器，
 * 直接喂 PUT 请求，读它写给 res 的内容做断言。全程不监听端口。
 *
 * 用法：node scripts/test-config-write.mjs
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const hostPath = join(pkgRoot, 'lib', 'index.js');

if (!existsSync(hostPath)) {
  console.error('[config-write] 找不到 lib/index.js —— 先跑构建');
  process.exit(1);
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};

// ⚠️ 配置读写落在 DSH_HOME 下。必须指向临时目录，绝不能碰真实 ~/.dsh
//    （曾经因为没隔离而险些改到用户配置）。
const home = mkdtempSync(join(tmpdir(), 'dsh-eff-cfg-'));
process.env.DSH_HOME = home;
// ⚠️ 必须阻止宿主去拉起/下载 Electron：本测试只关心配置读写，
//    而 apply() 会尝试启动桌面助手，找不到 Electron 就会真去下载
//    （实测：日志里出现 "downloading v43.3.0"）。
//    指向一个不存在的路径让它在拉起阶段快速失败即可。
delete process.env.DSH_PET_ELECTRON_DOWNLOAD;
process.env.DSH_PET_ELECTRON_PATH = join(home, 'no-such-electron.exe');
// 顺带关掉桌面模式相关副作用
process.env.DSH_PET_BRIDGE = '0';

/** 假的 res：把写出的内容收集起来 */
function makeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      return this;
    },
    write(buf) {
      chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
      return true;
    },
    end(buf) {
      if (buf !== undefined) this.write(buf);
      this.writableEnded = true;
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    body() {
      return Buffer.concat(chunks).toString('utf8');
    },
    json() {
      try {
        return JSON.parse(this.body());
      } catch {
        return null;
      }
    },
  };
}

/**
 * 假的 req。
 * ⚠️ 宿主的 readBody 用事件式收包（req.on('data')/on('end')），不是异步迭代。
 *    这里最省事且无时序问题的做法：**注册监听时立刻回调**。
 *    handler 一调 on('data') 就拿到 body、on('end') 立刻 resolve，
 *    既不用操心"先 emit 还是先注册"，也不会挂住。
 *    （踩过两种错法：只实现 asyncIterator → 永远不 resolve；
 *      在 handler 之前 emit → 事件没人听，同样挂住。）
 */
function makeReq(url, method, body) {
  const buf = body === undefined ? undefined : Buffer.from(body);
  return {
    url,
    method,
    headers: {},
    on(ev, fn) {
      if (ev === 'data' && buf !== undefined) queueMicrotask(() => fn(buf));
      else if (ev === 'end') queueMicrotask(() => fn());
      else if (ev === 'error') {
        /* 不触发 */
      }
      return this;
    },
  };
}

// ---- 跑宿主插件，拿到路由 ----
const routes = new Map();
const ctx = {
  effect(fn) {
    try {
      return fn() || (() => {});
    } catch {
      return () => {};
    }
  },
  on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    register(o) {
      routes.set(o.path, o.handler);
      return () => {};
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  credentials: {},
  llm: {},
  commands: { register: () => () => {} },
  userQuestions: { answer() {} },
};

const mod = await import(`${pathToFileURL(hostPath).href}?t=${Date.now()}`);
await mod.apply(ctx);

const handler = routes.get('/dsh-pet-7340');
if (!handler) {
  console.error('[config-write] 没拿到 /dsh-pet-7340 路由');
  process.exit(1);
}

const call = async (method, body) => {
  const res = makeRes();
  const req = makeReq('/dsh-pet-7340/config', method, body === undefined ? undefined : JSON.stringify(body));
  await handler(req, res);
  return res;
};

const PET = {
  id: 'main',
  name: '测试宠物',
  size: 462,
  balanceEnabled: true,
  display: 'desktop',
  position: { corner: 'top-right', marginX: 24, marginY: 100 },
};

try {
  console.log('[config-write] 1) 读初始配置');
  const get0 = await call('GET');
  check('GET 返回 200', get0.statusCode === 200, `实际 ${get0.statusCode}`);

  console.log('[config-write] 2) 写 pets（必填）');
  const w1 = await call('PUT', { pets: [PET] });
  check('PUT pets 成功', w1.statusCode === 200, `实际 ${w1.statusCode} ${w1.body().slice(0, 120)}`);

  console.log('[config-write] 3) 新增可写字段必须真的生效（不能静默丢弃）');
  const w2 = await call('PUT', { pets: [PET], whisperPrompt: 'CONTRACT-TEST', chatMemoryRounds: 7 });
  check('whisperPrompt + chatMemoryRounds 的 PUT 成功', w2.statusCode === 200, `实际 ${w2.statusCode}`);
  const after = w2.json();
  const bucket = after && typeof after === 'object' ? after[Object.keys(after)[0]] : null;
  check('whisperPrompt 已写入', bucket?.whisperPrompt === 'CONTRACT-TEST', `实际 ${JSON.stringify(bucket?.whisperPrompt)}`);
  check('chatMemoryRounds 已写入', bucket?.chatMemoryRounds === 7, `实际 ${JSON.stringify(bucket?.chatMemoryRounds)}`);

  console.log('[config-write] 4) 非法值必须显式拒绝（400），不静默');
  for (const [field, bad] of [
    ['chatMemoryRounds', 999],
    ['chatMemoryRounds', -1],
    // ⚠️ eventsRefreshSec 是**对象**（{balance,whisper}），不是整数。
    //    整数与未知键都必须被拒 —— 我最初按整数实现，被宿主合并器静默丢弃过。
    ['eventsRefreshSec', 0],
    ['eventsRefreshSec', { balance: 0 }],
    ['eventsRefreshSec', { 未知键: 100 }],
    ['whisperPrompt', 'x'.repeat(2001)],
    ['workStatusTexts', ['只有一个']],
    // 新增可写字段的非法值
    ['physics', { gravity: -5 }],
    ['physics', { 未知键: 1 }],
    ['animationWeights', { idle: -1 }],
    ['animationWeights', { 未知键: 1 }],
    // 对象的子键必须在范围内（restitution 只能 0..1）
    ['physics', { restitution: 2 }],
  ]) {
    const r = await call('PUT', { pets: [PET], [field]: bad });
    check(`${field} 非法值被拒`, r.statusCode === 400, `实际 ${r.statusCode} ← ${JSON.stringify(bad)}`);
  }

  console.log('[config-write] 5) 缺 pets 必须拒绝（宿主契约要求必填）');
  const r5 = await call('PUT', { whisperPrompt: 'no-pets' });
  check('缺 pets 被拒', r5.statusCode === 400, `实际 ${r5.statusCode}`);

  console.log('[config-write] 6) 未携带的顶层字段应被透传保留（不能抹掉用户手改）');
  const w6 = await call('PUT', {
    pets: [PET],
    eventsRefreshSec: { balance: 900 },
    // ⚠️ 必须提交**完整对象**：physics 的校验要求全 6 键、animationWeights 要求 3 键，
    //    部分对象会被判非法并退回内置默认（磁盘写了、响应却是默认值）。
    //    设置 GUI 正是从当前配置构造完整对象提交的，所以这里也照做。
    physics: { gravity: 1500, restitution: 0.78, groundFriction: 2.5, ceilingBounce: true, throwPower: 1, petCollision: false },
    animationWeights: { idle: 12, turn: 5, move: 5 },
  });
  check('新字段写入成功（eventsRefreshSec 对象 / physics / animationWeights）', w6.statusCode === 200, `实际 ${w6.statusCode}`);
  const b6 = w6.json();
  const bb = b6 && typeof b6 === 'object' ? b6[Object.keys(b6)[0]] : null;
  check('whisperPrompt 被保留（未在本次请求里）', bb?.whisperPrompt === 'CONTRACT-TEST', `实际 ${JSON.stringify(bb?.whisperPrompt)}`);
  check('eventsRefreshSec.balance 生效', bb?.eventsRefreshSec?.balance === 900, JSON.stringify(bb?.eventsRefreshSec));
  check('physics.gravity 生效', bb?.physics?.gravity === 1500, JSON.stringify(bb?.physics));
  check('animationWeights.idle 生效', bb?.animationWeights?.idle === 12, JSON.stringify(bb?.animationWeights));
  // 未携带的子键应保留内置默认（不因为我们只写了 balance 就把 whisper 抹掉）
  check('eventsRefreshSec.whisper 保留默认', typeof bb?.eventsRefreshSec?.whisper === 'number', JSON.stringify(bb?.eventsRefreshSec));

  console.log('[config-write] 7) 写盘确实落到 DSH_HOME 下（隔离确认）');
  const cfgFile = join(home, 'dsh-pet', 'main-config.json');
  check('配置文件写在临时 DSH_HOME 内', existsSync(cfgFile), cfgFile);
  if (existsSync(cfgFile)) {
    const raw = JSON.parse(readFileSync(cfgFile, 'utf8'));
    check(
      '磁盘上的值正确',
      raw.whisperPrompt === 'CONTRACT-TEST' &&
        raw.eventsRefreshSec?.balance === 900 &&
        raw.physics?.gravity === 1500 &&
        raw.animationWeights?.idle === 12,
      JSON.stringify({ er: raw.eventsRefreshSec, ph: raw.physics, aw: raw.animationWeights }),
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('');
if (failures === 0) {
  console.log('[config-write] PASS');
} else {
  console.log(`[config-write] FAIL: ${failures} 项未通过`);
  process.exit(1);
}
