#!/usr/bin/env python3
"""出预览图。

    preview-use.png        使用姿态渲染（门 + 支架 + 相机占位）
    preview-side.png       原理剖面示意图（这张图解释「为什么它长这样」）
    preview-print.png      打印姿态渲染
"""

from __future__ import annotations

import math

import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageFont

from generate import (ANGLE, CAM_W, PLATE_L, STOP_INSET, STOP_L, Y0, Z_TOP, _rot,
                      build, build_hood, camera_mock, key_points, mouth_rect,
                      to_print_pose)
from render import look_at, render_scene

FONT_PATHS = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

PLASTIC = (206, 211, 219)
CAMERA = (86, 92, 102)
HOOD = (118, 128, 146)
DOOR = (236, 231, 221)
BED = (203, 208, 215)
INK = (38, 42, 50)
MUTED = (116, 120, 128)
ACCENT = (198, 62, 52)
BLUE = (44, 92, 168)
GREEN = (36, 120, 88)


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


def outward(p, q, dist=0.0):
    """p 到 q 的方向偏移（用来把引线错开）。"""
    d = np.asarray(q, float) - np.asarray(p, float)
    n = np.linalg.norm(d)
    return np.asarray(p, float) if n < 1e-9 else np.asarray(p, float) + d / n * dist


def draw_principle(cam_c: float) -> None:
    """2D 剖面示意图：门 + 楔形件 + 相机 + 视线。"""
    W, H = 1500, 1000
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    S = 8.6
    ox, oy = 360.0, 900.0

    def P(y, z):
        return (ox + y * S, oy - z * S)

    f_title, f_big, fs, fss = font(36), font(30), font(25), font(21)

    # 室内 / 室外底色
    d.rectangle([0, 0, ox, H], fill=(246, 243, 237))
    d.text((40, 40), "室 外", font=f_title, fill=(150, 144, 132))
    d.text((W - 150, 40), "室 内", font=f_title, fill=(150, 144, 132))

    # 门
    hx, z0, z1 = mouth_rect()
    d.line([P(0, -6), P(0, 100)], fill=(146, 141, 130), width=4)
    for zz in np.arange(-4, 100, 4.0):
        d.line([P(0, zz), P(-2.2, zz + 2.2)], fill=(206, 200, 188), width=2)
    d.line([P(0, z0 - 4), P(0, z1 + 4)], fill=BLUE, width=10)
    d.text((P(0, z0 - 8)[0] - 26, P(0, z0 - 8)[1]), "玻璃", font=fs, fill=BLUE, anchor="rm")

    # 背板
    d.polygon([P(0, 48), P(5, 48), P(5, 78), P(0, 78)], fill=(120, 126, 136))
    # 斜面（分两段：中间是窗口）
    t = math.radians(ANGLE)
    n = np.array([math.cos(t), math.sin(t)])
    face0 = np.array([5.0, Z_TOP])
    face1 = np.array([5.0 + PLATE_L * math.sin(t), Z_TOP - PLATE_L * math.cos(t)])
    u = np.array([math.sin(t), -math.cos(t)])
    win_a = face0 + u * (cam_c - 19.0)
    win_b = face0 + u * (cam_c + 19.0)
    for a, b in ((face0, win_a), (win_b, face1)):
        d.polygon([P(*a), P(*b), P(*(b - 4 * n)), P(*(a - 4 * n))], fill=(150, 156, 166))
    d.polygon([P(*face0), P(*(face0 + 4 * n)), P(*(face0 + 4 * n + 4 * u)),
               P(*(face0 + 4 * u))], fill=(120, 126, 136))

    # 遮光罩：从窗口一路包到玻璃，罩内是暗的 → 玻璃上没有室内反光
    m_top = np.array([0.0, z1 + 3.0])
    m_bot = np.array([0.0, z0 - 3.0])
    d.polygon([P(*win_a), P(*m_top), P(*m_bot), P(*win_b)], fill=(226, 230, 238))
    for a, b in ((win_a, m_top), (win_b, m_bot)):
        d.line([tuple(P(*a)), tuple(P(*b))], fill=(112, 122, 140), width=5)
    d.line([tuple(P(*m_top)), tuple(P(*m_bot))], fill=BLUE, width=7)
    d.text(P(22.0, 30.0), "罩内避光", font=fss, fill=(80, 86, 98), anchor="lm")

    # 相机：半透明，免得盖住窗口和斜面
    cam_a = face0 + u * (cam_c - CAM_W / 2)
    cam_b = face0 + u * (cam_c + CAM_W / 2)
    poly = [tuple(P(*cam_a)), tuple(P(*cam_b)), tuple(P(*(cam_b + 30 * n))),
            tuple(P(*(cam_a + 30 * n)))]
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(ov).polygon(poly, fill=(86, 92, 102, 105))
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    d = ImageDraw.Draw(img)
    d.line([tuple(P(*cam_a)), tuple(P(*cam_b))], fill=(40, 44, 52), width=5)
    d.line(poly + [poly[0]], fill=(48, 52, 60), width=3)
    lens = face0 + u * cam_c
    lx, ly = P(*lens)
    d.ellipse([lx - 7, ly - 7, lx + 7, ly + 7], fill=(250, 250, 250), outline=(30, 34, 40), width=2)

    # 视线：镜头 → 门外
    axis = np.array([-math.cos(t), -math.sin(t)])
    hit = lens + axis * (lens[0] / math.cos(t))
    far = hit + axis * 26.0
    arrow(d, P(*lens), P(*far), fill=ACCENT, width=4)
    d.text((P(*far)[0] + 10, P(*far)[1] + 12), "视线 → 门外地面", font=fs, fill=ACCENT, anchor="lm")

    # 水平参考 + 45° 弧
    hor = lens + np.array([-44.0, 0.0])
    dashed(d, P(*lens), P(*hor), fill=(150, 150, 158), width=2)
    d.text((P(*hor)[0] - 12, P(*hor)[1] - 26), "水平", font=fss, fill=(120, 120, 128), anchor="rm")
    arc = [lens + 38.0 * np.array([-math.cos(t * i / 18), -math.sin(t * i / 18)]) for i in range(19)]
    d.line([tuple(P(*p)) for p in arc], fill=ACCENT, width=3)
    mid = lens + 50.0 * np.array([-math.cos(t / 2), -math.sin(t / 2)])
    d.text((P(*mid)[0] - 8, P(*mid)[1] - 4), f"{ANGLE:g}°", font=font(34), fill=ACCENT, anchor="rm")

    def leader(p_mm, q_mm, text, f, fill=INK, anchor=None):
        p, q = P(*p_mm), P(*q_mm)
        d.line([tuple(p), tuple(q)], fill=fill, width=2)
        d.ellipse([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], fill=fill)
        a = anchor or ("lm" if q[0] >= p[0] else "rm")
        d.text((q[0] + (12 if a == "lm" else -12), q[1]), text, font=f, fill=fill, anchor=a)

    leader((2.5, 74.0), (26.0, 98.0), "背板：整面胶带贴玻璃", fs)
    leader((cam_b[0] + 12 * n[0], cam_b[1] + 12 * n[1]), (74.0, 76.0),
           "相机：镜头那一面贴在斜面上", fs, fill=(60, 66, 76))
    leader((float(np.mean([win_a[0], win_b[0]]) - 6), float(np.mean([win_a[1], win_b[1]]) - 8)),
           (60.0, 12.0), "窗口 38×38（切穿斜面）", fs)
    leader((50.0, 25.5), (66.0, 40.0), "45° 斜面", fs, fill=(90, 96, 106))
    leader((0.0, (z0 + z1) / 2), (30.0, z0 + 8.0), "罩口：泡沫胶条压玻璃", fs, fill=BLUE)

    label(d, (W / 2, H - 26), "剖面示意（未按比例）：相机脸贴 45° 斜面，镜头 → 窗口 → 遮光罩 → 门玻璃",
          font(22), fill=(120, 124, 132), anchor="mm", bg=None)
    img.save("preview-side.png")


