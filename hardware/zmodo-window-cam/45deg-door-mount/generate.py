#!/usr/bin/env python3
"""Zmodo 4MP 窗户摄像机 —— 45° 门挂转接板（参数化生成）。

为什么是这么个形状
------------------
摄像机的镜头朝向 = 它背面所贴那个表面的外法线。想让镜头**斜向下 45°**，
装它的那个面就**必须朝下 45°**：摄像机会吊在这个面的下面/前面，楔形体在它
上面/后面。这是「背面平贴 + 刚性 45°」唯一可能的拓扑，换个形状只会让镜头朝上
或朝侧面（试出来的，不是偷懒）。

    侧面（门在左，y 朝室内，z 向上）

     门 │╲
        │ ╲ ←── 45° 装夹面（法线朝「门外 + 斜下」）
        │  ╲
        │   ╲
        │    ╲ ←── 摄像机（30mm 厚，从装夹面斜着伸出去，镜头朝下）
        └─────╲

坐标：x 宽度 / y 离开门面的方向 / z 向上（安装姿态）。脚本最后翻成打印姿态。

用法：
    python generate.py                      # 45°，标称尺寸
    python generate.py --angle 30           # 想要别的俯角
    python generate.py --cam-w 58 --cam-h 58 --clear 0.5
"""

from __future__ import annotations

import argparse
import math

import numpy as np
import trimesh
from shapely.geometry import Polygon

# ---------------- 标称尺寸（mm） ----------------
# 官方标 2.28 × 2.28 × 1.18 inch = 57.9 × 57.9 × 30.0，圆角按图片量约 R12
CAM_W = 58.0
CAM_H = 58.0
CAM_D = 30.0
CAM_R = 12.0

ANGLE = 45.0        # 俯角（相对水平）
CLEAR = 0.4         # 单边配合间隙
TAPE = 1.0          # 3M 胶带厚度（决定相机背面离槽底多远）

WIDTH = 70.0        # 整体宽度
FACE_LEN = 72.0     # 45° 斜面长度（沿斜面量）
Z0 = 8.0            # 斜面下沿的高度
Y0 = 8.0            # 斜面下沿离门面的距离：必须 ≥ 背板厚 + 5mm/cos45（否则出线槽
                    # 会一路切穿贴门背板，在胶带面上开个洞 —— 早先 v1 就踩了这个）
BACK_T = 4.0        # 贴门背板厚
FACE_T = 5.0        # 斜面主板厚
TOP_T = 4.0         # 顶板厚
BACK_DROP = 10.0    # 背板向下多伸出 10mm（多一点贴胶面积、包住相机下沿）
EDGE_R = 8.0        # 背板圆角

FRAME_W = 3.0       # 相机围框宽
FRAME_H = 4.0       # 围框高（凸出斜面这么多）
SINK = 1.0          # 相机沉进斜面的深度

GUSSET_T = 3.5      # 两侧三角加强筋厚
GUSSET_X = 32.0     # 加强筋中心 x
RIB_T = 3.0         # 内肋厚
RIB_X = 18.0        # 内肋中心 x
CABLE_W = 12.0      # 出线缺口宽


# ---------------- 变换 ----------------
def _rot(axis: str, deg: float) -> np.ndarray:
    return trimesh.transformations.rotation_matrix(math.radians(deg), [int(axis == "x"), int(axis == "y"), int(axis == "z")])


