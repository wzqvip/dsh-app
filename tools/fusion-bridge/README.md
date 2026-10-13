# FusionBridge —— 让外部进程（和 agent）驱动 Fusion 360 建模

Fusion 360 有一套完整的 Python API，但它**没有 COM / 命令行 / HTTP 之类的对外口子**：
`adsk` 模块是 Fusion 在自己的进程里注入的，外部 `python.exe` 里 `import adsk.core` 不存在。

所以唯一的办法是**住进去**：装一个常驻附加模块（add-in）在 Fusion 进程内开一个本地
socket，外部通过它提交 Python 代码，由 add-in 转到 Fusion 主线程执行。

```
外部进程 / agent ──TCP(127.0.0.1, 逐行 JSON)──> Fusion 内的常驻 add-in
                                                    │ 放进队列 + fireCustomEvent
                                                    ▼
                                          主线程 CustomEventHandler
                                          （只有这里能碰 Fusion API）
                                                    │ 结果回填 holder
                                                    ▼
                                          唤醒 socket 线程 → 回包
```

## 为什么必须这么绕

Fusion 的 API **只能在主线程调用**。从工作线程碰它不是抛异常，而是**整个 Fusion 进程直接消失**
——`try/except` 抓不住，日志也没有。而 socket 服务必须跑在后台线程，否则一 `accept`
界面就卡死。两者之间唯一官方支持的通道是 `CustomEvent`：

> `CustomEventArgs.additionalInfo` — *Information being passed to the add-in in the primary
> thread **from the worker thread** or other add-in.*

## 安装

```powershell
# 只装 add-in
powershell -ExecutionPolicy Bypass -File tools\fusion-bridge\install-addin.ps1

# 连诊断探针一起装（排错时用）
powershell -ExecutionPolicy Bypass -File tools\fusion-bridge\install-addin.ps1 -Probe

# 卸载
powershell -ExecutionPolicy Bypass -File tools\fusion-bridge\install-addin.ps1 -Uninstall -Probe
```

装完在 Fusion 里：**实用工具 → 脚本和附加模块（Shift+S）→ 附加模块 → 选中 `FusionBridge`
→ 运行**，并勾上 **Run on Startup**，以后随 Fusion 自动启动。

⚠️ 这一步**必须手动点一次**：Fusion 不允许外部进程往里注入脚本。

## 用法

```powershell
$py = "C:\Python314\python.exe"      # 本机 Python，随便哪个 3.8+
$c  = "tools\fusion-bridge\bridge_client.py"

& $py $c ping                        # 桥还活着吗（不碰 Fusion API，主线程卡住也能答）
& $py $c info                        # Fusion 版本 / 当前文档 / 实体数 / 参数数
& $py $c exec --file part.py         # 跑一段建模代码
& $py $c exec --code "print(app.version)"
& $py $c eval --expr "dir(core.Viewport)"          # 探索 API，比盲写代码靠谱
& $py $c screenshot --path out.png --fit           # 截当前视口
```

`exec` 的返回里 `stdout` / `stderr` / `result`（代码里给 `result` 赋值就会带回来）/
`error`（完整 traceback）都在。脚本要跨多次调用保留状态就加 `--session <名字>`。

### 注入的执行环境

| 名字 | 含义 |
|---|---|
| `app` / `ui` | `Application` / `UserInterface` |
| `adsk` / `core` / `fusion` / `cam` | 模块 |
| `design` / `root` | 当前设计的 activeProduct / rootComponent（没有设计时为 `None`） |
| `mm(v)` | 毫米 → 内部单位 |
| `deg(v)` | 角度 → 弧度 |
| `vi(x)` / `mmi(v)` | 造 `ValueInput`（字符串走表达式，如 `vi('25 mm')`） |
| `emit(x)` | 等价于给 `result` 赋值 |
| `dump(x)` / `jsonable(x)` | 转成可 JSON 序列化的东西 |

### ⚠️ 单位：内部一律 cm 和弧度

**API 收的是 cm，不是 mm**，而且**写错不会报错，只会默默做出大 10 倍的模型**。
所以别把裸数字喂给 API，一律走 `mm()` / `deg()`：

