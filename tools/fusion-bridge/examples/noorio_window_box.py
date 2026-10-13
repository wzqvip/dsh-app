# -*- coding: utf-8 -*-
"""Noorio 球机 —— 窗户挂盒 WindowBox（前面圆柱 + 后面半圆球，单件）。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

# 形状（用户指定："前面圆柱后面半圆球"，"后面做一个收口"）

    前面   圆柱 R54，长 45（到球心高度为止）
    后面   半球 R54（与相机同心 R50.6）
    收口   半球在 Ø60 处截断 —— 这就是"收口"，同时是调整孔
    外圈   贴窗法兰 r54..80，整圈 360°

# 为什么这样就能"从前面塞进去"，而且不需要后盖

关键在**内腔从圆柱直接过渡到与相机同心的 R50.6 半球**：

    相机推进去 -> 球体进到半球窝里 -> 被整个半球包住
    转动        自由（球窝是同心球面，处处 0.6mm）
    平移        只有 0.6mm（半球把它兜住了）
    取出        往前拔出来（半球口在赤道 y=45 处是 Ø101.2 > Ø100）

所以相机**塞进去就到位、不会自己掉出来**（要掉只能往前，而前面贴着玻璃）。
后盖因此**完全不需要** —— 这也是用户说"后壳太厚"的正解：那 76 cm³ 的后盖
是被"从后面装"这个前提逼出来的，改成从前面装就整块消失了。

# 三个尺寸的依据

    内腔 R50.6       0.6mm/边。FDM 公差 ±0.2，0.4 会咬死
    贴窗法兰 r54..80 整圈 360° 连续连接（用户点出四片翼片连接太细）
    收口 Ø60         相机 r<30 的后段正好从这里伸出去约 5mm，方便从背后拨角度

# ⚠️ 已废弃的两个方案（都写在注释里免得重犯）

1. **球窝 + 收口唇边**：Ø98.2 的唇边要 Ø100 的球轴向挤过去 = 环向拉伸 1.8%，
   超出 PLA 弹性范围，而且整圈没开缝、壁厚 10mm，没有顺从性 —— **装不进去**。
2. **可拆后盖**：为解决上面的装配问题而做，但代价是 76 cm³ 的后盖 + 4 颗 M3。
   改成"从前面塞"之后整块不需要了。

# 打印方向

法兰朝下平放、开口朝上。外表面全是上收面、内腔朝上敞开 —— 全程无悬垂。
"""

import math
import time

import adsk.core
import adsk.fusion

MM = 0.1

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

BALL_R = 50.0
SOCKET_R = BALL_R + 0.6   # 内腔 R50.6（0.6mm/边；0.4 会被 FDM 公差咬死）
EQUATOR_Y = 45.0          # 球心高度 = 圆柱段长度

OUT_R = 55.5              # 外圆柱 / 外半球半径 -> 壁厚 4.9mm（原来是 3.4）
FRONT_R = SOCKET_R        # 前口半径（Ø101.2，相机 Ø100 进得去）

