// [dsh-app] 设置窗口的 preload 桥。
//
// 为什么单独一份、而不是复用宠物窗口的 preload：
//   宠物窗口的 preload 只暴露"窗口控制原语"（逐帧跟随、穿透、碰撞），
//   设置窗口一个都不需要；它需要的是"读配置 / 写配置"。
//   混在一起会让两边都带上对方的能力，没必要。
//
// 数据通道：dsh-pet-bridge:// scheme。
//   主进程已注册该 scheme，protocol.handle 收到后经 stdin/stdout 管道转给宿主，
//   宿主用与 HTTP 路由【同一份】handlePetRoute 处理 —— 所以这里能直接用
//   /dsh-pet-7340/config 的 GET/PUT，不需要知道宿主端口，也不需要 token。
//   这与宠物渲染层取素材走的是同一条路，行为天然一致。
const { contextBridge, ipcRenderer } = require('electron');

// 数据通道有两条，按运行模式自动选：
//   ① bridge（DSH_PET_BRIDGE=1，宿主托管时的正常路径）
//      走 dsh-pet-bridge:// scheme：主进程已注册，protocol.handle 收到后经
//      stdin/stdout 管道转给宿主，宿主用与 HTTP 路由【同一份】handlePetRoute
//      处理。好处：不需要知道宿主端口、不需要 token。
//   ② 直接 HTTP（手动 start-desktop / 开发流，没有宿主管道对端）
//      用主进程注入的 DSH_PET_CONFIG_URL（已含令牌）当基址。
//
// ⚠️ 为什么必须有 ②：只走 ① 时，一旦没有宿主管道对端，
//    fetch 会直接 "Failed to fetch"，设置窗口变成一片空白 —— 实测踩过。
//    上游宠物渲染层同样有这两条路径。
const BRIDGE = process.env.DSH_PET_BRIDGE === '1';
/** ②的基址：形如 http://127.0.0.1:3097/dsh-pet-7340/config?token=xxx */
const CONFIG_URL = process.env.DSH_PET_CONFIG_URL || '';

/** 把配置请求映射到当前模式下的真实 URL */
function endpoint() {
  if (BRIDGE) return 'dsh-pet-bridge://host/dsh-pet-7340/config';
  if (CONFIG_URL) return CONFIG_URL;
  return 'dsh-pet-bridge://host/dsh-pet-7340/config'; // 都没有时仍试 bridge（保底）
}

/** 把请求转成"类 fetch"的返回，供页面用 */
async function bridgeRequest(method, body) {
  const res = await fetch(endpoint(), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON：保持 null，让调用方看到原始文本 */
  }
  return { ok: res.ok, status: res.status, text, json };
}

contextBridge.exposeInMainWorld('settingsBridge', {
  /** 读合并后的宠物配置 */
  getConfig() {
    return bridgeRequest('GET');
  },
  /** 写配置（走宿主白名单校验） */
  putConfig(patch) {
    return bridgeRequest('PUT', JSON.stringify(patch));
  },
  /** 当前数据通道（诊断用） */
  transport() {
    return BRIDGE ? 'bridge' : CONFIG_URL ? 'http' : 'none';
  },
  /** 设置窗口自己的窗口控制（关窗/最小化），避免把整个 ipcRenderer 交出去 */
  close() {
    ipcRenderer.send('pet:settings-close');
  },
});
