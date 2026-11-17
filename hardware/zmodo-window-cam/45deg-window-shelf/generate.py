#!/usr/bin/env python3
"""Zmodo 窗户摄像机 —— 45° 过窗俯视支架（v2）

v1 的拓扑是错的，这版推倒重来
------------------------------
这台相机的**贴胶面就是镜头面**：胶贴在镜头那一面、镜头隔着玻璃往外拍。
所以不存在「相机吊在楔形件下面」这回事 —— 真正的约束是：

    相机要**透过**它贴着的那块面看出去。

于是：

    · 楔形件在相机**下面**，后背面贴门、斜面向室内方向一路降下去；
    · 相机的镜头面**坐在** 45° 斜面上；
    · 斜面正中开窗口 → 镜头透过窗口 → 空气 → 门的玻璃 → 门外地面；
    · 楔形件背后**必须是空的**（不能有背板、不能有筋挡在视锥里），
      否则镜头看到的就是塑料 —— 所以它是个「罩子」不是实心块。

    侧面（门在左，y 朝室内，z 向上）：

      门 │█╲  ← 贴门背板（只占上边一条，胶贴玻璃）
         │█ ╲
         │█  ╲ ← 45° 斜面（相机坐在上面，镜头朝下穿过去）
         │█   ╲
         │     ╲  ← 这一段必须全空，视线从这里穿到玻璃
         └──────╲

脚本会核对三件事：相机与支架不干涉、**九条视线射线都不被挡**、
打印不需要支撑。

用法：
    python generate.py
    python generate.py --angle 40
    python generate.py --cam-w 58 --cam-h 58 --win 40
"""

from __future__ import annotations

import argparse
import math

import numpy as np
import trimesh
from shapely.geometry import Polygon

# ---------------- 标称尺寸（mm） ----------------
CAM_W = 58.0        # 官方 2.28 inch
CAM_H = 58.0
CAM_D = 30.0        # 1.18 inch
CAM_R = 12.0        # 正面圆角（按图片估）

ANGLE = 45.0        # 俯角（相对水平；门竖直时 = 镜头轴线与水平面夹角）
W = 74.0            # 贴门背板宽
PLATE_W = 70.0      # 45° 斜面宽
PLATE_L = 66.0      # 45° 斜面长（沿斜面）
PLATE_T = 4.0       # 斜面厚
Z_TOP = 70.0        # 斜面顶端（靠门那端）的高度
Y0 = 5.0            # 斜面顶端离门面的距离 = 背板厚
BRACKET_T = 5.0     # 贴门背板厚
BRACKET_DROP = 22.0 # 背板在斜面顶端以下延伸多少（不能再低，会进视锥）
BRACKET_RISE = 8.0  # 背板在斜面顶端以上延伸多少（给胶面积和打印底面积）
PLATE_INSET = 1.5   # 斜面顶端插进背板里的量（让接缝是实体重叠，不是刀口对刀口）

WIN_W = 38.0        # 镜头窗口
WIN_H = 38.0
WIN_R = 10.0
STOP_L = 4.0        # 上沿挡边：沿斜面长度
STOP_H = 4.0        # 上沿挡边：凸出高度
STOP_INSET = 1.0    # 挡边插进背板里的量

GUSSET_T = 3.0      # 两侧三角筋厚
GUSSET_X = 33.0     # 两侧三角筋中心 x（外表面离板边 0.5mm，避免共面）

FOV_H = 50.0        # 视锥水平半角（用于视线自检）
FOV_V = 30.0        # 视锥垂直半角


# ---------------- 变换 ----------------
def _rot(axis: str, deg: float) -> np.ndarray:
    return trimesh.transformations.rotation_matrix(
        math.radians(deg), [int(axis == "x"), int(axis == "y"), int(axis == "z")]
    )


def plate_frame(angle: float, y0: float, z_top: float) -> np.ndarray:
    """斜面局部坐标系 → 世界。

    局部 x = 世界 X（宽度）
    局部 y = 沿斜面「向下」（离开门）= (0, sinθ, -cosθ)
    局部 z = 斜面外法线（朝相机）= (0, cosθ, sinθ)；材料在 z<0 一侧
    """
    t = math.radians(angle)
    s, c = math.sin(t), math.cos(t)
    M = np.eye(4)
    M[:3, 0] = (1.0, 0.0, 0.0)
    M[:3, 1] = (0.0, s, -c)
    M[:3, 2] = (0.0, c, s)
    M[:3, 3] = (0.0, y0, z_top)
    return M


