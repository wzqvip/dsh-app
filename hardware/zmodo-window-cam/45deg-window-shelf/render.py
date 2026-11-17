#!/usr/bin/env python3
"""极简网格预览渲染器（正交投影 + z-buffer），不依赖 OpenGL / GPU。

沿用 hardware/minisforum/fan-clip/render.py 的写法，加了几个俯视/侧视用的
视角和「把 3D 点投到像素」的回调，方便在图上画标注。

用法：
    python render.py part.stl preview.png --view iso
"""

from __future__ import annotations

import argparse
import math

import numpy as np
import trimesh
from PIL import Image


def _rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def _rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def view_matrix(view: str) -> np.ndarray:
    """世界 → 相机（相机 x=右, y=上, z=朝观察者）。"""
    if view == "iso":
        return look_at(-58, 35)
    if view == "iso2":
        return look_at(-62, -40)
    if view == "top":
        return np.eye(3)
    if view == "front":      # 从门外正对着门看
        return np.array([[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
    if view == "back":       # 从门里往门外看
        return np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
    if view == "side":       # 门在左，相机朝右伸
        return np.array([[0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]])
    raise ValueError(view)


def look_at(elev: float, azim: float) -> np.ndarray:
    """elev/azim（度）定义观察者在模型外的方位；azim=0 在 +Y（门外）方向。"""
    e, a = math.radians(elev), math.radians(azim)
    zc = np.array([math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)])
    xc = np.cross(np.array([0.0, 0.0, 1.0]), zc)
    n = np.linalg.norm(xc)
    if n < 1e-6:                      # 正上方/正下方
        xc = np.array([1.0, 0.0, 0.0])
    else:
        xc = xc / n
    yc = np.cross(zc, xc)
    return np.array([xc, yc, zc])


def render_scene(items, view: str | np.ndarray = "iso", size=(1200, 900), margin: float = 0.86,
                 light=(0.4, -0.7, 0.6), bg=(255, 255, 255)):
    """items: [(trimesh.Trimesh, (r,g,b)), ...] → (Image, project)。

    project(points Nx3) → Nx2 像素坐标，用来画标注。
    """
    R = view_matrix(view) if isinstance(view, str) else np.asarray(view, dtype=float)
    allv = np.vstack([m.vertices for m, _ in items]) @ R.T
    lo, hi = allv.min(axis=0), allv.max(axis=0)
    center = (lo + hi) / 2
    scale = min(
        size[0] / max(hi[0] - lo[0], 1e-6) * margin,
        size[1] / max(hi[1] - lo[1], 1e-6) * margin,
    )
    W, H = size
    img = np.zeros((H, W, 3), dtype=np.uint8)
    img[:, :] = bg
    zbuf = np.full((H, W), -1e9, dtype=np.float64)
    light = np.asarray(light, dtype=float)
    light = light / np.linalg.norm(light)

    def project(pts):
        V = np.atleast_2d(np.asarray(pts, dtype=float)) @ R.T
        px = (V[:, 0] - center[0]) * scale + W / 2
        py = H / 2 - (V[:, 1] - center[1]) * scale
        return np.stack([px, py], axis=1)

    for mesh, base in items:
        Vw = mesh.vertices
        V = Vw @ R.T
        F = mesh.faces
        px = (V[:, 0] - center[0]) * scale + W / 2
        py = H / 2 - (V[:, 1] - center[1]) * scale
        pz = V[:, 2]
        # 法线用**世界坐标**算：光源是世界方向，拿旋转后的法线去点乘会把
        # 光照跟着视角一起转（原版 fan-clip/render.py 有这个 bug，图会莫名发黑）。
        n = np.cross(Vw[F[:, 1]] - Vw[F[:, 0]], Vw[F[:, 2]] - Vw[F[:, 0]])
        nl = np.linalg.norm(n, axis=1)
        nl[nl == 0] = 1
        n = n / nl[:, None]
        shade = np.clip(n @ light, 0, 1) * 0.62 + 0.22
        # 补一盏「头灯」（从观察者打过去）：不管什么视角，朝向观察者的面都看得见
        shade = shade + np.clip(n @ R[2], 0, 1) * 0.16
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

    return Image.fromarray(img), project


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("stl")
    ap.add_argument("out")
    ap.add_argument("--view", default="iso")
    ap.add_argument("--size", default="1200x900")
    args = ap.parse_args()
    w, h = (int(v) for v in args.size.split("x"))
    mesh = trimesh.load(args.stl, force="mesh")
    img, _ = render_scene([(mesh, (205, 208, 214))], args.view, (w, h))
    img.save(args.out)
    print(f"saved {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
