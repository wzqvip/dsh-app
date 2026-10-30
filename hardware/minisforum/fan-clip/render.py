#!/usr/bin/env python3
"""极简网格预览渲染器（正交投影 + z-buffer），不依赖 OpenGL。

用法：
    python render.py fan-clip-140.stl preview.png --view iso
    python preview_use.py            # 使用姿态 + 机器占位块
"""

from __future__ import annotations

import argparse
import math

import numpy as np
import trimesh
from PIL import Image


def view_matrix(view: str) -> np.ndarray:
    def rz(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])

    def rx(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])

    if view == "iso":
        return rx(math.radians(-58)) @ rz(math.radians(35))
    if view == "top":
        return np.eye(3)
    if view == "front":
        return rx(math.radians(-90))
    if view == "side":
        return rx(math.radians(-90)) @ rz(math.radians(90))
    raise ValueError(view)


def render_scene(items, view: str = "iso", size=(1200, 900), margin: float = 0.86) -> Image.Image:
    """items: [(trimesh.Trimesh, (r,g,b)), ...]"""
    R = view_matrix(view)
    allv = np.vstack([m.vertices for m, _ in items]) @ R.T
    lo, hi = allv.min(axis=0), allv.max(axis=0)
    center = (lo + hi) / 2
    scale = min(
        size[0] / max(hi[0] - lo[0], 1e-6) * margin,
        size[1] / max(hi[1] - lo[1], 1e-6) * margin,
    )
    W, H = size
    img = np.zeros((H, W, 3), dtype=np.uint8)
    zbuf = np.full((H, W), -1e9, dtype=np.float64)
    light = np.array([0.4, -0.7, 0.6])
    light /= np.linalg.norm(light)

    for mesh, base in items:
        V = mesh.vertices @ R.T
        F = mesh.faces
        px = (V[:, 0] - center[0]) * scale + W / 2
        py = H / 2 - (V[:, 1] - center[1]) * scale
        pz = V[:, 2]
        n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
        nl = np.linalg.norm(n, axis=1)
        nl[nl == 0] = 1
        n = n / nl[:, None]
        shade = np.clip(n @ light, 0, 1) * 0.75 + 0.25
        base_arr = np.array(base, dtype=np.float64)

        for i in range(len(F)):
            a, b, c = F[i]
            x = np.array([px[a], px[b], px[c]])
            y = np.array([py[a], py[b], py[c]])
            z = np.array([pz[a], pz[b], pz[c]])
            x0, x1 = int(max(0, np.floor(x.min()))), int(min(W - 1, np.ceil(x.max())))
            y0, y1 = int(max(0, np.floor(y.min()))), int(min(H - 1, np.ceil(y.max())))
            if x1 < x0 or y1 < y0:
                continue
            den = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
            if abs(den) < 1e-9:
                continue
            ys_, xs_ = np.meshgrid(
                np.arange(y0, y1 + 1) + 0.5, np.arange(x0, x1 + 1) + 0.5, indexing="ij"
            )
            w0 = ((y[1] - y[2]) * (xs_ - x[2]) + (x[2] - x[1]) * (ys_ - y[2])) / den
            w1 = ((y[2] - y[0]) * (xs_ - x[2]) + (x[0] - x[2]) * (ys_ - y[2])) / den
            w2 = 1 - w0 - w1
            mask = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
            if not mask.any():
                continue
            zz = w0 * z[0] + w1 * z[1] + w2 * z[2]
            sub = zbuf[y0 : y1 + 1, x0 : x1 + 1]
            better = mask & (zz > sub)
            if not better.any():
                continue
            sub[better] = zz[better]
            img[y0 : y1 + 1, x0 : x1 + 1][better] = (base_arr * shade[i]).astype(np.uint8)

    return Image.fromarray(img)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("stl")
    ap.add_argument("out")
    ap.add_argument("--view", default="iso", choices=("iso", "top", "front", "side"))
    ap.add_argument("--size", default="1200x900")
    args = ap.parse_args()
    w, h = (int(v) for v in args.size.split("x"))
    mesh = trimesh.load(args.stl, force="mesh")
    render_scene([(mesh, (205, 208, 214))], args.view, (w, h)).save(args.out)
    print(f"saved {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