# ---------------- 基本体 ----------------
def rrect(w: float, h: float, r: float, cx: float = 0.0, cy: float = 0.0, seg: int = 8) -> Polygon:
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
    m = trimesh.creation.extrude_polygon(poly, height=float(z1 - z0))
    m.apply_translation((0.0, 0.0, float(z0)))
    return m


def face_prism(poly: Polygon, z0: float, z1: float, M: np.ndarray) -> trimesh.Trimesh:
    m = local_prism(poly, z0, z1)
    m.apply_transform(M)
    return m


def plate_xz(poly: Polygon, thick: float, y0: float) -> trimesh.Trimesh:
    m = trimesh.creation.extrude_polygon(poly, height=float(thick))
    m.apply_transform(_rot("x", 90))
    m.apply_translation((0.0, thick + y0, 0.0))
    return m


def prism_yz(pts: list[tuple[float, float]], x0: float, x1: float) -> trimesh.Trimesh:
    m = trimesh.creation.extrude_polygon(Polygon(pts), height=float(abs(x1 - x0)))
    m.apply_transform(np.array([[0.0, 0.0, 1.0, 0.0], [1.0, 0.0, 0.0, 0.0],
                                [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]))
    m.apply_translation((float(x0), 0.0, 0.0))
    return m


def _u(parts: list[trimesh.Trimesh]) -> trimesh.Trimesh:
    return trimesh.boolean.union(parts, engine="manifold")


# ---------------- 关键几何 ----------------
def key_points(angle=ANGLE, plate_l=PLATE_L, y0=Y0, z_top=Z_TOP, stop_l=STOP_L, stop_inset=STOP_INSET):
    """返回几个做检查和标注都用得上的点（世界坐标）。"""
    t = math.radians(angle)
    M = plate_frame(angle, y0, z_top)
    cam_c = stop_l - stop_inset + CAM_W / 2.0          # 相机中心沿斜面的位置
    to_world = lambda x, y, z: (M @ np.array([x, y, z, 1.0]))[:3]
    lower = to_world(0.0, plate_l, 0.0)                # 斜面最低点
    lens = to_world(0.0, cam_c, 0.0)                   # 镜头中心
    axis = np.array([0.0, -math.cos(t), -math.sin(t)])  # 镜头朝向（透过去）
    t_hit = lens[1] / math.cos(t)
    hit = lens + axis * t_hit                          # 与门面（y=0）的交点
    return dict(M=M, lens=lens, axis=axis, hit=hit, lower=lower, cam_c=cam_c,
                z_bracket_bottom=z_top - BRACKET_DROP)


def sight_window(angle=ANGLE, fov_h=FOV_H, fov_v=FOV_V, t_max=300.0):
    """轴线 + 四条视锥边界射线在门面上的落点 → 需要多大一块透明区域。

    注意只取「上下左右四条边界」，不取四角：45° 斜看时四角射线几乎与门面平行
    （落点会跑到几百毫米外），现实中会被门/窗框裁掉 —— 这是透视窗效应，
    不是支架能解决的，README 里单独说明。
    """
    k = key_points(angle)
    R = k["M"][:3, :3]
    lens = k["lens"]
    pts = []
    for h, v in ((0.0, 0.0), (fov_h, 0.0), (-fov_h, 0.0), (0.0, fov_v), (0.0, -fov_v)):
        d = np.array([math.sin(math.radians(h)) * math.cos(math.radians(v)),
                      math.sin(math.radians(v)),
                      -math.cos(math.radians(h)) * math.cos(math.radians(v))])
        d = R @ d
        if abs(d[1]) < 1e-6:
            continue
        tt = lens[1] / (-d[1])
        if 0.0 < tt < t_max:
            pts.append(lens + d * tt)
    return np.array(pts)


def build(angle=ANGLE, cam_w=CAM_W, cam_h=CAM_H, cam_r=CAM_R,
          plate_w=PLATE_W, plate_l=PLATE_L, z_top=Z_TOP, y0=Y0,
          win_w=WIN_W, win_h=WIN_H, win_r=WIN_R,
          bracket_drop=BRACKET_DROP, bracket_rise=BRACKET_RISE) -> trimesh.Trimesh:
    """安装姿态：背板贴门面 y=0，z 向上。"""
    t = math.radians(angle)
    M = plate_frame(angle, y0, z_top)
    cam_c = STOP_L - STOP_INSET + cam_w / 2.0
    mid = cam_c                                  # 窗口对准镜头中心
    z_bot = z_top - bracket_drop
    z_bracket_top = z_top + bracket_rise
    lower_y = y0 + plate_l * math.sin(t)         # 斜面最低点的 y/z
    lower_z = z_top - plate_l * math.cos(t)

    # 1) 45° 斜面（材料在相机面背后）
    plate = face_prism(
        rrect(plate_w, plate_l + PLATE_INSET, 6.0, 0.0, (plate_l - PLATE_INSET) / 2.0),
        -PLATE_T, 0.0, M,
    )

    # 2) 上沿挡边：相机沿斜面往下滑（重力分量）时顶住它；上端插进背板 1mm
    stop_cy = STOP_L / 2.0 - STOP_INSET
    stop = face_prism(rrect(plate_w, STOP_L, 2.0, 0.0, stop_cy), 0.0, STOP_H, M)

    # 3) 贴门背板 —— 只在斜面上方/背后一条，绝不伸进视锥
    bracket = plate_xz(
        rrect(W, bracket_drop + bracket_rise, 6.0, 0.0, (z_bracket_top + z_bot) / 2.0),
        BRACKET_T, 0.0,
    )

    # 4) 两侧三角筋：从背板一直撑到斜面下沿（在 x=±33，挡不到中央视线）
    z_at_back = z_top + (y0 - (BRACKET_T - 0.5)) / math.tan(t)   # 斜面表面在 y=BACK-0.5 处的高度
    tri = [(BRACKET_T - 0.5, z_bot), (lower_y, lower_z), (BRACKET_T - 0.5, z_at_back)]
    ribs = [prism_yz(tri, sx - GUSSET_T / 2, sx + GUSSET_T / 2)
            for sx in (-GUSSET_X, GUSSET_X)]

    solid = _u([plate, stop, bracket, *ribs])

    # 5) 镜头窗口（切穿斜面）
    window = face_prism(rrect(win_w, win_h, win_r, 0.0, mid), -PLATE_T * 3, 40.0, M)
    solid = solid.difference(window, engine="manifold")
    return solid


def camera_mock(angle=ANGLE, cam_w=CAM_W, cam_h=CAM_H, cam_r=CAM_R, cam_d=CAM_D,
                plate_l=PLATE_L, z_top=Z_TOP, y0=Y0) -> trimesh.Trimesh:
    """相机占位体（只用于预览/干涉/视线检查，不打印）。"""
    M = plate_frame(angle, y0, z_top)
    cam_c = STOP_L - STOP_INSET + cam_w / 2.0
    poly = rrect(cam_w, cam_h, cam_r, 0.0, cam_c)
    return face_prism(poly, 0.05, cam_d, M)       # 机身站在斜面「外面」，脸贴斜面（留 0.05 防共面）


def to_print_pose(part: trimesh.Trimesh) -> trimesh.Trimesh:
    """贴门背板朝下（背板背面 = 胶面 = 热床面，最平）。"""
    part.apply_transform(_rot("x", 90))
    part.apply_translation((0.0, 0.0, -part.bounds[0][2]))
    return part


# ---------------- 自检 ----------------
def _ray_hits(mesh: trimesh.Trimesh, origin: np.ndarray, direction: np.ndarray,
              t_min: float = 0.1, t_max: float = 400.0) -> bool:
    """单条射线是否打到网格（Möller–Trumbore，向量化到所有三角面）。

    不用 trimesh 的 ray.intersects_any：那玩意儿依赖 rtree/pyembree，
    本机没装，为了一个自检去拉依赖不值当。
    """
    F = mesh.faces
    v0 = mesh.vertices[F[:, 0]]
    e1 = mesh.vertices[F[:, 1]] - v0
    e2 = mesh.vertices[F[:, 2]] - v0
    d = direction / np.linalg.norm(direction)
    h = np.cross(d, e2)
    a = np.einsum("ij,ij->i", e1, h)
    ok = np.abs(a) > 1e-9
    f = np.where(ok, 1.0 / np.where(ok, a, 1.0), 0.0)
    s = origin - v0
    u = f * np.einsum("ij,ij->i", s, h)
    q = np.cross(s, e1)
    v = f * np.einsum("ij,j->i", q, d)
    t = f * np.einsum("ij,ij->i", e2, q)
    hit = ok & (u >= 0.0) & (v >= 0.0) & (u + v <= 1.0) & (t > t_min) & (t < t_max)
    return bool(hit.any())


def sight_check(mount: trimesh.Trimesh, angle=ANGLE) -> tuple[int, list]:
    k = key_points(angle)
    R = k["M"][:3, :3]
    lens = k["lens"] + 0.4 * (R @ np.array([0.0, 0.0, 1.0]))   # 从镜头面外 0.4mm 起算
    rays = [(0.0, 0.0)]
    for h in (-FOV_H, 0.0, FOV_H):
        for v in (-FOV_V, 0.0, FOV_V):
            if (h, v) != (0.0, 0.0):
                rays.append((h, v))
    blocked: list = []
    for h, v in rays:
        d = np.array([math.sin(math.radians(h)) * math.cos(math.radians(v)),
                      math.sin(math.radians(v)),
                      -math.cos(math.radians(h)) * math.cos(math.radians(v))])
        if _ray_hits(mount, lens, R @ d):
            blocked.append((h, v))
    return len(blocked), blocked


def overhang_report(mesh: trimesh.Trimesh) -> tuple[float, float]:
    n = mesh.face_normals
    a = mesh.area_faces
    top_z = mesh.vertices[mesh.faces][:, :, 2].max(axis=1)
    down = (n[:, 2] < -1e-6) & (top_z > 0.6)
    if not down.any():
        return 0.0, 90.0
    ang = np.degrees(np.arccos(np.clip(-n[down, 2], -1.0, 1.0)))
    return float(a[down][ang < 44.0].sum()), float(ang.min())


def report(name: str, part: trimesh.Trimesh) -> None:
    ext = part.extents
    print(f"{name}: {ext[0]:.1f} x {ext[1]:.1f} x {ext[2]:.1f} mm")
    print(f"  watertight={part.is_watertight} volume={part.volume / 1000:.1f} cm3 "
          f"PETG~{part.volume / 1000 * 1.27:.0f} g solid")
    area, worst = overhang_report(part)
    print(f"  最平朝下面 {worst:.0f}°（≥45° 免支撑）  需支撑面积 {area:.0f} mm2")


def main() -> int:
    ap = argparse.ArgumentParser(description="Zmodo 窗户摄像机 45° 过窗俯视支架")
    ap.add_argument("--angle", type=float, default=ANGLE)
    ap.add_argument("--cam-w", type=float, default=CAM_W)
    ap.add_argument("--cam-h", type=float, default=CAM_H)
    ap.add_argument("--cam-r", type=float, default=CAM_R)
    ap.add_argument("--win", type=float, default=WIN_W, help="镜头窗口边长")
    ap.add_argument("--plate-l", type=float, default=PLATE_L)
    ap.add_argument("--out", default="zmodo-45-window-shelf.stl")
    args = ap.parse_args()

    mount = build(args.angle, args.cam_w, args.cam_h, args.cam_r,
                  win_w=args.win, win_h=args.win, plate_l=args.plate_l)
    cam = camera_mock(args.angle, args.cam_w, args.cam_h, args.cam_r, plate_l=args.plate_l)

    k = key_points(args.angle, args.plate_l)
    hits = sight_window(args.angle)
    inter = mount.intersection(cam, engine="manifold")
    n_blocked, blocked = sight_check(mount, args.angle)
    z_bot = k["z_bracket_bottom"]

    print(f"角度 {args.angle:g}°   斜面 {args.plate_l:g} mm   背板 z {z_bot:.1f}..{Z_TOP + BRACKET_RISE:.1f}")
    print(f"镜头中心 (y={k['lens'][1]:.1f}, z={k['lens'][2]:.1f})，"
          f"轴线在门面上 z={k['hit'][2]:.1f}")
    print(f"需要的透明区域：左右各 {max(abs(hits[:, 0].min()), abs(hits[:, 0].max())):.0f} mm，"
          f"在背板下沿再往下 {z_bot - hits[:, 2].max():.0f}…{z_bot - hits[:, 2].min():.0f} mm"
          f"（否则画面下半部会看到门板）")
    print(f"相机干涉 = {inter.volume:.3f} mm3（应为 0）；"
          f"视线被挡 = {n_blocked} 条（应为 0）{blocked if blocked else ''}")

    pose = to_print_pose(mount.copy())
    report(args.out, pose)
    pose.export(args.out)
    cam.export("zmodo-camera-mock.stl")
    print("zmodo-camera-mock.stl（量具，别打印）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
