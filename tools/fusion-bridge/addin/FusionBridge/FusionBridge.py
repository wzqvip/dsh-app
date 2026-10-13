# -*- coding: utf-8 -*-
"""FusionBridge —— 把 Fusion 360 的 Python API 暴露成一个本地 TCP 服务。

为什么要这么绕
--------------
Fusion 的 API **只能在主线程调用**。官方文档明确警告：从工作线程碰 API 不是抛异常，
而是**整个 Fusion 进程直接消失**（try/except 抓不住）。但 socket 服务必须跑在后台
线程，否则一 accept 就把界面卡死。

唯一的例外是 `Application.fireCustomEvent`。`CustomEventArgs.additionalInfo` 的
官方说明是「Information being passed to the add-in in the primary thread **from the
worker thread**」，即「后台线程触发 → 主线程处理」是被官方支持的模式。于是：

    客户端 → socket 线程 → 放进队列 → fireCustomEvent
          → 主线程 _RequestHandler.notify() → 真正调 Fusion API
          → 结果写回 holder → 唤醒 socket 线程 → 客户端

两个必须守住的坑（都是别人踩过、我们也不想再踩的）：

1. **handler 必须被全局引用住**，否则 GC 之后事件照发不误、但什么都不会发生，
   而且没有任何报错。
2. **事件可能被合并**，一次 notify 未必对应一次 fire，所以 notify 里要把队列排空。

协议
----
127.0.0.1 上的 TCP，**逐行 JSON**：客户端发一行请求，服务端回一行响应。
请求：{"id": ..., "op": "ping|status|exec|info|eval|screenshot", "token": "...", ...}
响应：{"id": ..., "ok": true/false, ...}

fireCustomEvent 的行为在不同 Fusion 版本上不完全一致（返回 False 的方式不止一种），
所以这里**不假定某一种写法是对的**：依次尝试多种 id/对象组合，记住第一个成功的，
详情写进 bridge.log。见 `_fire_request`。

这个文件被 Fusion 直接加载，**不要**引入第三方依赖。
"""

import contextlib
import io
import json
import math
import os
import queue
import socket
import threading
import time
import traceback

import adsk.core
import adsk.fusion

try:
    import adsk.cam
except Exception:  # cam 在某些安装里缺失，不该让整个 add-in 起不来
    adsk.cam = None


BRIDGE_VERSION = "0.1.2"
EVENT_ID = "FusionBridge.Request.v1"
HOST = "127.0.0.1"
DEFAULT_PORT = 47800
PORT_TRIES = 10
DEFAULT_TIMEOUT_S = 120.0
MAX_TIMEOUT_S = 3600.0
CONN_IDLE_TIMEOUT_S = 300.0

if os.name == "nt":
    _STATE_DIR = os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "FusionBridge"
    )
else:
    _STATE_DIR = os.path.join(os.path.expanduser("~"), ".fusion-bridge")
STATE_FILE = os.path.join(_STATE_DIR, "status.json")
LOG_FILE = os.path.join(_STATE_DIR, "bridge.log")
LOG_MAX_BYTES = 2 * 1024 * 1024


# --------------------------------------------------------------------------- #
# 全局状态
# --------------------------------------------------------------------------- #

_app = None
_handlers = []          # 必须留全局引用，否则 GC 后事件静默失效
_server = None
_custom_event = None
_pending = queue.Queue()   # socket 线程 → 主线程
_main_lock = threading.Lock()   # 同一时刻只允许一个请求在途

_state = {
    "started": time.time(),
    "token": None,
    "port": None,
    "served": 0,
    "last_error": None,
    "event_id": None,       # 注册后 Fusion 实际返回的 eventId
    "fire_report": None,    # 最近一次 fireCustomEvent 的返回记录（仅诊断，不作判据）
    "sessions": {},
}


def _ensure_dir():
    try:
        os.makedirs(_STATE_DIR, exist_ok=True)
    except Exception:
        pass


def _log(msg):
    line = "[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        _ensure_dir()
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_MAX_BYTES:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass


def _write_status():
    try:
        _ensure_dir()
        payload = {
            "bridgeVersion": BRIDGE_VERSION,
            "port": _state["port"],
            "token": _state["token"],
            "pid": os.getpid(),
            "startedAt": _state["started"],
            "host": HOST,
            "eventId": _state["event_id"] or EVENT_ID,
        }
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE_FILE)
    except Exception:
        _log("write_status failed: " + traceback.format_exc())


