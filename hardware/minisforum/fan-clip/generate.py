#!/usr/bin/env python3
"""生成 MS-01 / MS-A1 的夹式风扇支架（clip-on fan bracket）。

结构（按"使用姿态"描述，脚本最后会翻转到打印姿态）：

    顶板 ────────────── 开风扇孔，风扇装在外侧朝机器吹
     │ 10mm 静压腔（风从四周缝隙散开，避免把顶面封死）
     │
    机 身 196×189×48
     │
     └─ 两侧竖壁下探，末端 6mm 内折倒钩，45° 斜面便于压入
        靠 0.4mm 过盈夹住机身

打印姿态：顶板贴床，竖壁向上，倒钩在顶部（斜面 45°，免支撑）。

用法：
    python generate.py --fan 120
    python generate.py --fan 140
"""

from __future__ import annotations

import argparse
import math

import numpy as np
import trimesh
from shapely.geometry import Polygon

# ---- 默认整机尺寸（MS-01；MS-A1 大致相同，按实测改 -w/-d/-h） ----
DEV_W = 196.0
DEV_D = 189.0
DEV_H = 48.0

# ---- 结构参数 ----
CLEAR = -0.2      # 每侧过盈量：负=夹紧（-0.2 → 内宽比机身小 0.4mm）
WALL = 3.2        # 竖壁厚
PLATE_T = 4.0     # 顶板厚
GAP = 10.0        # 顶板与机器顶面的静压腔
LIP_L = 6.0       # 倒钩内伸长度
LIP_TIP = 1.5     # 倒钩尖端竖直面
CORNER_R = 6.0    # 顶板圆角
SCREW_D = 4.4     # 风扇螺丝孔
SCREW_HEAD_D = 8.6
SCREW_HEAD_H = 2.0


def rounded_rect_prism(w: float, d: float, r: float, z0: float, z1: float) -> trimesh.Trimesh:
    w2, d2 = w / 2, d / 2
    pts = []
    corners = [
        (w2 - r, -d2 + r, -90, 0),
        (w2 - r, d2 - r, 0, 90),
        (-w2 + r, d2 - r, 90, 180),
        (-w2 + r, -d2 + r, 180, 270),
    ]
    for cx, cy, a0, a1 in corners:
        for i in range(9):
            a = math.radians(a0 + (a1 - a0) * i / 8)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    m = trimesh.creation.extrude_polygon(Polygon(pts), height=z1 - z0)
    return m.apply_translation((0, 0, z0))


def box(x0, x1, y0, y1, z0, z1) -> trimesh.Trimesh:
    m = trimesh.creation.box(extents=(abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)))
    m.apply_translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    return m


def prism_xz(pts_xz, y0: float, y1: float) -> trimesh.Trimesh:
    """XZ 平面截面沿 Y 拉伸（extrude_polygon 只能沿 Z，所以先画 (x,-z) 再绕 X 转）。"""
    poly = Polygon([(x, -z) for x, z in pts_xz])
    m = trimesh.creation.extrude_polygon(poly, height=abs(y1 - y0))
    m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    return m.apply_translation((0, min(y0, y1), 0))


def cyl(radius: float, z0: float, z1: float, cx=0.0, cy=0.0) -> trimesh.Trimesh:
    m = trimesh.creation.cylinder(radius=radius, height=abs(z1 - z0), sections=96)
    return m.apply_translation((cx, cy, (z0 + z1) / 2))


