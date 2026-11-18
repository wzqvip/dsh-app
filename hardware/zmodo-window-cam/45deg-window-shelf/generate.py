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
BRACKET_DROP = 16.0 # 背板在斜面顶端以下延伸多少。**不能再低**：罩子顶壁在 y=5 处
                    # 已经到 z≈51.6，背板下沿必须让开它（原来是 22，即 z=48，会撞）
BRACKET_RISE = 8.0  # 背板在斜面顶端以上延伸多少（给胶面积和打印底面积）
PLATE_INSET = 1.5   # 斜面顶端插进背板里的量（让接缝是实体重叠，不是刀口对刀口）

WIN_W = 38.0        # 镜头窗口
WIN_H = 38.0
WIN_R = 10.0
STOP_L = 5.0        # 上沿挡边：沿斜面长度
STOP_H = 5.0        # 上沿挡边：凸出高度
STOP_INSET = 1.0    # 挡边插进背板里的量

TIE_SLOT_W = 2.6    # 扎带孔（两侧各一个，扎带兜住相机背面）
TIE_SLOT_L = 5.0
TIE_SLOT_X = 32.0

# 遮光罩：把视线从窗口一路包到玻璃上，室内光进不来 → 玻璃上没有室内反光
HOOD_WALL = 3.0     # 罩壁厚（太薄会漏光，也不算打印件）
HOOD_MARGIN = 3.5   # 罩口比视锥落点再外扩，避免罩口自己切边
FOV_H = 46.0        # 视锥水平半角（遮光罩按这个开喇叭口；也用于视线自检）
FOV_V = 26.0        # 视锥垂直半角


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


def box(x0, x1, y0, y1, z0, z1) -> trimesh.Trimesh:
    m = trimesh.creation.box(extents=(abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)))
    m.apply_translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
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

    # 2) 上沿挡边：相机沿斜面往下滑（重力分量）时顶住它；上端插进背板 1mm，
    #    底面再扎进斜面板 1mm —— 只"贴着"会留下共面内壁，STL 会多出洞来。
    stop_cy = STOP_L / 2.0 - STOP_INSET
    stop = face_prism(rrect(plate_w, STOP_L, 2.0, 0.0, stop_cy), -1.0, STOP_H, M)

    # 3) 贴门背板 —— 只在斜面上方/背后一条，绝不伸进视锥
    bracket = plate_xz(
        rrect(W, bracket_drop + bracket_rise, 6.0, 0.0, (z_bracket_top + z_bot) / 2.0),
        BRACKET_T, 0.0,
    )

    # 4) 两侧扎带孔：相机贴好之后，还能用一根扎带从背面兜一道（防胶失效掉下来）
    slots = [box(sx - TIE_SLOT_W / 2, sx + TIE_SLOT_W / 2,
                 cam_c - TIE_SLOT_L / 2, cam_c + TIE_SLOT_L / 2,
                 -PLATE_T - 1.0, 1.0) for sx in (-TIE_SLOT_X, TIE_SLOT_X)]
    slots = [s.apply_transform(M) for s in slots]

    solid = _u([plate, stop, bracket])
    cut = [face_prism(rrect(win_w, win_h, win_r, 0.0, mid), -PLATE_T * 3, 40.0, M), *slots]
    solid = solid.difference(_u(cut), engine="manifold")
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


# ---------------- 遮光罩 ----------------
def rrect_pts(w: float, h: float, r: float, seg: int = 8) -> np.ndarray:
    """圆角矩形的 N 个顶点（不重复首点）。放样时两边点数必须一致。"""
    r = max(0.2, min(r, w / 2 - 0.05, h / 2 - 0.05))
    hw, hh = w / 2 - r, h / 2 - r
    pts = []
    for ox, oy, a0 in ((hw, hh, 0), (-hw, hh, 90), (-hw, -hh, 180), (hw, -hh, 270)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90.0 * i / seg)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return np.array(pts[:-1])          # 最后一点 = 第一点，去掉


def plate_loop(M: np.ndarray, z_local: float, w: float, h: float, r: float,
               cy: float) -> np.ndarray:
    pts = rrect_pts(w, h, r)
    p = np.column_stack([pts[:, 0], cy + pts[:, 1], np.full(len(pts), z_local),
                         np.ones(len(pts))])
    return (p @ M.T)[:, :3]


def door_loop(cx: float, cz: float, w: float, h: float, r: float) -> np.ndarray:
    """门面（y=0）上的环。点序反过来 —— 这样它和斜面环在世界里同向，
    放样出来的侧面才不会扭成蝴蝶结（扭了体积会只有 1/7，而且 STL 照样"水密"）。"""
    pts = rrect_pts(w, h, r)[::-1]
    return np.column_stack([cx + pts[:, 0], np.zeros(len(pts)), cz + pts[:, 1]])