```python
# 100 mm 的拉伸
extrude.distance = mmi(100)          # 不是 createByReal(100)
```

## 已知坑（都是实测踩过的）

### 1. `fireCustomEvent` 的返回值不可信 —— 这是本项目最大的坑

在 Fusion **2704.1.53** 上实测（3 个 event id × 5 种调用写法，共 15 次采样）：

```
fire(event_id)                        -> False    [notify] handler ran
fire(event_id, "")                    -> False    [notify] handler ran
fire(event_id, '{"n":1}')             -> False    [notify] handler ran
fire(event.eventId, "")               -> False    [notify] handler ran
工作线程 fire                          -> False    [notify] handler ran
```

**每一次都返回 `False`，但每一次 handler 都确实执行了**，`additionalInfo` 也原样送达。
`unregisterCustomEvent` 同样是噪声（对**从未注册过**的 id 也返回 `True`）。

→ **绝不能用返回值判断成败**，只能看「handler 有没有把结果回填」。
（v0.1.0/0.1.1 就是因为信了这个 `False`、直接中止请求，导致 100% 失败。
诊断脚本见 [`diag/FusionBridgeProbe`](diag/FusionBridgeProbe)，日志
`%LOCALAPPDATA%\FusionBridge\probe.log`。）

同样的道理，`Viewport.saveAsImageFile` 的 bool 也不作判据 —— 以文件真的写出来为准。

### 2. handler 必须被全局引用住

`event.add(handler)` 之后如果 handler 只有局部引用，它会被 GC 掉；之后事件照发不误，
但**什么都不会发生，且没有任何报错**。Fusion API 事件处理里最著名的陷阱。
本项目用模块级 `_handlers` 列表钉住。

### 3. 事件可能被合并

一次 `fire` 不保证对应一次 `notify`。所以 `notify` 里要把队列**排空**
（`_drain_pending`），而不是只处理一条。

### 4. 模态对话框会让主线程停摆

`ui.messageBox()` 这类调用会阻塞主线程 → 队列不流动 → 请求一直等到超时。
调试信息请写文件或塞进返回值，**不要用弹窗**。

### 5. Fusion 必须登录、必须开着 GUI

它是云优先产品，未登录会卡在启动阶段等浏览器认证。**不适合无人值守**，
定位是「在有人登录的工作机上把操作自动化」。

## 安全边界

- 只 bind `127.0.0.1`（写死，不可配），局域网访问不到
- 每次启动生成随机 token，写在 `%LOCALAPPDATA%\FusionBridge\status.json`，请求必须带上
- `exec` 能在你的机器上执行任意 Python —— 这是它的**功能**，不是缺陷。
  真正的边界是「本机同用户进程本来就能为所欲为」，token 只是防止盲目连接
- 破坏性操作（覆盖保存、删特征、CAM 后处理）本项目**不自动执行**，由调用方自行克制

## 文件与状态

| 路径 | 作用 |
|---|---|
| `addin/FusionBridge/` | Fusion 侧源码（装到 `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\`） |
| `bridge_client.py` | 命令行客户端 |
| `diag/FusionBridgeProbe/` | 只做诊断的独立 add-in |
| `install-addin.ps1` | 安装/卸载（ASCII-only + 过 5.1 解析器自检，见 AGENTS.md §2.1） |
| `%LOCALAPPDATA%\FusionBridge\status.json` | 端口 / token / pid（客户端据此自动发现） |
| `%LOCALAPPDATA%\FusionBridge\bridge.log` | add-in 日志 |

端口默认 `47800`，被占用时自动往后试到 `47809`；客户端读 `status.json` 取实际端口。

## 排错

```powershell
# 1. 桥活着吗（这一步不碰 Fusion API）
python bridge_client.py ping

# 2. Fusion 忙还是桥死了？
#    ping 通但 info/exec 超时 → 主线程卡住（多半是模态对话框）

# 3. 看 add-in 日志
Get-Content "$env:LOCALAPPDATA\FusionBridge\bridge.log" -Tail 40

# 4. 还不行就跑诊断探针
powershell -ExecutionPolicy Bypass -File install-addin.ps1 -Probe
#    然后在 Fusion 附加模块里运行 FusionBridgeProbe，看 probe.log
```