def _remove_status():
    try:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# JSON 安全化
# --------------------------------------------------------------------------- #

def jsonable(obj, depth=0):
    """把任意对象转成可 JSON 序列化的东西，且不把会话撑爆。"""
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return repr(obj)
        return obj
    if depth >= 8:
        return repr(obj)
    if isinstance(obj, dict):
        out = {}
        for i, (k, v) in enumerate(obj.items()):
            if i >= 500:
                out["__truncated__"] = len(obj) - 500
                break
            out[str(k)] = jsonable(v, depth + 1)
        return out
    if isinstance(obj, (list, tuple, set, frozenset)):
        items = list(obj)
        out = [jsonable(v, depth + 1) for v in items[:2000]]
        if len(items) > 2000:
            out.append("__truncated__:%d more" % (len(items) - 2000))
        return out
    # Fusion 的实体对象：给个可读且稳定的描述，比 SWIG 的 repr 有用得多
    object_type = getattr(obj, "objectType", None)
    if isinstance(object_type, str):
        info = {"objectType": object_type}
        for attr in ("name", "id", "isValid", "isParametric"):
            try:
                val = getattr(obj, attr, None)
                if val is not None:
                    info[attr] = jsonable(val, depth + 1)
            except Exception:
                pass
        return info
    return repr(obj)


# --------------------------------------------------------------------------- #
# 执行命名空间（只在主线程构造）
# --------------------------------------------------------------------------- #

def _to_value_input(value):
    """字符串走表达式（支持 '25 mm'），数字按 Fusion 内部单位（cm / 弧度）。"""
    if isinstance(value, str):
        return adsk.core.ValueInput.createByString(value)
    return adsk.core.ValueInput.createByReal(float(value))


def _standard_names():
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        design = adsk.fusion.Design.cast(app.activeProduct)
    except Exception:
        design = None

    ns = {}

    def emit(value):
        ns["result"] = value

    ns.update(
        {
            "adsk": adsk,
            "core": adsk.core,
            "fusion": adsk.fusion,
            "cam": getattr(adsk, "cam", None),
            "app": app,
            "ui": ui,
            "design": design,
            "root": design.rootComponent if design is not None else None,
            "result": None,
            "emit": emit,
            # 单位换算：Fusion 内部长度是 cm、角度是弧度，写错了不会报错，只会大 10 倍
            "mm": lambda v: v / 10.0,
            "cm": lambda v: float(v),
            "deg": math.radians,
            "rad": lambda v: float(v),
            "vi": _to_value_input,
            "mmi": lambda v: adsk.core.ValueInput.createByReal(v / 10.0),
            "jsonable": jsonable,
            "dump": jsonable,
        }
    )
    return ns


# --------------------------------------------------------------------------- #
# 各种 op 的实现（全部在主线程跑）
# --------------------------------------------------------------------------- #

def _op_exec(req):
    code = req.get("code") or ""
    if not isinstance(code, str):
        return {"ok": False, "error": "`code` must be a string"}

    session_key = req.get("session")
    if session_key:
        session_key = str(session_key)
        ns = _state["sessions"].setdefault(session_key, {})
        ns.update(_standard_names())
    else:
        ns = _standard_names()
    ns["result"] = None

    out, err = io.StringIO(), io.StringIO()
    ok, error = True, None
    started = time.time()
    try:
        compiled = compile(code, "<fusion-exec>", "exec")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compiled, ns, ns)
    except Exception:
        ok, error = False, traceback.format_exc()

    return {
        "ok": ok,
        "stdout": out.getvalue(),
        "stderr": err.getvalue(),
        "result": jsonable(ns.get("result")),
        "error": error,
        "elapsedSec": round(time.time() - started, 3),
        "session": session_key,
    }


def _describe(value):
    """枚举在 Python 绑定里经常就是 int，直接取 .name 会炸（这里踩过一次）。"""
    name = getattr(value, "name", None)
    if isinstance(name, str):
        return name
    return "value=%r" % (value,)