def main() -> None:
    mount = build()
    cam = camera_mock()
    hood = build_hood()
    k = key_points()
    cam_c = STOP_L - STOP_INSET + CAM_W / 2.0

    # ---------- 使用姿态（含遮光罩） ----------
    door = trimesh.creation.box(extents=(130.0, 14.0, 220.0))
    door.apply_translation((0.0, -7.0, 20.0))
    img, _ = render_scene(
        [(door, DOOR), (mount, PLASTIC), (hood, HOOD), (cam, CAMERA)],
        look_at(24, 38), (1400, 1150), margin=0.86, light=(0.3, 0.75, 0.45),
    )
    img.save("preview-use.png")

    # ---------- 原理图 ----------
    draw_principle(cam_c)

    # ---------- 打印姿态：两件并排 ----------
    printed = to_print_pose(mount.copy())
    printed.apply_translation((-62.0, 0.0, 0.0))
    hp = hood.copy()
    hp.apply_transform(_rot("x", ANGLE))
    hp.apply_translation((0.0, 0.0, -hp.bounds[0][2]))
    hp.apply_translation((46.0, 0.0, 0.0))
    bed = trimesh.creation.box(extents=(250.0, 200.0, 2.0))
    bed.apply_translation((0.0, 0.0, -1.0))
    img, _ = render_scene([(bed, BED), (printed, PLASTIC), (hp, HOOD)],
                          look_at(22, 158), (1400, 1000), margin=0.95,
                          light=(0.3, 0.5, 0.8))
    d = ImageDraw.Draw(img)
    label(d, (34, 26), "打印：支架（左，胶面朝下）+ 遮光罩（右，罩口朝下）",
          font(26), fill=(74, 78, 86), anchor="la")
    img.save("preview-print.png")

    print("saved preview-{use,side,print}.png")


if __name__ == "__main__":
    main()



