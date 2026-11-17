#!/usr/bin/env python3
"""出预览图。

    preview-use.png      使用姿态（门板占位 + 相机占位）—— 主图
    preview-side.png     侧视 + 45° 标注
    preview-back.png     贴门的那一面（胶带区 + 螺丝孔）
    preview-section.png  沿 x=0 剖开，看内腔 / 三角筋 / 出线缺口
    preview-print.png    打印姿态（背板贴床）

相机占位体只是造型参考，不是打印件。
"""

from __future__ import annotations

import math

import numpy as np
import trimesh
from PIL import ImageDraw, ImageFont

from generate import (ANGLE, FACE_LEN, Y0, Z0, build, camera_mock, dims,
                      to_print_pose)
from render import look_at, render_scene

FONT_PATHS = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

PLASTIC = (218, 222, 228)
CAMERA = (74, 80, 90)
DOOR = (236, 231, 221)
BED = (204, 209, 216)
INK = (38, 42, 50)
MUTED = (116, 120, 128)
ACCENT = (198, 62, 52)


def font(px: int):
    for p in FONT_PATHS:
        try:
            return ImageFont.truetype(p, px)
        except OSError:
            continue
    return ImageFont.load_default()


def dashed(draw, a, b, dash=9, gap=7, fill=INK, width=2):
    a, b = np.asarray(a, float), np.asarray(b, float)
    length = float(np.linalg.norm(b - a))
    if length < 1e-6:
        return
    d = (b - a) / length
    t = 0.0
    while t < length:
        t2 = min(t + dash, length)
        draw.line([tuple(a + d * t), tuple(a + d * t2)], fill=fill, width=width)
        t = t2 + gap


def arrow(draw, a, b, fill=INK, width=2, head=12):
    a, b = np.asarray(a, float), np.asarray(b, float)
    draw.line([tuple(a), tuple(b)], fill=fill, width=width)
    d = b - a
    n = np.linalg.norm(d)
    if n < 1e-6:
        return
    d /= n
    perp = np.array([-d[1], d[0]])
    for s in (-1, 1):
        p = b - d * head + perp * head * 0.45 * s
        draw.line([tuple(b), tuple(p)], fill=fill, width=width)


def label(draw, xy, text, f, fill=INK, anchor="lm", bg=(255, 255, 255), pad=5):
    x, y = xy
    if bg is not None:
        box = draw.textbbox((x, y), text, font=f, anchor=anchor)
        draw.rectangle([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], fill=bg)
    draw.text((x, y), text, font=f, fill=fill, anchor=anchor)