def build_use(fan: int, w: float, d: float, h: float, clear: float = CLEAR,
              lip_l: float = LIP_L, back_stop: bool = False) -> trimesh.Trimesh:
    # ---------- 使用姿态坐标：z=0 是机器底面 ----------
    pw = w + 2 * clear + 2 * WALL
    pd = d + 2 * clear + 2 * WALL
    z_plate0 = h + GAP
    z_plate1 = z_plate0 + PLATE_T
    z_lip_bot = -(lip_l + LIP_TIP)

    plate = rounded_rect_prism(pw, pd, CORNER_R, z_plate0, z_plate1)

    bore_r = 58.0 if fan == 120 else 69.0
    cutters = [cyl(bore_r, z_plate0 - 1, z_plate1 + 1)]
    spacing = 105.0 if fan == 120 else 124.5
    for sx in (-1, 1):
        for sy in (-1, 1):
            cxx, cyy = sx * spacing / 2, sy * spacing / 2
            cutters.append(cyl(SCREW_D / 2, z_plate0 - 1, z_plate1 + 1, cxx, cyy))
            cutters.append(cyl(SCREW_HEAD_D / 2, z_plate1 - SCREW_HEAD_H, z_plate1 + 1, cxx, cyy))
    plate = plate.difference(trimesh.boolean.union(cutters, engine="manifold"))

    x_in = w / 2 + clear  # 竖壁内表面
    parts = [plate]
    for sign in (-1, 1):
        xa, xb = sorted((sign * x_in, sign * (x_in + WALL)))
        parts.append(box(xa, xb, -pd / 2, pd / 2, z_lip_bot, z_plate1))
        # 倒钩：贴机身底面(z=0)内伸 lip_l，尖端 1.5mm 竖直面，回程 45°
        lip_pts = [
            (sign * x_in, 0.0),
            (sign * (x_in - lip_l), 0.0),
            (sign * (x_in - lip_l), -LIP_TIP),
            (sign * x_in, -(lip_l + LIP_TIP)),
        ]
        parts.append(prism_xz(lip_pts, -pd / 2, pd / 2))

    if back_stop:
        # 后端止挡：从前面滑入到底，机身背面顶住它，不会再往后跑
        yb = d / 2 + clear - 1.0
        parts.append(box(-x_in, x_in, yb - 3.0, yb, 0.0, 16.0))

    part = trimesh.boolean.union(parts, engine="manifold")

    return part


def build(fan: int, w: float, d: float, h: float, clear: float = CLEAR,
          grip: bool = False) -> trimesh.Trimesh:
    """打印姿态：顶板贴床、竖壁朝上。"""
    part = build_use(fan, w, d, h, clear, lip_l=(8.0 if grip else LIP_L), back_stop=grip)
    part.apply_transform(trimesh.transformations.rotation_matrix(math.pi, [1, 0, 0]))
    part.apply_translation((0, 0, -part.bounds[0][2]))
    return part


# ---------------- 上下双风扇（叠装） ----------------
TRAY_T = 4.0     # 底板厚
PLENUM = 10.0    # 底板与机身之间的静压腔