def _op_info(req):
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        design = adsk.fusion.Design.cast(app.activeProduct)
    except Exception:
        design = None

    info = {
        "fusionVersion": app.version,
        "isStartupComplete": app.isStartupComplete,
        "documentsOpen": app.documents.count,
        "activeDocument": app.activeDocument.name if app.activeDocument else None,
        "activeProductType": app.activeProduct.productType if app.activeProduct else None,
        "workspace": ui.activeWorkspace.name if ui.activeWorkspace else None,
        "hasDesign": design is not None,
        "bridge": {
            "version": BRIDGE_VERSION,
            "eventId": _state["event_id"],
            "fireReport": _state["fire_report"],
        },
    }
    if design is not None:
        # 逐项取值：某个属性在这个 Fusion 版本上改名/改类型，不该让整个 info 失败
        probes = {
            "designType": lambda: _describe(design.designType),
            "units": lambda: design.unitsManager.defaultLengthUnits,
            "rootName": lambda: design.rootComponent.name,
            "bodies": lambda: design.rootComponent.bRepBodies.count,
            "sketches": lambda: design.rootComponent.sketches.count,
            "components": lambda: design.rootComponent.occurrences.count,
            "features": lambda: design.rootComponent.features.count,
            "parameters": lambda: design.allParameters.count,
        }
        for key, probe in probes.items():
            try:
                info[key] = probe()
            except Exception as exc:
                info[key] = "<%s: %s>" % (type(exc).__name__, exc)
    return {"ok": True, "info": jsonable(info)}


def _op_screenshot(req):
    app = adsk.core.Application.get()
    path = req.get("path")
    if not path:
        return {"ok": False, "error": "`path` is required"}
    path = os.path.abspath(os.path.expanduser(path))
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    viewport = app.activeViewport
    if viewport is None:
        return {"ok": False, "error": "no active viewport (open a document first)"}
    try:
        if req.get("fit"):
            viewport.fit()
        adsk.doEvents()
        width = int(req.get("width") or 1600)
        height = int(req.get("height") or 1000)
        if os.path.exists(path):
            os.remove(path)
        returned = viewport.saveAsImageFile(path, width, height)
        # 同 fireCustomEvent：这个 bool 也不可信，以「文件真的写出来了」为准
        written = os.path.getsize(path) if os.path.exists(path) else 0
        return {
            "ok": written > 0,
            "path": path,
            "width": width,
            "height": height,
            "bytes": written,
            "returned": bool(returned),
            "error": None if written > 0 else "saveAsImageFile 没有生成文件（返回值 %r）" % returned,
        }
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


def _op_inspect(req):
    """对任意 Python 表达式求值，用于探索 API（比盲写代码靠谱）。"""
    expr = req.get("expr") or ""
    ns = _standard_names()
    text = repr(eval(compile(expr, "<fusion-eval>", "eval"), ns, ns))
    return {"ok": True, "expr": expr, "repr": text}


_MAIN_THREAD_OPS = {
    "exec": _op_exec,
    "eval": _op_inspect,
    "info": _op_info,
    "screenshot": _op_screenshot,
}


def _dispatch(req):
    op = str(req.get("op") or "exec").lower()
    handler = _MAIN_THREAD_OPS.get(op)
    if handler is None:
        return {"ok": False, "error": "unknown op %r (known: %s)"
                % (op, ", ".join(sorted(_MAIN_THREAD_OPS)))}
    try:
        return handler(req)
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


# --------------------------------------------------------------------------- #
# fireCustomEvent：不假定哪种写法对，逐个试
# --------------------------------------------------------------------------- #

def _fire_request():
    """把请求打给 Fusion 的事件队列。

    ⚠️ **绝不要相信 fireCustomEvent 的返回值。**

    实测 Fusion 2704.1.53（见 diag/FusionBridgeProbe 的 probe.log）：3 个 event id ×
    5 种调用写法，共 15 次采样，**每一次都返回 False，但每一次 handler 都确实执行了**，
    连 additionalInfo 都原样送达；从工作线程触发同样成功。`unregisterCustomEvent`
    也同样是噪声（对从未注册过的 id 也返回 True）。

    所以：成功与否只能由「主线程有没有把结果回填到 holder」来判断，返回值仅作诊断记录。
    （最初的版本把 False 当成失败并中止请求，于是每个请求都失败 —— 就是这个坑。）
    """
    event_id = _state.get("event_id") or EVENT_ID
    try:
        returned = _app.fireCustomEvent(event_id, "")
    except Exception:
        returned = "raised: " + traceback.format_exc().strip().splitlines()[-1]
        _log("fireCustomEvent raised:\n" + traceback.format_exc())
    _state["fire_report"] = (
        "fireCustomEvent(%r, '') -> %r  [返回值在该版本上不可信，仅记录]"
        % (event_id, returned)
    )


