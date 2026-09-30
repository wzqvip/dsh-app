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

/** 把 scheme 请求转成"类 fetch"的返回，供页面用 */
async function bridgeRequest(path, init) {
  const url = 'dsh-pet-bridge://host' + path;
  const method = (init && init.method) || 'GET';
  const body = init && init.body !== undefined ? String(init.body) : undefined;
  const res = await fetch(url, {
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
    return bridgeRequest('/dsh-pet-7340/config', { method: 'GET' });
  },
  /** 写配置（走宿主白名单校验） */
  putConfig(patch) {
    return bridgeRequest('/dsh-pet-7340/config', { method: 'PUT', body: JSON.stringify(patch) });
  },
  /** 设置窗口自己的窗口控制（关窗/最小化），避免把整个 ipcRenderer 交出去 */
  close() {
    ipcRenderer.send('pet:settings-close');
  },
});