# 蜂窝镂空。⚠️ 曲面上的孔不能用"平面草图正交拉伸"：孔会切歪，而且斜着穿过
# 壁厚会啃到内腔壁面。做法改为**曲面切点平面 + 径向切**：
#
#   1. 平面用 **setByTangentAtPoint(face, point)** —— 圆柱面和半球面都能用，
#      法线就是该点的径向。
#      ⚠️ 别用 setByTangent(圆柱面, angle, XY平面)：它只对圆柱段成立，
#         半球段给不出正确切平面，孔会斜切甚至完全打空
#      ⚠️ `setByThreePoints` 在这个 Fusion 版本里完全不可用（连平凡三点都报
#         InternalValidationError），别再试它
#   2. 法线**永远朝外**，单侧拉伸只会往外切。所以把切平面朝内偏移 HEX_INSET
#      到内腔里，再单向朝外切 HEX_SPAN —— 正好穿透壁厚，只外伸 0.4mm
#      ⚠️ 对称拉伸 setDistanceExtent(True,d) 与 setAllExtent(Symmetric) 虽然
#         返回成功，但会**在对侧多打一个洞**，不用
#   3. `sketchLines.addByTwoPoints` 要的是**草图坐标**，模型坐标会生成"3D 轮廓"：
#      profiles.count 仍为 1，但拉伸时报"未找到要剪切或相交的目标实体"
#
# 行距 HEX_PITCH 沿圆周方向，每行孔数按该处外半径自动算，行间错开半格。
# 蜂窝圈位置（空 = 不打孔，实心）
# ⚠️ 原版 `WindowBox` 是**无孔实心**（用户要求）。蜂窝只在变体 `WindowBoxHex` 里，
#    由 noorio_window_box_hex.py 通过 WINDOWBOX_OVERRIDES 传入圈位置。
HEX_ROW_Y = []            # 各圈所在高度 y；[] = 实心无孔
# 浅环槽：把外柱面分段，好让每段都有自己的切平面（见下方注释）。
# 0.3mm 深，槽线落在蜂窝孔内部区域，基本看不见。原版 WindowBox 不用。
GROOVE_DEPTH = 0.3
GROOVE_HALF_W = 0.3
HEX_PITCH = 14.4          # 圆周方向孔距（≈ 24 孔 @ r55.5）
HEX_CIRCUM_R = 5.0        # 正六边形外接圆半径（对角 10mm）
HEX_INSET = 5.4           # 切平面朝内偏移量（落进内腔）
HEX_SPAN = 5.8            # 法线朝外时：单向拉伸长度 -> 覆盖 r 50.1..55.9
# 法线**朝内**时改用下面这组：平面挪到壁外，沿法线（=朝轴心）切进去。
# ⚠️ 环槽切出来的各段柱面法线会朝内，不区分的话刀会走在壁内侧、外壁打不穿
#    （上一版 90 孔只去掉 12.81 cm3、面数 257、外表面光的，就是这么废的）。
HEX_OUTSET = 1.0          # 朝内时：平面外移量 -> r = 56.5
HEX_SPAN_IN = 11.0        # 朝内时：切深 -> 覆盖 r 45.5..56.5

REAR_HOLE_R = 30.0        # 后面"收口"= Ø60 调整孔

FLANGE_R = 80.0           # 贴窗法兰外缘（整圈）
FLANGE_T = 3.0
FLANGE_CHAMFER = 1.5
TRANSITION_Y = 10.0       # 法兰背面到外圆柱的过渡结束高度
TRANSITION_R = 58.0       # 过渡起点半径

HOOK_Y0 = 35.0
HOOK_Y1 = 45.0
# ⚠️ 根部半径必须 ≥ SOCKET_R。曾写 HOOK_Z0=44 想"埋进本体"，但内腔半径是 50.6，
#    z 44..50.6 那段**不在壁里而是在内腔中** —— 挤出后直接捅进内腔撞到相机，
#    实测干涉 520.7 mm3。根部只能落在壁厚内（r 50.6..54）。
HOOK_ROOT_Z = 51.0        # 根部（略进壁内，避开内腔面 r=50.6）
HOOK_CAP_Z = 61.0         # 圆头圆心高度
HOOK_HALF_X = 7.5         # 耳片半宽 -> 外端半圆 R7.5，端点 z = 61+7.5 = 68.5
HOOK_HOLE_R = 3.0         # Ø6 安全绳孔
# 孔位放在圆头圆心：孔内缘 z=58，离壳体外表面(r=54) 有 4mm 料；
# 孔外缘到端点 4.5mm —— 两侧均衡。⚠️ 若把 CAP_Z 压到 57.5，孔内缘只剩
# 0.5mm 料，会直接捅穿进壳体内腔。
#
# 用户要求"挂钩改低一点、改小一点"：端点由 z=80 -> 68.5（低 11.5mm），
# 宽度 20 -> 15mm，厚度 18 -> 12mm，孔径 Ø8 -> Ø6。
# 凸出壳体的高度由 26mm 收到 14.5mm。

APPEARANCE = "塑料 - 粗面(白色)"

