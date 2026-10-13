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
# 壁厚会啃到内腔壁面。做法改为**切平面 + 径向对称切**：
#
#   1. 平面用 setByTangent(圆柱面, angle, 参考面)，法线即径向
#      ⚠️ 参考面**只能用 XY 平面** —— XZ 平面与圆柱轴平行，Fusion 直接拒绝
#      ⚠️ 真签名是 (face, angle, planarEntity)；只传 face 会报"缺 angle/planarEntity"
#      ⚠️ 角度约定实测：切点方位 φ（自 +X 向 +Z）= angle + 90°
#   2. 法线**永远朝外**，单侧拉伸只会往外切。改为把切平面朝内偏移 HEX_INSET，
#      再用**对称拉伸** —— 外伸量被压到 0.8mm，不会啃坏别处
#   3. `setByThreePoints` 在这个 Fusion 版本里完全不可用（连平凡三点都报
#      InternalValidationError），别再试它
#   4. 两圈蜂窝的 y 区间必须避开挂绳耳片（35..45），否则耳片根部会被切穿
HEX_ROWS = [              # (高度 y, 起始角偏移) —— 行间错开半格才是蜂窝
    (14.0, 0.0),
    (28.0, 7.5),
]
HEX_CIRCUM_R = 5.0        # 正六边形外接圆半径（对角 10mm）
HEX_COUNT = 24            # 每圈孔数（15° 一个）
# 切平面放到**内腔里**（r = OUT_R - HEX_INSET = 50.1），再**单向朝外**切 HEX_SPAN。
# 实测：单向 setDistanceExtent(False, d) 可用；对称 setDistanceExtent(True, d) 与
# setAllExtent(Symmetric) 虽然也返回成功，但会**在对侧多打一个洞**，所以不用。
# 这样正好穿透 50.6..55.5 的壁，只外伸 0.4mm，不会啃到挂绳耳片。
HEX_INSET = 5.4           # 切平面朝内偏移量（落进内腔）
HEX_SPAN = 5.8            # 单向拉伸长度 -> 覆盖 r 50.1..55.9

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
FILE_NAME = "WindowBox"
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


def cut_hex_row(row_index, row_y, phi_deg):
    """在方位 phi、高度 row_y 处径向切一个正六边形，再绕 Y 轴阵列出整圈。

    角度换算实测：切点方位 φ（自 +X 向 +Z）= angle + 90°。
    法线永远朝外，所以靠"平面内移 + 对称拉伸"把切深压进壁里。
    """
    phi = math.radians(phi_deg)

    tangent_input = root.constructionPlanes.createInput()
    tangent_input.setByTangent(cylinder_face,
                               adsk.core.ValueInput.createByReal(phi - math.pi / 2.0),
                               root.xYConstructionPlane)
    tangent_plane = root.constructionPlanes.add(tangent_input)

    offset_input = root.constructionPlanes.createInput()
    offset_input.setByOffset(tangent_plane,
                             adsk.core.ValueInput.createByReal(-HEX_INSET * MM))
    plane = root.constructionPlanes.add(offset_input)

    sketch = sketches.add(plane)
    sketch.name = "hex_row_%d" % row_index

    # ⚠️ addByTwoPoints 要的是**草图坐标系**的点。直接把模型坐标喂进去，Fusion 会
    #    生成"3D 轮廓"，`profiles.count` 仍为 1，但拉伸时报
    #    "未找到要剪切或相交的目标实体"（圆形测试用的草图原点，所以没暴露这个坑）。
    #    必须用平面自身的 origin/uDirection/vDirection 换算。
    plane_geometry = plane.geometry
    origin = plane_geometry.origin
    u_dir = plane_geometry.uDirection
    v_dir = plane_geometry.vDirection

    def to_sketch(point):
        delta = adsk.core.Vector3D.create(point.x - origin.x,
                                          point.y - origin.y,
                                          point.z - origin.z)
        return adsk.core.Point3D.create(delta.dotProduct(u_dir),
                                        delta.dotProduct(v_dir), 0.0)

    r_plane = OUT_R - HEX_INSET
    cx, cz = r_plane * math.cos(phi), r_plane * math.sin(phi)
    e_t = (-math.sin(phi), 0.0, math.cos(phi))   # 切向（⟂ 径向）
    e_a = (0.0, 1.0, 0.0)                        # 轴向
    verts = []
    for k in range(6):
        a = math.radians(60.0 * k + 30.0)
        u = HEX_CIRCUM_R * math.cos(a)
        v = HEX_CIRCUM_R * math.sin(a)
        verts.append(to_sketch(adsk.core.Point3D.create(
            (cx + u * e_t[0] + v * e_a[0]) * MM,
            (row_y + u * e_t[1] + v * e_a[1]) * MM,
            (cz + u * e_t[2] + v * e_a[2]) * MM)))
    for k in range(6):
        sketch.sketchCurves.sketchLines.addByTwoPoints(verts[k], verts[(k + 1) % 6])
    if sketch.profiles.count < 1:
        raise RuntimeError("hex_row_%d: 轮廓未闭合" % row_index)

    ext_input = extrudes.createInput(sketch.profiles.item(0),
                                     adsk.fusion.FeatureOperations.CutFeatureOperation)
    ext_input.setDistanceExtent(False, V(HEX_SPAN))
    feature = extrudes.add(ext_input)
    sketch.isVisible = False

    objects = adsk.core.ObjectCollection.create()
    objects.add(feature)
    pattern_input = root.features.circularPatternFeatures.createInput(
        objects, root.yConstructionAxis)
    pattern_input.quantity = adsk.core.ValueInput.createByReal(HEX_COUNT)
    pattern_input.totalAngle = adsk.core.ValueInput.createByReal(2 * math.pi)
    pattern_input.isSymmetric = False
    root.features.circularPatternFeatures.add(pattern_input)
    return feature


cylinder_face = None
for _i in range(body.faces.count):
    _f = body.faces.item(_i)
    _g = _f.geometry
    if _g.objectType.endswith("Cylinder") and abs(_g.radius / MM - OUT_R) < 0.1:
        cylinder_face = _f
        break
report["outerCylinderFaceFound"] = cylinder_face is not None

if cylinder_face is None:
    report["errors"].append("outer cylinder face (R%.1f) not found" % OUT_R)
else:
    for row_index, (row_y, row_offset) in enumerate(HEX_ROWS):
        try:
            cut_hex_row(row_index, row_y, row_offset)
            body = root.bRepBodies.item(0)
            step("hex row %d (y=%.1f, offset=%.1f deg): %.3f cm3"
                 % (row_index, row_y, row_offset, body.volume))
        except Exception as exc:
            report["errors"].append("hex row %d: %s: %s"
                                    % (row_index, type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 3. 挂绳眼环
# --------------------------------------------------------------------------- #

try:
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