def _angle_order(pts: np.ndarray, axis: np.ndarray, origin: np.ndarray) -> np.ndarray:
    """按绕轴的角度给出点的顺序（index）。

    两个环分别在不同平面里生成，点序的起始位置和方向都不一样；直接按 index 配对
    会把放样拧成蝴蝶结。**而且内环必须沿用外环的配对** —— 各自按自己的角度排，
    内壁和外壁的对应点会错开，壁厚在某些角上被夹到 0，布尔差集就会在那里挖出
    小洞（Euler 数从 0 掉到 −2，切片器看到的就是"破面"）。
    """
    axis = axis / np.linalg.norm(axis)
    ref = np.array([0.0, 0.0, 1.0])
    if abs(ref @ axis) > 0.9:
        ref = np.array([1.0, 0.0, 0.0])
    e1 = np.cross(ref, axis)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(axis, e1)
    v = pts - origin
    return np.argsort(np.arctan2(v @ e2, v @ e1))


def shell(a_out: np.ndarray, b_out: np.ndarray, a_in: np.ndarray, b_in: np.ndarray,
          order: np.ndarray) -> trimesh.Trimesh:
    """直接拼出闭合的「管壁」：外壁 + 内壁（反向）+ 两道端面。

    不走「外实体 − 内实体」：两个端面共面时，差集会在端面上切出一堆退化三角
    （实测 34 个零面积面），切片器就报破面。拼壳体没有布尔，也就没有这个风险。
    """
    A, B, Ai, Bi = (np.asarray(x)[order] for x in (a_out, b_out, a_in, b_in))
    n = len(A)
    V = np.vstack([A, B, Ai, Bi])
    oA, oB, iA, iB = 0, n, 2 * n, 3 * n
    F = []
    for i in range(n):
        j = (i + 1) % n
        F += [[oA + i, oA + j, oB + j], [oA + i, oB + j, oB + i]]    # 外壁
        F += [[iA + i, iB + j, iA + j], [iA + i, iB + i, iB + j]]    # 内壁（反向）
        F += [[oA + i, iA + i, iA + j], [oA + i, iA + j, oA + j]]    # 窗口端面
        F += [[oB + i, oB + j, iB + j], [oB + i, iB + j, iB + i]]    # 罩口端面
    m = trimesh.Trimesh(V, F, process=True)
    if m.volume < 0:
        m.invert()
    return m


def mouth_rect(angle=ANGLE, fov_h=FOV_H, fov_v=FOV_V, margin=HOOD_MARGIN):
    """罩口在门面上的范围：半宽 hx、z0..z1（保证不切视锥）。"""
    hits = sight_window(angle, fov_h, fov_v)
    hx = float(max(abs(hits[:, 0].min()), abs(hits[:, 0].max()))) + margin
    return hx, float(hits[:, 2].min()) - margin, float(hits[:, 2].max()) + margin


def build_hood(angle=ANGLE, wall=HOOD_WALL, margin=HOOD_MARGIN,
               fov_h=FOV_H, fov_v=FOV_V) -> trimesh.Trimesh:
    """把窗口和玻璃之间整段视线包起来的罩子（安装姿态，y=0 是玻璃面）。"""
    M = plate_frame(angle, Y0, Z_TOP)
    cam_c = STOP_L - STOP_INSET + CAM_W / 2.0
    # 留 0.15mm 缝：严格共面的布尔（罩子端面和斜面背面）会算出一层薄薄的"干涉"，
    # 这点缝刚好给胶用。
    z_back = -PLATE_T - 0.15
    hx, z0, z1 = mouth_rect(angle, fov_h, fov_v, margin)

    a_in = plate_loop(M, z_back, WIN_W - 0.4, WIN_H - 0.4, WIN_R - 0.4, cam_c)
    a_out = plate_loop(M, z_back, WIN_W + 2 * wall, WIN_H + 2 * wall, WIN_R + wall, cam_c)
    b_in = door_loop(0.0, (z0 + z1) / 2, 2 * hx, z1 - z0, 12.0)
    b_out = door_loop(0.0, (z0 + z1) / 2, 2 * hx + 2 * wall, z1 - z0 + 2 * wall, 12.0 + wall)

    # 内外两层用**同一套配对**（由外环算），壁厚才处处一致
    order = _angle_order(a_out, b_out.mean(0) - a_out.mean(0), a_out.mean(0))
    return shell(a_out, b_out, a_in, b_in, order)


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