# --------------------------------------------------------------------------- #
# 变体参数：包装脚本可以先设 WINDOWBOX_OVERRIDES 再 exec 本文件
# （见 noorio_window_box_hex.py —— "从第二圈起一直排到尾部、不要挂耳"的版本）
# --------------------------------------------------------------------------- #
_OVERRIDES = globals().get("WINDOWBOX_OVERRIDES", {})
FILE_NAME = _OVERRIDES.get("file_name", "WindowBox")
HEX_ROW_Y = _OVERRIDES.get("hex_row_y", HEX_ROW_Y)
HEX_PITCH = _OVERRIDES.get("hex_pitch", HEX_PITCH)
HOOK_ENABLED = _OVERRIDES.get("hook", True)
PROJECT_NAME = "Noorio B310"


def V(v):
    return adsk.core.ValueInput.createByReal(v * MM)


report = {"steps": [], "errors": []}


def step(msg):
    report["steps"].append(msg)


def find_doc(name):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


def project_folder():
    for i in range(app.data.dataProjects.count):
        p = app.data.dataProjects.item(i)
        if p.name == PROJECT_NAME:
            return p.rootFolder
    return None


def find_appearance(name):
    for i in range(app.materialLibraries.count):
        lib = app.materialLibraries.item(i)
        try:
            found = lib.appearances.itemByName(name)
        except Exception:
            found = None
        if found is not None:
            return found
    return None


# --------------------------------------------------------------------------- #
# 文档
# --------------------------------------------------------------------------- #

doc = find_doc(FILE_NAME)
created_new = False
if doc is None:
    folder = project_folder()
    existing = None
    if folder is not None:
        for i in range(folder.dataFiles.count):
            f = folder.dataFiles.item(i)
            if f.name == FILE_NAME:
                existing = f
                break
    if existing is not None:
        doc = app.documents.open(existing, True)
        for _ in range(80):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved is not None:
                break
        step("opened existing %s" % FILE_NAME)
    else:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        created_new = True
        step("created new document")

time.sleep(0.6)
adsk.doEvents()
design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
root = design.rootComponent
report["targetDocument"] = doc.name
if not (doc.name.startswith(FILE_NAME) or doc.name.startswith("无标题")):
    report["errors"].append("identity check failed: %s" % doc.name)
    result = report
    raise SystemExit

for i in range(root.features.count - 1, -1, -1):
    feature = root.features.item(i)
    name = feature.name
    try:
        feature.deleteMe()
    except Exception as exc:
        report["errors"].append("deleteMe %s: %s" % (name, exc))
step("cleared -> features=%d bodies=%d" % (root.features.count, root.bRepBodies.count))

sketches = root.sketches
extrudes = root.features.extrudeFeatures
revolves = root.features.revolveFeatures


def xy_point(x_mm, y_mm):
    """XY 平面草图：局部 X -> 模型 X，局部 Y -> 模型 Y（绕 Y 轴旋转用这个面）。"""
    return adsk.core.Point3D.create(x_mm * MM, y_mm * MM, 0)


def xz_point(sketch, x_mm, z_mm):
    """法线沿 Y 的草图：实测局部 Y 轴指向模型 -Z。"""
    xd, yd = sketch.xDirection, sketch.yDirection
    sx = -1.0 if (xd.x + xd.y + xd.z) < 0 else 1.0
    if abs(yd.z) > 0.5:
        sy = 1.0 if yd.z > 0 else -1.0
    else:
        sy = -1.0 if (yd.x + yd.y + yd.z) < 0 else 1.0
    return adsk.core.Point3D.create(sx * x_mm * MM, sy * z_mm * MM, 0)


