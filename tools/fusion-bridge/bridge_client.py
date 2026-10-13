#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FusionBridge 客户端 —— 命令行驱动 Fusion 360。

用法::

    python bridge_client.py ping
    python bridge_client.py info
    python bridge_client.py exec --file part.py --session demo
    python bridge_client.py exec --code "print(design.rootComponent.name)"
    python bridge_client.py eval --expr "dir(core.Viewport)"
    python bridge_client.py screenshot --path out.png --fit

输出永远是 JSON（便于脚本解析）；退出码 0 = 成功，1 = 失败。
端口与 token 从 add-in 写的 status.json 读取，也可以用 --port/--token 覆盖。
"""

import argparse
import json
import os
import socket
import sys
import time

DEFAULT_PORT = 47800
DEFAULT_TIMEOUT_S = 120.0

if os.name == "nt":
    STATE_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "FusionBridge")
else:
    STATE_DIR = os.path.join(os.path.expanduser("~"), ".fusion-bridge")
STATE_FILE = os.path.join(STATE_DIR, "status.json")


def load_status():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def send_once(req, host, port, timeout_s):
    payload = (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")
    with socket.create_connection((host, port), timeout=min(timeout_s + 10.0, 60.0)) as sock:
        sock.settimeout(timeout_s + 15.0)
        sock.sendall(payload)
        stream = sock.makefile("rb")
        line = stream.readline()
    if not line:
        raise RuntimeError("bridge closed the connection without replying")
    return json.loads(line.decode("utf-8"))


def wait_for_bridge(host, port, seconds):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        try:
            return send_once({"op": "ping"}, host, port, 5.0)
        except Exception as exc:
            last = exc
            time.sleep(0.4)
    raise RuntimeError("bridge not reachable on %s:%s after %.0fs (%s)" % (host, port, seconds, last))


def read_code(args):
    if args.code is not None:
        return args.code
    if args.file:
        if args.file == "-":
            return sys.stdin.read()
        with open(args.file, "r", encoding="utf-8") as fh:
            return fh.read()
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("需要 --code / --file，或者从 stdin 喂代码")


def build_request(args):
    op = args.op
    req = {"op": op, "timeoutMs": int(args.timeout * 1000)}
    if op == "exec":
        req["code"] = read_code(args)
        if args.session:
            req["session"] = args.session
    elif op == "eval":
        req["expr"] = args.expr if args.expr is not None else read_code(args)
    elif op == "screenshot":
        req["path"] = args.path
        req["width"] = args.width
        req["height"] = args.height
        req["fit"] = bool(args.fit)
    return req


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="Drive Fusion 360 through FusionBridge.")
    parser.add_argument("op", choices=["ping", "info", "exec", "eval", "screenshot"])
    parser.add_argument("--code", help="inline Python source (exec op)")
    parser.add_argument("--file", help="Python file to run (exec op); '-' reads stdin")
    parser.add_argument("--expr", help="expression to evaluate (eval op)")
    parser.add_argument("--session", help="reuse a named persistent namespace across exec calls")
    parser.add_argument("--path", help="output PNG path (screenshot op)")
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--fit", action="store_true", help="fit the view before capturing")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S, help="seconds")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--token", default=None)
    parser.add_argument("--wait", type=float, default=0.0, help="seconds to wait for the bridge to appear")
    parser.add_argument("--raw", action="store_true", help="print only the result/stdout, not the envelope")
    args = parser.parse_args(argv)

    status = load_status()
    host = args.host or status.get("host") or "127.0.0.1"
    port = args.port or status.get("port") or DEFAULT_PORT
    token = args.token if args.token is not None else status.get("token")

    if args.wait > 0 or args.op == "ping":
        try:
            wait_for_bridge(host, port, max(args.wait, 0.1))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc),
                              "hint": "先在 Fusion 里打开 实用工具 → 脚本和附加模块 → 附加模块 → FusionBridge → 运行"},
                             ensure_ascii=False, indent=2))
            return 1

    req = build_request(args)
    if token:
        req["token"] = token

    try:
        resp = send_once(req, host, port, args.timeout)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)},
                         ensure_ascii=False, indent=2))
        return 1

    if args.raw:
        value = resp.get("result")
        if value is None and resp.get("stdout"):
            sys.stdout.write(resp["stdout"])
        else:
            sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    else:
        print(json.dumps(resp, ensure_ascii=False, indent=2))
    return 0 if resp.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