# --------------------------------------------------------------------------- #
# 主线程 handler
# --------------------------------------------------------------------------- #

def _drain_pending():
    """把队列排空。

    一次 notify 未必对应一次 fire（事件可能被合并），所以必须循环取干净；
    反过来一次 fire 也可能触发多次 notify（多候选写法），所以要用
    holder["res"] 判重，保证每个请求只执行一次。
    """
    while True:
        try:
            holder = _pending.get_nowait()
        except queue.Empty:
            return
        if holder.get("cancelled") or holder.get("res") is not None:
            continue
        try:
            holder["res"] = _dispatch(holder["req"])
        except Exception:
            holder["res"] = {"ok": False, "error": traceback.format_exc()}
        finally:
            holder["done"].set()


class _RequestHandler(adsk.core.CustomEventHandler):
    """Fusion 在主线程调用 notify()。这里**只做**转发和排空，不要塞业务逻辑。"""

    def notify(self, args):
        try:
            _drain_pending()
        except Exception:
            _log("notify failed: " + traceback.format_exc())


# --------------------------------------------------------------------------- #
# socket 服务（后台线程）
# --------------------------------------------------------------------------- #

def _run_on_main_thread(req, timeout_s):
    holder = {"req": req, "res": None, "done": threading.Event(), "cancelled": False}
    with _main_lock:
        _pending.put(holder)
        _fire_request()   # 打了就跑：返回值不可信，成功与否只看下面这个 wait
        if not holder["done"].wait(timeout_s):
            holder["cancelled"] = True
            _state["last_error"] = "timeout after %.1fs" % timeout_s
            return {
                "ok": False,
                "error": "等待主线程超时（%.1fs）。可能原因：Fusion 正卡在模态对话框、"
                         "上一次调用仍在执行，或自定义事件根本没送达。" % timeout_s,
                "fireReport": _state["fire_report"],
                "hint": "看 %s" % LOG_FILE,
            }
        return holder["res"] or {"ok": False, "error": "main thread produced no result"}


def _handle(req):
    rid = req.get("id")
    op = str(req.get("op") or "exec").lower()

    # ping 故意不碰 Fusion API：主线程卡住时它仍要能回答，用来区分
    # 「桥死了」和「Fusion 忙」。
    if op == "ping":
        return {
            "id": rid,
            "ok": True,
            "pong": True,
            "bridge": BRIDGE_VERSION,
            "pid": os.getpid(),
            "port": _state["port"],
            "uptimeSec": round(time.time() - _state["started"], 3),
            "served": _state["served"],
            "pendingInQueue": _pending.qsize(),
            "fireReport": _state["fire_report"],
            "lastError": _state["last_error"],
        }

    token = _state["token"]
    if token and req.get("token") != token:
        return {"id": rid, "ok": False, "error": "bad or missing token"}

    timeout_s = req.get("timeoutMs")
    try:
        timeout_s = float(timeout_s) / 1000.0 if timeout_s else DEFAULT_TIMEOUT_S
    except Exception:
        timeout_s = DEFAULT_TIMEOUT_S
    timeout_s = max(1.0, min(timeout_s, MAX_TIMEOUT_S))

    started = time.time()
    res = _run_on_main_thread(req, timeout_s)
    res["id"] = rid
    res["op"] = op
    res["roundTripSec"] = round(time.time() - started, 3)
    _state["served"] += 1
    return res