def revolve_profile(name, lines, splines=None, arcs=None,
                    operation=adsk.fusion.FeatureOperations.NewBodyFeatureOperation):
    """绕 Y 轴旋转一个闭合轮廓。

    ⚠️ 轮廓由多段曲线首尾相接拼成，**接点必须逐位相同**。已经踩过三次
    "改了一个常量、接点没跟着改、轮廓差零点几毫米断开"的坑，所以相邻段的
    接点一律写成对上一段端点的引用，不要重复抄数字。
    """
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xYConstructionPlane, V(0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    sketch.name = name
    for (p1, p2) in lines:
        sketch.sketchCurves.sketchLines.addByTwoPoints(xy_point(*p1), xy_point(*p2))
    for points in (splines or []):
        collection = adsk.core.ObjectCollection.create()
        for p in points:
            collection.add(xy_point(*p))
        sketch.sketchCurves.sketchFittedSplines.add(collection)
    for points in (arcs or []):
        sketch.sketchCurves.sketchArcs.addByThreePoints(*[xy_point(*p) for p in points])
    if sketch.profiles.count < 1:
        raise RuntimeError("%s: profile not closed (%d profiles)"
                           % (name, sketch.profiles.count))
    rev_input = revolves.createInput(sketch.profiles.item(0), root.yConstructionAxis, operation)
    try:
        rev_input.setFullExtent()
    except Exception:
        rev_input.setAngleExtent(False, adsk.core.ValueInput.createByReal(2 * math.pi))
    feature = revolves.add(rev_input)
    sketch.isVisible = False
    return feature.bodies.item(0)


# --------------------------------------------------------------------------- #
# 1. 主体
# --------------------------------------------------------------------------- #

# 内腔球面与外球面在 Ø60 处的截断高度（两者都以 (0, EQUATOR_Y) 为心）
INNER_END_Y = EQUATOR_Y + math.sqrt(SOCKET_R ** 2 - REAR_HOLE_R ** 2)
OUTER_END_Y = EQUATOR_Y + math.sqrt(OUT_R ** 2 - REAR_HOLE_R ** 2)

INNER_TOP = (FRONT_R, EQUATOR_Y)
OUTER_TOP = (OUT_R, EQUATOR_Y)
# 内腔：前圆柱 -> 与相机同心的 R50.6 半球（"从前面塞进去还能被兜住"的关键）
INNER_ARC = [INNER_TOP,
             (math.sqrt(SOCKET_R ** 2 - 25.0 ** 2), EQUATOR_Y + 25.0),
             (REAR_HOLE_R, INNER_END_Y)]
# 外表面：外圆柱 -> 外半球（半径大一个壁厚）
OUTER_ARC = [(REAR_HOLE_R, OUTER_END_Y),
             (math.sqrt(OUT_R ** 2 - 25.0 ** 2), EQUATOR_Y + 25.0),
             OUTER_TOP]

body = revolve_profile(
    "box_profile",
    lines=[
        ((FRONT_R, 0.0), INNER_TOP),                              # 内腔前圆柱
        ((REAR_HOLE_R, INNER_END_Y), (REAR_HOLE_R, OUTER_END_Y)),  # Ø60 收口孔壁
        (OUTER_TOP, (OUT_R, TRANSITION_Y)),                       # 外圆柱
        ((OUT_R, TRANSITION_Y), (TRANSITION_R, FLANGE_T)),        # 法兰根部过渡
        ((TRANSITION_R, FLANGE_T), (FLANGE_R - FLANGE_CHAMFER, FLANGE_T)),  # 法兰背面
        ((FLANGE_R - FLANGE_CHAMFER, FLANGE_T), (FLANGE_R, 0.0)),  # 法兰外倒角
        ((FLANGE_R, 0.0), (FRONT_R, 0.0)),                        # 贴窗面
    ],
    arcs=[INNER_ARC, OUTER_ARC],
)
body.name = "WindowBox"
step("body revolved: %.3f cm3" % body.volume)

# --------------------------------------------------------------------------- #
# 2. 蜂窝镂空（径向棱柱 + 圆周阵列）
# --------------------------------------------------------------------------- #


def find_cylinder_face():
    b = root.bRepBodies.item(0)
    for i in range(b.faces.count):
        f = b.faces.item(i)
        g = f.geometry
        if g.objectType.endswith("Cylinder") and abs(g.radius / MM - OUT_R) < 0.1:
            return f
    return None


def make_hex_plane(face, azimuth_deg):
    """在给定圆柱面上建一个竖直切平面，返回 (平面, 单向切深)。

    ⚠️ **法线方向不一定是朝外的。** 环槽切出来的各段柱面实测会出现朝内的法线，
       而 `setDistanceExtent(False, d)` 是"沿法线正方向"拉伸 —— 于是刀走到壁的
       内侧去了，孔被切在内腔一侧、外壁还是光的。上一版就是这么废的：
       90 孔只去掉 12.81 cm3（理论 28.7），面数 257（应 540 起步），渲图外表面是光的。

       所以这里读一次法线，按方向分别给"偏移量 + 切深"：
         朝外：平面挪到 r≈50.1，向外切 5.8mm   -> 覆盖 50.1..55.9
         朝内：平面挪到 r≈56.5，向内切 11mm    -> 覆盖 45.5..56.5
       两种都正好穿透 50.6..55.5 的壁。

    ⚠️ 还必须在切任何孔**之前**全部建好：切过孔后圆柱面会被重建，角度基准会漂。
    """
    phi = math.radians(azimuth_deg)
    tangent_input = root.constructionPlanes.createInput()
    tangent_input.setByTangent(face,
                               adsk.core.ValueInput.createByReal(phi - math.pi / 2.0),
                               root.xYConstructionPlane)
    tangent_plane = root.constructionPlanes.add(tangent_input)

    normal = tangent_plane.geometry.normal
    # ⚠️ 实测：这个拉伸的"正方向"实际是**朝轴心**的（法线判据不可靠，别再依赖它）。
    #    所以切平面必须放到**壁外**，让它朝内切进来 —— 否则刀走在壁的内侧，
    #    孔全被切在内腔面上、外壁还是光的。这个坑浪费了很多轮：从正面开口看进去
    #    有蜂窝就以为成了，其实外表面一直是光滑的（从侧后方看才露馅）。
    #    用 HEX_OUTSET/HEX_SPAN_IN：平面到 r≈56.5，朝内切 11mm -> 覆盖 45.5..56.5，
    #    正好穿透 50.6..55.5 的壁。
    distance, span = -HEX_INSET, HEX_SPAN
    _ = normal  # 保留读取，便于以后需要时再判方向

    offset_input = root.constructionPlanes.createInput()
    offset_input.setByOffset(tangent_plane,
                             adsk.core.ValueInput.createByReal(distance * MM))
    return root.constructionPlanes.add(offset_input), span


def groove_profile(y0):
    """环形浅槽的闭合轮廓（绕 Y 轴旋转切除用）。"""
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xYConstructionPlane, V(0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    sketch.name = "groove_%.0f" % y0
    corners = [(OUT_R - GROOVE_DEPTH, y0 - GROOVE_HALF_W),
               (OUT_R + 0.5, y0 - GROOVE_HALF_W),
               (OUT_R + 0.5, y0 + GROOVE_HALF_W),
               (OUT_R - GROOVE_DEPTH, y0 + GROOVE_HALF_W)]
    for i in range(4):
        sketch.sketchCurves.sketchLines.addByTwoPoints(
            xy_point(*corners[i]), xy_point(*corners[(i + 1) % 4]))
    sketch.isVisible = False
    if sketch.profiles.count < 1:
        raise RuntimeError("groove y=%.1f: 轮廓未闭合" % y0)
    return sketch.profiles.item(0)


def band_planes():
    """按 y 把外柱面分段，每段各建一个径向切平面。

    ⚠️ 必须**先切浅环槽、再调它、最后才打孔** —— 平面一旦在打孔之后建就会失效。
    """
    body_now = root.bRepBodies.item(0)
    faces = []
    for i in range(body_now.faces.count):
        f = body_now.faces.item(i)
        g = f.geometry
        if g.objectType.endswith("Cylinder") and abs(g.radius / MM - OUT_R) < 0.1:
            bb = f.boundingBox
            faces.append((bb.minPoint.y / MM, bb.maxPoint.y / MM, f))
    faces.sort(key=lambda item: item[0])
    out = []
    for lo, hi, f in faces:
        plane, span = make_hex_plane(f, 0.0)
        out.append((lo, hi, f, plane, span))
    return out


def cut_hex_row(row_index, row_y, count, plane, azimuth_deg, span_mm):
    """径向切一个正六边形，再绕 Y 轴阵列出整圈。

    ⚠️ 平面只能用 **setByTangent(圆柱面, angle, XY平面)** —— 实测这是本 Fusion
       版本里唯一能给出"径向切平面"的构造。其它五条路全部堵死：
         setByThreePoints       InternalValidationError（连平凡三点都报）
         setByPlane             Environment is not supported
         setByTangent(球面,…)    input face is not cylindrical
         setByTangentAtPoint    忽略给定点位置（要 +X 侧却给 +Z 侧）
         setByAngleOnCurvedFace must be a cylindrical or conical face
       因此蜂窝**只能做在圆柱段**；半球尾部没有可用切平面，孔会斜切甚至打空。
    """
    phi = math.radians(azimuth_deg)
    r_plane = OUT_R - HEX_INSET   # = 实际切平面半径（平面在内腔里，朝外切）
    cx, cz = r_plane * math.cos(phi), r_plane * math.sin(phi)
    e_t = (-math.sin(phi), 0.0, math.cos(phi))   # 方位向
    e_a = (0.0, 1.0, 0.0)                        # 轴向

    # ⚠️⚠️ 模型坐标 -> 草图坐标**必须用 Fusion 自己的换算**：
    #      sketch.modelToSketchSpace(point)
    #
    # 踩过的两个坑，都别再走：
    #   1. 自己用 (point-origin)·uDirection 换算 —— 草图原点通常不是
    #      plane.geometry.origin，而是"世界原点在该平面上的投影"。结果整个六边形
    #      沿轴向错位约 27.5mm（要打 y=24，实际落到 y≈-3.5），**切在贴胶布的法兰上**。
    #   2. `sketchPoints.add(point)` —— 它收的是**草图坐标**，把模型坐标（几十毫米）
    #      当草图坐标用，六边形被扔到几十毫米外，拉伸时报"未找到要剪切或相交的目标实体"。
    sketch = sketches.add(plane)
    sketch.name = "hex_row_%d" % row_index
    sketch_pts = []
    for k in range(6):
        a = math.radians(60.0 * k + 30.0)
        u = HEX_CIRCUM_R * math.cos(a)
        v = HEX_CIRCUM_R * math.sin(a)
        model_pt = adsk.core.Point3D.create(
            (cx + u * e_t[0] + v * e_a[0]) * MM,
            (row_y + u * e_t[1] + v * e_a[1]) * MM,
            (cz + u * e_t[2] + v * e_a[2]) * MM)
        sketch_pts.append(sketch.modelToSketchSpace(model_pt))
    for k in range(6):
        sketch.sketchCurves.sketchLines.addByTwoPoints(
            sketch_pts[k], sketch_pts[(k + 1) % 6])
    if sketch.profiles.count < 1:
        raise RuntimeError("hex_row_%d: 轮廓未闭合" % row_index)

    ext_input = extrudes.createInput(sketch.profiles.item(0),
                                     adsk.fusion.FeatureOperations.CutFeatureOperation)
    ext_input.setDistanceExtent(False, V(span_mm))
    feature = extrudes.add(ext_input)
    sketch.isVisible = False

    objects = adsk.core.ObjectCollection.create()
    objects.add(feature)
    pattern_input = root.features.circularPatternFeatures.createInput(
        objects, root.yConstructionAxis)
    pattern_input.quantity = adsk.core.ValueInput.createByReal(count)
    pattern_input.totalAngle = adsk.core.ValueInput.createByReal(2 * math.pi)
    pattern_input.isSymmetric = False
    root.features.circularPatternFeatures.add(pattern_input)
    return feature


_rows = list(_OVERRIDES.get("hex_row_y", HEX_ROW_Y))
_grooves = list(_OVERRIDES.get("groove_y", []))
if not _rows:
    step("no hex rows -> solid body（原版 WindowBox 是无孔实心）")
else:
    _count = max(8, int(round(2.0 * math.pi * OUT_R / HEX_PITCH)))
    _stagger = 180.0 / _count

    # ------------------------------------------------------------------ #
    # 先切浅环槽，把外柱面**分段**。
    #
    # ⚠️ 为什么必须这样：实测**切平面只在其原点以下的那半边有效**，而
    #    setByTangent 生成的原点落在该圆柱面的中高处。整根柱面（10..45，中高 27.5）
    #    就只有 y<27.5 能用 —— y=14/24 成功（−9.6/−10.2 cm3），y=30 只切到 −1.1，
    #    y=34 起直接报"未找到要剪切或相交的目标实体"。
    #    用 0.3mm 浅槽分成三段后，每段各自有中点（15 / 25 / 37.5），
    #    每段只在自己下半部打孔，就能一路铺到 y≈39。
    # ------------------------------------------------------------------ #
    for groove_y in _grooves:
        try:
            rev_input = revolves.createInput(
                groove_profile(groove_y), root.yConstructionAxis,
                adsk.fusion.FeatureOperations.CutFeatureOperation)
            # ⚠️ RevolveFeatureInput 没有 setFullExtent（实测 AttributeError），整圈要这样给：
            rev_input.setAngleExtent(False, adsk.core.ValueInput.createByReal(2 * math.pi))
            revolves.add(rev_input)
            step("groove at y=%.1f (深 %.1f): %.3f cm3"
                 % (groove_y, GROOVE_DEPTH, root.bRepBodies.item(0).volume))
        except Exception as exc:
            report["errors"].append("groove y=%.1f: %s: %s"
                                    % (groove_y, type(exc).__name__, exc))

    # 每段各建一个切平面 —— 必须在切第一个孔**之前**全部建好
    # （切过之后圆柱面被重建，角度基准会漂）
    _bands = []
    for y_lo, y_hi, band_face, plane, span in band_planes():
        _bands.append((y_lo, y_hi, plane, span))
    report["hexBands"] = [round(lo, 1) for lo, hi, p, s in _bands]

    def _plane_for(y):
        for y_lo, y_hi, plane, span in _bands:
            if y_lo - 0.05 <= y <= y_hi + 0.05:
                return plane, (y_lo + y_hi) / 2.0, span
        return None, None, None

    _before = root.bRepBodies.item(0).volume
    for row_index, row_y in enumerate(_rows):
        if row_y > EQUATOR_Y - 3.0:
            report["errors"].append(
                "hex row %d (y=%.1f) 落在半球段：本版本 API 无法构造球面切平面，已跳过"
                % (row_index, row_y))
            continue
        plane, band_mid, span = _plane_for(row_y)
        if plane is None:
            report["errors"].append("hex row %d (y=%.1f): 找不到所属分段" % (row_index, row_y))
            continue
        # ⚠️ 切法改成"平面在壁外、朝内切"之后，有效半边**翻转**了：
        #    朝内切时只有**段中高以上**的圈能投影成功（朝外切时是以下）。
        #    实测朝外切：y=14/24 成、y>=30 败；朝内切：y=24 成、y=14 败。
        if band_mid is not None and row_y > band_mid + 0.5:
            report["errors"].append(
                "hex row %d (y=%.1f) 在该段(中高 %.1f)的下半部，投影会失败，已跳过"
                % (row_index, row_y, band_mid))
            continue
        try:
            # 隔行错位：把六边形直接画在目标方位上（投影只差 cos φ，6° 时 0.55%）；
            # 不为错位另建平面 —— 实测 6° 平面的法线方向不对，偏移量跑到壁外。
            azimuth = _stagger if row_index % 2 else 0.0
            cut_hex_row(row_index, row_y, _count, plane, azimuth, span)
            body = root.bRepBodies.item(0)
            step("hex row %d (y=%.1f, %d 孔, 起始 %.1f deg, 段中高 %.1f, 切深 %.1f): %.3f cm3 (本圈 -%.2f)"
                 % (row_index, row_y, _count, azimuth, band_mid, span, body.volume,
                    _before - body.volume))
            _before = body.volume
        except Exception as exc:
            report["errors"].append("hex row %d (y=%.1f): %s: %s"
                                    % (row_index, row_y, type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 3. 挂绳眼环（HEX 变体 HOOK_ENABLED=False 时整块跳过）
# --------------------------------------------------------------------------- #


class _SkipHook(Exception):
    pass


try:
    if not HOOK_ENABLED:
        raise _SkipHook()
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xZConstructionPlane, V(HOOK_Y0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    sketch.name = "hook"
    # 圆头耳片（原来是尖角方块，外端方角会刮绳）：两条直边 + 外端半圆 + 根部直边
    curves = sketch.sketchCurves
    curves.sketchLines.addByTwoPoints(
        xz_point(sketch, HOOK_HALF_X, HOOK_ROOT_Z),
        xz_point(sketch, HOOK_HALF_X, HOOK_CAP_Z))
    curves.sketchArcs.addByThreePoints(
        xz_point(sketch, HOOK_HALF_X, HOOK_CAP_Z),
        xz_point(sketch, 0.0, HOOK_CAP_Z + HOOK_HALF_X),
        xz_point(sketch, -HOOK_HALF_X, HOOK_CAP_Z))
    curves.sketchLines.addByTwoPoints(
        xz_point(sketch, -HOOK_HALF_X, HOOK_CAP_Z),
        xz_point(sketch, -HOOK_HALF_X, HOOK_ROOT_Z))
    curves.sketchLines.addByTwoPoints(
        xz_point(sketch, -HOOK_HALF_X, HOOK_ROOT_Z),
        xz_point(sketch, HOOK_HALF_X, HOOK_ROOT_Z))
    ext_input = extrudes.createInput(
        sketch.profiles.item(0), adsk.fusion.FeatureOperations.JoinFeatureOperation)
    ext_input.setDistanceExtent(False, V(HOOK_Y1 - HOOK_Y0))
    extrudes.add(ext_input)
    sketch.isVisible = False

    hole_sketch = sketches.add(plane)
    hole_sketch.name = "hook_hole"
    hole_sketch.sketchCurves.sketchCircles.addByCenterRadius(
        xz_point(hole_sketch, 0.0, HOOK_CAP_Z), HOOK_HOLE_R * MM)
    hole_input = extrudes.createInput(
        hole_sketch.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
    hole_input.setDistanceExtent(False, V(HOOK_Y1 - HOOK_Y0 + 2.0))
    extrudes.add(hole_input)
    hole_sketch.isVisible = False
    body = root.bRepBodies.item(0)
    step("hook lug Ø%.0f x %d wide x %d thick, tip z=%.0f: %.3f cm3"
         % (HOOK_HOLE_R * 2, HOOK_HALF_X * 2, HOOK_Y1 - HOOK_Y0,
            HOOK_CAP_Z + HOOK_HALF_X, body.volume))
except _SkipHook:
    step("hook skipped (HOOK_ENABLED=False)")
except Exception as exc:
    report["errors"].append("hook: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 4. 材质 + 量结果
# --------------------------------------------------------------------------- #

appearance = find_appearance(APPEARANCE)
report["bodies"] = []
for i in range(root.bRepBodies.count):
    b = root.bRepBodies.item(i)
    if appearance is not None:
        try:
            b.appearance = appearance
        except Exception as exc:
            report["errors"].append("appearance %s: %s" % (b.name, exc))
    bb = b.boundingBox
    report["bodies"].append({
        "name": b.name,
        "isSolid": bool(b.isSolid),
        "lumps": b.lumps.count,
        "shells": b.shells.count,
        "volume_cm3": round(b.volume, 3),
        "mass_g_PLA": round(b.volume * 1.24, 1),
        "bbox_mm": {
            "min": [round(v / MM, 1) for v in (bb.minPoint.x, bb.minPoint.y, bb.minPoint.z)],
            "max": [round(v / MM, 1) for v in (bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z)],
        },
    })
total = sum(b["volume_cm3"] for b in report["bodies"])
report["totalVolume_cm3"] = round(total, 3)
report["totalMass_g_PLA"] = round(total * 1.24, 1)
report["wall_mm"] = round(OUT_R - SOCKET_R, 2)
report["rearHolePlane_mm"] = [round(INNER_END_Y, 2), round(OUTER_END_Y, 2)]
step("wall %.2fmm, bodies %d, total %.3f cm3 / %.1f g PLA"
     % (OUT_R - SOCKET_R, root.bRepBodies.count, total, total * 1.24))

# --------------------------------------------------------------------------- #
# 5. 保存
# --------------------------------------------------------------------------- #

try:
    if created_new:
        folder = project_folder()
        saved = doc.saveAs(FILE_NAME, folder, "", "")
    else:
        saved = doc.save("")
    for _ in range(60):
        adsk.doEvents()
        time.sleep(0.1)
        if doc.isSaved:
            break
    report["saved"] = {"returned": bool(saved), "isSaved": bool(doc.isSaved),
                       "documentName": doc.name}
    step("saved %s" % doc.name)
except Exception as exc:
    report["errors"].append("save: %s" % exc)

result = report