def build_tray(fan: int, w: float, d: float, clear: float = CLEAR) -> trimesh.Trimesh:
    """下风扇底板：托住机身、自带 10mm 静压腔，风扇装在底板下方。"""
    tw = w + 2 * clear - 0.6
    td = d + 2 * clear - 0.6
    plate = rounded_rect_prism(tw, td, 5.0, 0.0, TRAY_T)

    bore_r = 58.0 if fan == 120 else 69.0
    spacing = 105.0 if fan == 120 else 124.5
    cutters = [cyl(bore_r, -1, TRAY_T + 1)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            cutters.append(cyl(3.9 / 2, -1, TRAY_T + 1, sx * spacing / 2, sy * spacing / 2))
    plate = plate.difference(trimesh.boolean.union(cutters, engine="manifold"))

    # 四个支撑柱：把机身抬到 10mm 静压腔之上
    posts = []
    px, py = tw / 2 - 14, td / 2 - 14
    for sx in (-1, 1):
        for sy in (-1, 1):
            posts.append(cyl(6.0, TRAY_T, TRAY_T + PLENUM, sx * px, sy * py))
    return trimesh.boolean.union([plate, *posts], engine="manifold")


def build_stack_clip(fan: int, w: float, d: float, h: float, clear: float = CLEAR) -> trimesh.Trimesh:
    """叠装用上夹：竖壁一直伸到托盘底面，倒钩勾住托盘。"""
    pw = w + 2 * clear + 2 * WALL
    pd = d + 2 * clear + 2 * WALL
    z_plate0 = TRAY_T + PLENUM + h + GAP
    z_plate1 = z_plate0 + PLATE_T

    plate = rounded_rect_prism(pw, pd, CORNER_R, z_plate0, z_plate1)
    bore_r = 58.0 if fan == 120 else 69.0
    spacing = 105.0 if fan == 120 else 124.5
    cutters = [cyl(bore_r, z_plate0 - 1, z_plate1 + 1)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            cxx, cyy = sx * spacing / 2, sy * spacing / 2
            cutters.append(cyl(SCREW_D / 2, z_plate0 - 1, z_plate1 + 1, cxx, cyy))
            cutters.append(cyl(SCREW_HEAD_D / 2, z_plate1 - SCREW_HEAD_H, z_plate1 + 1, cxx, cyy))
    plate = plate.difference(trimesh.boolean.union(cutters, engine="manifold"))

    x_in = w / 2 + clear
    parts = [plate]
    for sign in (-1, 1):
        xa, xb = sorted((sign * x_in, sign * (x_in + WALL)))
        parts.append(box(xa, xb, -pd / 2, pd / 2, -(LIP_L + LIP_TIP), z_plate1))
        lip_pts = [
            (sign * x_in, 0.0),
            (sign * (x_in - LIP_L), 0.0),
            (sign * (x_in - LIP_L), -LIP_TIP),
            (sign * x_in, -(LIP_L + LIP_TIP)),
        ]
        parts.append(prism_xz(lip_pts, -pd / 2, pd / 2))
    return trimesh.boolean.union(parts, engine="manifold")


def build_hat(fan: int, w: float, d: float, h: float, skirt: float = 14.0,
              clear: float = 0.5) -> trimesh.Trimesh:
    """帽子式：不加倒钩，直接坐在机器顶面，靠裙边定位（最省事、可随时拿走）。"""
    pw = w + 2 * clear + 2 * WALL
    pd = d + 2 * clear + 2 * WALL
    plate = rounded_rect_prism(pw, pd, CORNER_R, h, h + PLATE_T)

    bore_r = 58.0 if fan == 120 else 69.0
    spacing = 105.0 if fan == 120 else 124.5
    cutters = [cyl(bore_r, h - 1, h + PLATE_T + 1)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            cxx, cyy = sx * spacing / 2, sy * spacing / 2
            cutters.append(cyl(SCREW_D / 2, h - 1, h + PLATE_T + 1, cxx, cyy))
            cutters.append(cyl(SCREW_HEAD_D / 2, h + PLATE_T - SCREW_HEAD_H, h + PLATE_T + 1, cxx, cyy))
    plate = plate.difference(trimesh.boolean.union(cutters, engine="manifold"))

    x_in = w / 2 + clear
    parts = [plate]
    for sign in (-1, 1):
        xa, xb = sorted((sign * x_in, sign * (x_in + WALL)))
        parts.append(box(xa, xb, -pd / 2, pd / 2, h - skirt, h + PLATE_T))
    return trimesh.boolean.union(parts, engine="manifold")


def to_print_pose(part: trimesh.Trimesh) -> trimesh.Trimesh:
    part.apply_transform(trimesh.transformations.rotation_matrix(math.pi, [1, 0, 0]))
    part.apply_translation((0, 0, -part.bounds[0][2]))
    return part


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fan", type=int, choices=(120, 140), default=140)
    ap.add_argument("--w", type=float, default=DEV_W)
    ap.add_argument("--d", type=float, default=DEV_D)
    ap.add_argument("--h", type=float, default=DEV_H)
    ap.add_argument("--clear", type=float, default=CLEAR)
    ap.add_argument("--mode", choices=("top", "grip", "hat", "stack"), default="top",
                    help="top=单件上夹；grip=加后止挡+8mm 倒钩；hat=直接坐在顶面；stack=上下双风扇")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    def report(name, part):
        part.export(name)
        ext = part.extents
        print(f"{name}: {ext[0]:.1f} x {ext[1]:.1f} x {ext[2]:.1f} mm")
        print(
            f"  watertight={part.is_watertight} volume={part.volume/1000:.1f} cm3 "
            f"PETG~{part.volume/1000*1.27:.0f} g solid"
        )

    if args.mode in ("top", "grip"):
        suffix = "" if args.mode == "top" else "-grip"
        report(
            args.out or f"fan-clip-{args.fan}{suffix}.stl",
            build(args.fan, args.w, args.d, args.h, args.clear, grip=(args.mode == "grip")),
        )
    elif args.mode == "hat":
        report(f"fan-hat-{args.fan}.stl", to_print_pose(build_hat(args.fan, args.w, args.d, args.h)))
    else:
        report(args.out or f"fan-clip-{args.fan}-stack.stl",
               to_print_pose(build_stack_clip(args.fan, args.w, args.d, args.h, args.clear)))
        report(f"fan-tray-{args.fan}.stl",
               build_tray(args.fan, args.w, args.d, args.clear))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
