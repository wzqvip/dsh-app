# -*- coding: utf-8 -*-
"""FusionBridgeProbe —— 单独验证 CustomEvent 到底为什么 fire 不成功。

这是一个 **Script**（不是 add-in）：在「脚本和附加模块 → 脚本」里选中它点运行。
它不依赖 socket，也不依赖 add-in，只做一件事：把 fireCustomEvent 的各种调用
组合逐个试一遍，把每一步的返回值和处理器的实际触发情况写进日志文件。

日志：%LOCALAPPDATA%\\FusionBridge\\probe.log
"""

import os
import threading
import time
import traceback

import adsk.core

_LOG_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "FusionBridge")
LOG_FILE = os.path.join(_LOG_DIR, "probe.log")

_hits = []


def _log(msg):
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(msg + "\n")
    except Exception:
        pass


class _ProbeHandler(adsk.core.CustomEventHandler):
    def notify(self, args):
        try:
            info = args.additionalInfo
        except Exception:
            info = "<raised>"
        _hits.append(info)
        _log("      [notify] handler ran, additionalInfo=%r" % (info,))


def _pump(rounds=4):
    """给 Fusion 机会去处理事件队列。"""
    for _ in range(rounds):
        try:
            adsk.doEvents()
        except Exception:
            pass
        time.sleep(0.15)


def run(context):
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
        with open(LOG_FILE, "w", encoding="utf-8") as fh:
            fh.write("")
    except Exception:
        pass

    app = adsk.core.Application.get()
    _log("=" * 70)
    _log("probe start  version=%s  isStartupComplete=%s" % (app.version, app.isStartupComplete))

    # 对照组：一个从未注册过的 id。它必须也是 False，否则说明 False 另有含义。
    control_id = "FusionBridgeDefinitelyNotRegistered"
    try:
        _log("control fire(unregistered %r) -> %r"
             % (control_id, app.fireCustomEvent(control_id, "")))
    except Exception:
        _log("control fire raised: %s" % traceback.format_exc().strip())

    for event_id in ("FusionBridgeProbe1", "ProbePlain", "Probe.With.Dots"):
        _log("-" * 70)
        _log("event id %r" % event_id)

        try:
            _log("  unregister(before) -> %r" % app.unregisterCustomEvent(event_id))
        except Exception:
            _log("  unregister(before) raised: %s" % traceback.format_exc().strip())

        try:
            event = app.registerCustomEvent(event_id)
        except Exception:
            _log("  register raised: %s" % traceback.format_exc().strip())
            continue

        _log("  register -> %r   is None: %s" % (event, event is None))
        if event is None:
            continue
        try:
            _log("  event.eventId -> %r" % event.eventId)
        except Exception:
            _log("  event.eventId raised: %s" % traceback.format_exc().strip())

        handler = _ProbeHandler()   # 必须保持引用，否则会被 GC
        try:
            _log("  event.add(handler) -> %r" % event.add(handler))
        except Exception:
            _log("  event.add raised: %s" % traceback.format_exc().strip())

        del _hits[:]

        attempts = [
            ("fire(event_id)  [1 arg, 默认 additionalInfo]",
             lambda: app.fireCustomEvent(event_id)),
            ('fire(event_id, "")  [2 args, 显式空串]',
             lambda: app.fireCustomEvent(event_id, "")),
            ('fire(event_id, payload)  [2 args, JSON]',
             lambda: app.fireCustomEvent(event_id, '{"n":1}')),
            ("fire(event.eventId, \"\")  [用返回的 id]",
             lambda: app.fireCustomEvent(event.eventId, "")),
        ]
        for label, call in attempts:
            try:
                result = repr(call())
            except Exception:
                result = "raised " + traceback.format_exc().strip().splitlines()[-1]
            _log("  %s -> %s" % (label, result))
            _pump()
            _log("      hits=%d" % len(_hits))

        # 工作线程触发（add-in 桥真正依赖的路径）
        box = {}

        def _worker():
            try:
                box["r"] = repr(app.fireCustomEvent(event_id, ""))
            except Exception:
                box["r"] = "raised " + traceback.format_exc().strip().splitlines()[-1]

        thread = threading.Thread(target=_worker)
        thread.start()
        thread.join(5)
        _log("  worker-thread fire -> %s" % box.get("r", "<thread did not finish>"))
        _pump()
        _log("      hits=%d" % len(_hits))

        try:
            event.remove(handler)
        except Exception:
            pass
        try:
            _log("  unregister(after) -> %r" % app.unregisterCustomEvent(event_id))
        except Exception:
            _log("  unregister(after) raised: %s" % traceback.format_exc().strip())

    _log("=" * 70)
    _log("probe done")

    try:
        app.log("FusionBridgeProbe 完成，结果见 " + LOG_FILE)
    except Exception:
        pass


def stop(context):
    """add-in 形态下 Fusion 会在停用时调用；探针本身没有常驻状态。"""
    _log("probe stop() called")