def main() -> None:
    t = math.radians(ANGLE)
    mount = build()
    cam = camera_mock()
    z_top, y_top, z_bottom = dims()

    # ---------- 使用姿态（主图） ----------
    door = trimesh.creation.box(extents=(112.0, 14.0, 132.0))
    door.apply_translation((0.0, -7.0, 24.0))
    img, _ = render_scene(
        [(door, DOOR), (cam, CAMERA), (mount, PLASTIC)],
        look_at(6, 38), (1400, 1150), margin=0.9, light=(0.3, 0.8, -0.35),
    )
    img.save("preview-use.png")

    # ---------- 侧视 + 标注 ----------
    door_s = trimesh.creation.box(extents=(130.0, 9.0, 130.0))
    door_s.apply_translation((0.0, -4.5, 24.0))
    img, proj = render_scene(
        [(door_s, DOOR), (cam, CAMERA), (mount, PLASTIC)],
        "side", (1500, 1050), margin=0.84, light=(0.55, 0.45, 0.7),
    )
    d = ImageDraw.Draw(img)
    f, fs = font(34), font(27)

    p_door_top = proj([[0.0, 0.0, 89.0]])[0]
    p_door_bot = proj([[0.0, 0.0, -41.0]])[0]
    d.line([tuple(p_door_top), tuple(p_door_bot)], fill=(146, 141, 130), width=3)
    label(d, (p_door_bot[0] - 14, p_door_bot[1] + 20), "门面", fs, anchor="rm", bg=DOOR)

    fc = np.array([0.0, Y0 + FACE_LEN / 2 * math.sin(t), Z0 + FACE_LEN / 2 * math.cos(t)])
    axis = np.array([0.0, math.cos(t), -math.sin(t)])
    p0 = proj([fc])[0]
    hor = proj([fc + np.array([0.0, 60.0, 0.0])])[0]
    ax = proj([fc + axis * 62.0])[0]
    dashed(d, p0, hor, fill=(126, 126, 134), width=2)
    label(d, (hor[0] + 10, hor[1] - 6), "水平", fs, fill=(104, 104, 112))
    arrow(d, p0, ax, fill=ACCENT, width=3)
    label(d, (ax[0] + 14, ax[1] + 26), "镜头轴线", fs, fill=ACCENT)

    arc = [fc + 46.0 * np.array([0.0, math.cos(t * k / 18), -math.sin(t * k / 18)]) for k in range(19)]
    pp = proj(arc)
    d.line([tuple(p) for p in pp], fill=ACCENT, width=3)
    mid = proj([fc + 60.0 * np.array([0.0, math.cos(t / 2), -math.sin(t / 2)])])[0]
    label(d, (mid[0] + 8, mid[1]), f"{ANGLE:g}°", font(40), fill=ACCENT)

    # 深度尺寸：门面 → 顶板最前缘
    a_ = proj([[0.0, 0.0, z_top + 8.0]])[0]
    b_ = proj([[0.0, y_top, z_top + 8.0]])[0]
    arrow(d, a_, b_, fill=MUTED, width=2)
    arrow(d, b_, a_, fill=MUTED, width=2)
    dashed(d, proj([[0.0, y_top, z_top]])[0], b_, fill=MUTED, width=1)
    label(d, ((a_[0] + b_[0]) / 2, a_[1] - 12), f"深 {y_top:.0f}", fs, fill=MUTED, anchor="mb")

    img.save("preview-side.png")

    # ---------- 贴门面 ----------
    img, proj = render_scene([(mount, PLASTIC)], "back", (1150, 1150), margin=0.9,
                             light=(0.2, -0.85, 0.4))
    d = ImageDraw.Draw(img)
    zc = (z_top - 10.0) / 2.0
    corners = [proj([[sx * 30.0, 0.0, zc + sz * 24.0]])[0] for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for i in range(4):
        dashed(d, corners[i], corners[(i + 1) % 4], dash=8, gap=6, fill=ACCENT, width=2)
    label(d, (np.mean([c[0] for c in corners]), np.mean([c[1] for c in corners])),
          "3M 胶带 60×48", font(29), fill=ACCENT, anchor="mm")
    label(d, (30, 28), "这一面贴门（两个 Ø4.3 孔可选：拧自攻螺丝）", font(24), fill=(80, 84, 92), anchor="la")
    img.save("preview-back.png")

    # ---------- 剖面（沿 x=-18 切 3mm 薄片，像剖面图） ----------
    slab = trimesh.creation.box(extents=(3.0, 400.0, 400.0))
    slab.apply_translation((0.0, 0.0, 0.0))
    cut = trimesh.boolean.intersection([mount, slab], engine="manifold")
    cut_cam = trimesh.boolean.intersection([cam, slab], engine="manifold")
    img, _ = render_scene(
        [(cut_cam, CAMERA), (cut, PLASTIC)], "side", (1500, 1150), margin=0.88,
        light=(0.55, 0.45, 0.7),
    )
    d = ImageDraw.Draw(img)
    label(d, (34, 26), "剖面（x=0）：中空内腔 + 底部出线缺口；相机坐进 1mm 浅槽、靠 4mm 围框限位", font(26),
          fill=(74, 78, 86), anchor="la")
    img.save("preview-section.png")

    # ---------- 打印姿态 ----------
    printed = to_print_pose(mount.copy())
    bed = trimesh.creation.box(extents=(170.0, 170.0, 2.0))
    bed.apply_translation((0.0, 0.0, -1.0))
    img, _ = render_scene([(bed, BED), (printed, PLASTIC)], look_at(14, 68),
                          (1300, 1000), margin=0.95, light=(0.3, 0.45, 0.85))
    d = ImageDraw.Draw(img)
    label(d, (34, 26), "打印姿态：背板贴床，45° 斜面朝上，免支撑", font(27),
          fill=(74, 78, 86), anchor="la")
    img.save("preview-print.png")

    print("saved preview-{use,side,back,section,print}.png")


if __name__ == "__main__":
    main()

