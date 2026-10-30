#!/usr/bin/env python3
"""通过 FlareSolverr 抓取被 Cloudflare 拦截的页面，并输出可读文本。

背景：makerworld.com / makerworld.com.cn / printables.com 等站点对普通 HTTP
客户端返回 403（"Just a moment..."）。在局域网里跑一个 FlareSolverr 容器后，
由它用未检测模式的无头 Chromium 过挑战，再把渲染后的 HTML 返回给我们。

用法：
    python3 cf-fetch.py https://makerworld.com/en/models/942817
    python3 cf-fetch.py <url> --raw > page.html       # 保存原始 HTML
    python3 cf-fetch.py <url> --desc                  # 只打印 Description 段

环境变量：
    FLARESOLVERR  默认 http://127.0.0.1:8191

部署 FlareSolverr（在 ubuntu-gpu 上）：

    docker run -d --name flaresolverr --restart unless-stopped \
      -p 8191:8191 -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest

注意：
- makerworld.com.cn 的挑战更强，FlareSolverr 可能停在「正在进行安全验证」；
- 图片 CDN 在 Windows 本机常 403，但在跑 FlareSolverr 的服务器上 curl 可直接
  200，拉图请走服务器再 scp 回来。
"""

import argparse
import html
import json
import os
import re
import sys
import urllib.request

DEFAULT_SOLVER = os.environ.get("FLARESOLVERR", "http://127.0.0.1:8191")


def fetch(url: str, solver: str, timeout_ms: int = 90000) -> str:
    body = json.dumps(
        {"cmd": "request.get", "url": url, "maxTimeout": timeout_ms}
    ).encode()
    req = urllib.request.Request(
        f"{solver.rstrip('/')}/v1",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    resp = json.load(urllib.request.urlopen(req, timeout=timeout_ms / 1000 + 60))
    if resp.get("status") != "ok":
        raise RuntimeError(f"FlareSolverr: {resp.get('status')} {resp.get('message')}")
    return resp["solution"]["response"]


def to_text(raw: str) -> str:
    t = re.sub(r"<script.*?</script>|<style.*?</style>|<svg.*?</svg>", " ", raw, flags=re.S | re.I)
    t = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    lines = [re.sub(r"\s+", " ", l).strip() for l in html.unescape(t).splitlines()]
    return "\n".join(l for l in lines if l)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--solver", default=DEFAULT_SOLVER)
    ap.add_argument("--raw", action="store_true", help="输出原始 HTML")
    ap.add_argument("--desc", action="store_true", help="只输出 Description 段")
    ap.add_argument("--limit", type=int, default=12000)
    args = ap.parse_args()

    raw = fetch(args.url, args.solver)
    if args.raw:
        sys.stdout.write(raw)
        return 0

    text = to_text(raw)
    if args.desc:
        m = re.search(r"^Description$(.*?)^Reviews & Ratings", text, re.S | re.M)
        if m:
            text = m.group(1).strip()
    sys.stdout.write(text[: args.limit])
    if len(text) > args.limit:
        sys.stdout.write(f"\n... [truncated, total {len(text)} chars]\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