class _Server(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True, name="FusionBridgeServer")
        self.sock = None
        self._stop_flag = threading.Event()

    def _bind(self):
        last = None
        for port in range(DEFAULT_PORT, DEFAULT_PORT + PORT_TRIES):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            # 故意不设 SO_REUSEADDR：Windows 上它允许第二个进程抢同一端口，
            # 会让「到底谁在听这个端口」变得不确定。
            try:
                s.bind((HOST, port))
                s.listen(16)
                self.sock = s
                _state["port"] = port
                return True
            except OSError as exc:
                last = exc
                try:
                    s.close()
                except Exception:
                    pass
        _log("bind failed on %d..%d: %s"
             % (DEFAULT_PORT, DEFAULT_PORT + PORT_TRIES - 1, last))
        return False

    def run(self):
        if not self._bind():
            return
        _log("bridge listening on %s:%s" % (HOST, _state["port"]))
        _write_status()
        while not self._stop_flag.is_set():
            try:
                conn, _addr = self.sock.accept()
            except OSError:
                break
            threading.Thread(
                target=self._serve, args=(conn,), daemon=True,
                name="FusionBridgeConn",
            ).start()
        try:
            self.sock.close()
        except Exception:
            pass

    def _serve(self, conn):
        try:
            conn.settimeout(CONN_IDLE_TIMEOUT_S)
            stream = conn.makefile("rwb")
            while not self._stop_flag.is_set():
                try:
                    line = stream.readline()
                except (OSError, socket.timeout):
                    break
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line.decode("utf-8"))
                    if not isinstance(req, dict):
                        raise ValueError("request must be a JSON object")
                except Exception as exc:
                    resp = {"id": None, "ok": False, "error": "bad request: %s" % exc}
                else:
                    try:
                        resp = _handle(req)
                    except Exception:
                        resp = {"id": req.get("id"), "ok": False,
                                "error": traceback.format_exc()}
                try:
                    stream.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
                    stream.flush()
                except OSError:
                    break
        except Exception:
            _log("serve failed: " + traceback.format_exc())
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def stop(self):
        self._stop_flag.set()
        try:
            if self.sock is not None:
                self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# add-in 生命周期
# --------------------------------------------------------------------------- #

def run(context):
    global _app, _server, _custom_event

    app = adsk.core.Application.get()
    _app = app
    _state["served"] = 0
    _state["fire_report"] = None
    _state["last_error"] = None

    try:
        import secrets
        _state["token"] = secrets.token_hex(16)
    except Exception:
        _state["token"] = "%016x" % int(time.time() * 1000000)

    # eventId 必须唯一；热重载后可能残留旧注册，先清一次
    try:
        app.unregisterCustomEvent(EVENT_ID)
    except Exception:
        pass

    _custom_event = app.registerCustomEvent(EVENT_ID)
    if _custom_event is None:
        _log("FATAL: registerCustomEvent returned None for id %r" % EVENT_ID)
        return

    # Fusion 未必把传入的 id 原样还回来，以它返回的为准
    try:
        _state["event_id"] = _custom_event.eventId
    except Exception:
        _state["event_id"] = None
        _log("reading custom_event.eventId raised: " + traceback.format_exc())

    handler = _RequestHandler()
    added = False
    try:
        added = bool(_custom_event.add(handler))
    except Exception:
        _log("custom_event.add raised: " + traceback.format_exc())
    if not added:
        _log("FATAL: custom_event.add(handler) returned False")
        return
    _handlers.append(handler)   # ★ 没有这行，事件会静默失效

    # 注意：这里**不做**「主线程 fire 一次看返回值」的自检 —— 返回值在 2704.x 上
    # 恒为 False（见 _fire_request 的注释），拿它当健康检查只会误导人。

    _server = _Server()
    _server.start()

    for _ in range(50):   # 等 bind 完成，让 status.json 里的端口是准的
        if _state["port"] is not None:
            break
        time.sleep(0.02)

    summary = (
        "started: port=%s registeredId=%r literalId=%r addedHandler=%s"
        % (_state["port"], _state["event_id"], EVENT_ID, added)
    )
    _log(summary)
    try:
        app.log("FusionBridge " + summary)
    except Exception:
        pass
    try:
        if _state["port"]:
            app.userInterface.statusMessage = (
                "FusionBridge 已监听 %s:%s" % (HOST, _state["port"])
            )
    except Exception:
        pass


def stop(context):
    global _server, _custom_event

    if _custom_event is not None:
        for handler in _handlers:
            try:
                _custom_event.remove(handler)
            except Exception:
                pass
    _handlers.clear()
    try:
        if _app is not None:
            _app.unregisterCustomEvent(EVENT_ID)
    except Exception:
        pass
    _custom_event = None

    if _server is not None:
        _server.stop()
        _server = None

    while not _pending.empty():   # 让被取消的请求尽快返回，别卡住等待者
        try:
            holder = _pending.get_nowait()
        except queue.Empty:
            break
        holder["cancelled"] = True
        holder["done"].set()

    _state["port"] = None
    _state["sessions"].clear()
    _remove_status()
    _log("add-in stopped")