# 局部 (x, y, z) → 世界 (z, x, y)：给「在 yz 平面画截面、沿 x 拉伸」的件用
R_YZ = np.array(
    [[0.0, 0.0, 1.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
)


def face_frame(angle: float, y0: float, z0: float) -> np.ndarray:
    """斜面局部坐标系 → 世界坐标。

    局部 x = 世界 X（宽度方向）
    局部 y = 沿斜面「向上」的方向 = (0, sinθ, cosθ)
    局部 z = **扎进材料里**的方向 = -法线 = (0, -cosθ, sinθ)

    也就是：局部 z>0 在斜面背后（材料侧），z<0 在相机那一侧。
    """
    t = math.radians(angle)
    s, c = math.sin(t), math.cos(t)
    M = np.eye(4)
    M[:3, 0] = (1.0, 0.0, 0.0)
    M[:3, 1] = (0.0, s, c)
    M[:3, 2] = (0.0, -c, s)
    M[:3, 3] = (0.0, y0, z0)
    return M


# ---------------- 基本体 ----------------
def rrect(w: float, h: float, r: float, cx: float = 0.0, cy: float = 0.0, seg: int = 8) -> Polygon:
    """圆角矩形（中心 cx,cy）。"""
    r = max(0.2, min(r, w / 2 - 0.05, h / 2 - 0.05))
    hw, hh = w / 2 - r, h / 2 - r
    pts: list[tuple[float, float]] = []
    for ox, oy, a0 in ((hw, hh, 0), (-hw, hh, 90), (-hw, -hh, 180), (hw, -hh, 270)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90.0 * i / seg)
            pts.append((cx + ox + r * math.cos(a), cy + oy + r * math.sin(a)))
    out = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    return Polygon(out)


def local_prism(poly: Polygon, z0: float, z1: float) -> trimesh.Trimesh:
    """局部 XY 平面里的多边形，沿局部 +Z 拉伸。"""
    m = trimesh.creation.extrude_polygon(poly, height=float(z1 - z0))
    m.apply_translation((0.0, 0.0, float(z0)))
    return m


def face_prism(poly: Polygon, z0: float, z1: float, M: np.ndarray) -> trimesh.Trimesh:
    """斜面局部坐标系里的件（局部 z 同 face_frame 定义）。"""
    m = local_prism(poly, z0, z1)
    m.apply_transform(M)
    return m


def plate_xz(poly: Polygon, thick: float, y0: float) -> trimesh.Trimesh:
    """XZ 平面里的多边形，沿 +Y 拉伸 thick，背面贴到 y=y0。"""
    m = trimesh.creation.extrude_polygon(poly, height=float(thick))
    m.apply_transform(_rot("x", 90))
    m.apply_translation((0.0, thick + y0, 0.0))
    return m


def prism_yz(pts: list[tuple[float, float]], x0: float, x1: float) -> trimesh.Trimesh:
    """YZ 平面里的多边形（点序 (y,z)），沿 X 拉伸。"""
    m = trimesh.creation.extrude_polygon(Polygon(pts), height=float(abs(x1 - x0)))
    m.apply_transform(R_YZ)
    m.apply_translation((float(x0), 0.0, 0.0))
    return m


def box(x0, x1, y0, y1, z0, z1) -> trimesh.Trimesh:
    m = trimesh.creation.box(extents=(abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)))
    m.apply_translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    return m


def cyl_y(r: float, y0: float, y1: float, cx: float = 0.0, cz: float = 0.0, sections: int = 40) -> trimesh.Trimesh:
    m = trimesh.creation.cylinder(radius=float(r), height=float(abs(y1 - y0)), sections=sections)
    m.apply_transform(_rot("x", -90))
    m.apply_translation((cx, (y0 + y1) / 2, cz))
    return m


def _u(parts: list[trimesh.Trimesh]) -> trimesh.Trimesh:
    return trimesh.boolean.union(parts, engine="manifold")


# ---------------- 几何 ----------------
def dims(angle=ANGLE, face_len=FACE_LEN, z0=Z0, y0=Y0, cam_h=CAM_H, back_drop=BACK_DROP):
    t = math.radians(angle)
    z_top = z0 + face_len * math.cos(t)
    y_top = y0 + (z_top - z0) * math.tan(t)
    return z_top, y_top, z_top + back_drop


def build(angle=ANGLE, cam_w=CAM_W, cam_h=CAM_H, cam_r=CAM_R, clear=CLEAR,
          width=WIDTH, face_len=FACE_LEN, z0=Z0, y0=Y0, back_drop=BACK_DROP,
          frame_w=FRAME_W, frame_h=FRAME_H, sink=SINK) -> trimesh.Trimesh:
    """安装姿态：背板贴门面 y=0，z 向上。"""
    t = math.radians(angle)
    z_top, y_top, _ = dims(angle, face_len, z0, y0, cam_h, back_drop)
    pw, pl = cam_w + 2 * clear, cam_h + 2 * clear
    # 槽的圆角必须**小于**相机圆角：同样的边长下，圆角越大，对角方向越「往里收」，
    # 相机四个角会顶到槽角（实测 35mm³ 干涉）。
    r_in = max(2.0, cam_r - 1.0)
    r_out = r_in + frame_w + 0.5
    M = face_frame(angle, y0, z0)
    sc = face_len / 2.0

    # 1) 45° 斜面主板（材料在斜面「背后」）
    plate = face_prism(rrect(width, face_len, 6.0, 0.0, sc), 0.0, FACE_T, M)

    # 2) 相机围框：凸出 frame_h 的边框 + 沉进去 sink 的浅槽
    outer = local_prism(rrect(pw + 2 * frame_w, pl + 2 * frame_w, r_out, 0.0, sc), -frame_h, 0.0)
    inner = local_prism(rrect(pw, pl, r_in, 0.0, sc), -frame_h - 1.0, sink)
    frame = outer.difference(inner, engine="manifold")
    frame.apply_transform(M)

    # 3) 贴门背板（背面必须落在 y=0，别拿 y0 当偏置）
    back = plate_xz(
        rrect(width, z_top + back_drop, EDGE_R, 0.0, (z_top - back_drop) / 2.0),
        BACK_T, 0.0,
    )

    # 4) 顶板（封顶，同时把背板和斜面的上沿连起来）
    #    后沿必须落在背板里（BACK_T-0.5），不是 y0 —— 早期版本这里写成 y0-0.5，
    #    结果顶板和背板之间留了一条 3.5mm 的缝，STL 上真的能看到。
    top = box(-width / 2, width / 2, BACK_T - 0.5, y_top + 0.5, z_top - TOP_T, z_top)

    # 5) 三角加强筋 + 内肋（肋放两边，中间留给走线）
    #    筋必须一路搭到背板（y≈BACK_T），否则斜面只剩顶板一条连接 —— v1 就是这样，
    #    筋背面悬在离门 4mm 处，等于没受力。
    #    筋顶部故意超出 z_top 一点（最后统一切平）；后沿插进背板 1.5mm，
    #    别和顶板后沿（y=BACK_T-0.5）落在同一张平面上，否则 union 会留内部面。
    solid = _u([plate, frame, back, top])
    z_over = z_top + 2.0
    y_over = y0 + (z_over - z0) * math.tan(t)
    y_back = BACK_T - 1.5
    tri = [(y0, z0), (y_back, z0), (y_back, z_over), (y_over, z_over)]
    ribs = [prism_yz(tri, sx - GUSSET_T / 2, sx + GUSSET_T / 2) for sx in (-GUSSET_X, GUSSET_X)]
    ribs += [prism_yz(tri, sx - RIB_T / 2, sx + RIB_T / 2) for sx in (-RIB_X, RIB_X)]
    solid = _u([solid, *ribs])

    # 6) 出线缺口：切穿围框下沿和主板下沿，线从相机底边直接进腔体
    notch = box(-CABLE_W / 2, CABLE_W / 2, -1.0, sink + 10.0, -frame_h - 2.0, FACE_T + 2.0)
    notch.apply_transform(M)

    cut = [notch]

    # 7) 螺丝孔（可选：不想贴胶就拧两颗自攻），内腔侧留沉头
    for zc in (6.0, z_top - 16.0):
        cut.append(cyl_y(4.3 / 2, -1.0, 6.0, 0.0, zc))
        cut.append(cyl_y(9.0 / 2, 2.4, 5.0, 0.0, zc))

    solid = solid.difference(_u(cut), engine="manifold")

    # 8) 顶部切平（斜面板的背面会顶出 z_top 一点，切掉才平）
    solid = solid.difference(box(-500, 500, -500, 500, z_top, z_top + 500), engine="manifold")
    return solid


def camera_mock(angle=ANGLE, cam_w=CAM_W, cam_h=CAM_H, cam_r=CAM_R, cam_d=CAM_D,
                clear=CLEAR, face_len=FACE_LEN, z0=Z0, y0=Y0, sink=SINK,
                tape=TAPE) -> trimesh.Trimesh:
    """相机占位体（只用于预览与干涉检查，不打印）。"""
    M = face_frame(angle, y0, z0)
    poly = rrect(cam_w, cam_h, cam_r, 0.0, face_len / 2.0)
    return face_prism(poly, sink - tape - cam_d, sink - tape, M)


def to_print_pose(part: trimesh.Trimesh) -> trimesh.Trimesh:
    """背板贴床、斜面朝上（唯一免支撑的摆法）。"""
    part.apply_transform(_rot("x", 90))
    part.apply_translation((0.0, 0.0, -part.bounds[0][2]))
    return part


# ---------------- 报告 ----------------
def overhang_report(mesh: trimesh.Trimesh) -> tuple[float, float]:
    """返回（需要支撑的面积 mm², 朝下表面里最平的那个角度）。

    角度按「面与水平面的夹角」算：45° 及以上免支撑，越小越需要支撑。
    贴床面（z≈0）不算——它本来就架在热床上。
    """
    n = mesh.face_normals
    a = mesh.area_faces
    top_z = mesh.vertices[mesh.faces][:, :, 2].max(axis=1)
    down = (n[:, 2] < -1e-6) & (top_z > 0.6)
    if not down.any():
        return 0.0, 90.0
    ang = np.degrees(np.arccos(np.clip(-n[down, 2], -1.0, 1.0)))
    area = float(a[down][ang < 44.0].sum())
    return area, float(ang.min())


def report(name: str, part: trimesh.Trimesh) -> None:
    ext = part.extents
    print(f"{name}: {ext[0]:.1f} x {ext[1]:.1f} x {ext[2]:.1f} mm")
    print(
        f"  watertight={part.is_watertight} volume={part.volume / 1000:.1f} cm3 "
        f"PETG~{part.volume / 1000 * 1.27:.0f} g solid"
    )
    area, worst = overhang_report(part)
    print(f"  最平朝下面 {worst:.0f}°（≥45° 免支撑）  需支撑面积 {area:.0f} mm2")


def main() -> int:
    ap = argparse.ArgumentParser(description="Zmodo 窗户摄像机 45° 门挂转接板")
    ap.add_argument("--angle", type=float, default=ANGLE, help="俯角（相对水平），默认 45")
    ap.add_argument("--cam-w", type=float, default=CAM_W)
    ap.add_argument("--cam-h", type=float, default=CAM_H)
    ap.add_argument("--cam-r", type=float, default=CAM_R, help="相机正面圆角")
    ap.add_argument("--clear", type=float, default=CLEAR, help="单边配合间隙")
    ap.add_argument("--width", type=float, default=WIDTH)
    ap.add_argument("--face-len", type=float, default=FACE_LEN)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    mount = build(args.angle, args.cam_w, args.cam_h, args.cam_r, args.clear,
                  args.width, args.face_len)
    cam = camera_mock(args.angle, args.cam_w, args.cam_h, args.cam_r,
                      clear=args.clear, face_len=args.face_len)

    z_top, y_top, _ = dims(args.angle, args.face_len)
    inter = mount.intersection(cam, engine="manifold")
    print(f"角度 {args.angle:g}°  斜面 {args.face_len:g} mm  "
          f"高 {z_top:.1f} 深 {y_top:.1f}  相机下沉 {SINK:.1f} mm")
    print(f"相机干涉体积 = {inter.volume:.3f} mm3（应为 0）")

    name = args.out or "zmodo-45-door-mount.stl"
    pose = to_print_pose(mount.copy())
    report(name, pose)
    pose.export(name)

    cam.export("zmodo-camera-mock.stl")
    print("zmodo-camera-mock.stl（量具，别打印）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