def topology(mesh: trimesh.Trimesh) -> tuple[int, int, int]:
    """拓扑体检：(非流形边数, Euler 数, 退化成零面积的面数)。

    Euler 数是判断"破面"最直接的指标：实心件 = 2；每多一个贯穿的洞就 −2。
    对不上就说明有共面内壁或壁厚被夹断 —— STL 照样报 watertight，切片器却会报错。
    """
    e = np.sort(mesh.edges, axis=1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    return int((cnt != 2).sum()), int(mesh.euler_number), int((mesh.area_faces < 1e-9).sum())


def report(name: str, part: trimesh.Trimesh, holes: int = 0) -> None:
    ext = part.extents
    nm, euler, degen = topology(part)
    print(f"{name}: {ext[0]:.1f} x {ext[1]:.1f} x {ext[2]:.1f} mm")
    print(f"  watertight={part.is_watertight} winding={part.is_winding_consistent} "
          f"volume={part.volume / 1000:.1f} cm3 PETG~{part.volume / 1000 * 1.27:.0f} g solid")
    print(f"  拓扑：非流形边 {nm}（应 0）、退化面 {degen}（应 0）、"
          f"Euler {euler}（应 {2 - 2 * holes}，即 {holes} 个贯穿洞）")
    area, worst = overhang_report(part)
    print(f"  最平朝下面 {worst:.0f}°（≥45° 免支撑）  需支撑面积 {area:.0f} mm2")


def main() -> int:
    ap = argparse.ArgumentParser(description="Zmodo 窗户摄像机 45° 过窗俯视支架 + 遮光罩")
    ap.add_argument("--angle", type=float, default=ANGLE)
    ap.add_argument("--cam-w", type=float, default=CAM_W)
    ap.add_argument("--cam-h", type=float, default=CAM_H)
    ap.add_argument("--cam-r", type=float, default=CAM_R)
    ap.add_argument("--win", type=float, default=WIN_W, help="镜头窗口边长")
    ap.add_argument("--plate-l", type=float, default=PLATE_L)
    ap.add_argument("--out", default="zmodo-45-window-shelf.stl")
    ap.add_argument("--hood-out", default="zmodo-light-hood.stl")
    args = ap.parse_args()

    mount = build(args.angle, args.cam_w, args.cam_h, args.cam_r,
                  win_w=args.win, win_h=args.win, plate_l=args.plate_l)
    cam = camera_mock(args.angle, args.cam_w, args.cam_h, args.cam_r, plate_l=args.plate_l)
    hood = build_hood(args.angle)

    k = key_points(args.angle, args.plate_l)
    hits = sight_window(args.angle)
    inter = mount.intersection(cam, engine="manifold")
    n_blocked, blocked = sight_check(mount, args.angle)
    n_hood, hood_blocked = sight_check(hood, args.angle)
    z_bot = k["z_bracket_bottom"]
    hx, z0, z1 = mouth_rect(args.angle)
    clash = mount.intersection(hood, engine="manifold")

    print(f"角度 {args.angle:g}°   斜面 {args.plate_l:g} mm   背板 z {z_bot:.1f}..{Z_TOP + BRACKET_RISE:.1f}")
    print(f"镜头中心 (y={k['lens'][1]:.1f}, z={k['lens'][2]:.1f})，"
          f"轴线在门面上 z={k['hit'][2]:.1f}")
    print(f"需要的透明区域：左右各 {max(abs(hits[:, 0].min()), abs(hits[:, 0].max())):.0f} mm，"
          f"在背板下沿再往下 {z_bot - hits[:, 2].max():.0f}…{z_bot - hits[:, 2].min():.0f} mm")
    print(f"遮光罩罩口：{2 * hx:.0f} × {z1 - z0:.0f} mm，"
          f"z {z0:.0f}..{z1:.0f}（背板下沿 {z_bot:.0f}）")
    print(f"相机干涉 = {inter.volume:.3f} mm3（应为 0）")
    print(f"视线：支架挡 {n_blocked} 条（应为 0）；"
          f"罩子挡 {n_hood} 条 {hood_blocked if hood_blocked else ''}"
          f"（预期只有四角 —— 画面四角会是罩壁，暗的）")
    print(f"支架与罩子是否互相插进去（应为 0）：{clash.volume:.2f} mm3")

    pose = to_print_pose(mount.copy())
    report(args.out, pose, holes=3)
    pose.export(args.out)

    hood_pose = hood.copy()
    hood_pose.apply_transform(_rot("x", args.angle))
    hood_pose.apply_translation((0.0, 0.0, -hood_pose.bounds[0][2]))
    report(args.hood_out, hood_pose, holes=1)
    hood_pose.export(args.hood_out)

    cam.export("zmodo-camera-mock.stl")
    print("zmodo-camera-mock.stl（量具，别打印）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

