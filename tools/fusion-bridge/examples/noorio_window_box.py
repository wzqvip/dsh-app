# -*- coding: utf-8 -*-
"""Noorio 球机 —— 窗户挂盒 WindowBox。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

用户需求（"你可以自行判断"）：

1. 全包的盒子，把相机挂在窗户上
2. 靠近窗户那一面四个方向延伸出小平面，用来贴胶布
3. 盒子本体提供挂钩，栓安全绳
4. 远离窗户那一面做穹顶去配合原来的弧度，方便 3D 打印

# 设计判断（四处，都写在这里免得以后忘）

**一、前方是 Ø103 大开口 + 一圈窄法兰。**
相机球 Ø100，要能放进去，开口就得 ≥Ø103。所以前法兰是 r 51.5..62 的窄环
（就是"靠窗户那一面"），四片翼片从这里伸出去。**没有镜头孔** —— 开口本身
就是镜头孔，相机 140° 视场在法兰平面处锥体直径才 Ø27.4，离 Ø103 远得很。

**二、内腔是 R51 球面 + 前方 R51.5 圆柱。** 相机球 R50，同心 1mm 间隙；
前方那段圆柱（y 4..45）是给装球用的导入段，R51.5 略大于球面最大半径 51。
相机球落进球窝、由螺杆锁住 —— **受力靠球窝，螺杆只管不掉出来**，
所以螺杆不会被 456g 的弯矩掰断（球窝一接触就把力接走了）。

**三、固定方式：后端一根 M5x0.8 螺杆。**

⚠️ 这里推翻过一个方案。原设计是盒子后端出 **M42x1 外螺纹套筒**、万向节从盒外
拧上去（复用可调球头）。`noorio_window_fit.py` 的干涉检查实测**不成立**：

    WindowBox <-> Gimbal housing   干涉 2.02 cm3

因为套筒要被万向节内螺纹咬住就必须伸到 y=125..140，而万向节的**内部锥腔在
y=110..125 之间从 Ø41 收到 Ø19** —— Ø42 的套筒直接撞穿这段锥壁；而且球头
（Ø17，球心 y=114.5）也占在同一个腔里，套筒怎么让位都会撞到其中一个。

所以改成后端直接出 M5 螺杆，相机单独拧上去，**不经过万向节**。
代价：放弃角度调节（窗户场景不需要）。要保留可调就得改成两件式。

**四、装配顺序。** 从前方 Ø103 开口把相机放进去 → 拧上螺杆 → 完成。
所以盒子必须是**前面开口**的，后端封闭。

# 打印方向

法兰朝下平放、穹顶朝上 —— 外壳全是上收面、内腔朝上敞开、螺杆朝上，
**全程无悬垂，不需要支撑**。

# 坐标

Y 为轴，玻璃在 y=0，房间在 +Y，相机朝 -Y 望向窗外。
相机球心 (0, 45, 0)，球面 y 5..95；后端壁面 y=105。
"""

import math
import time

import adsk.core
import adsk.fusion

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

GLASS_Y = 0.0
CENTER_Y = 45.0          # 相机球心
BALL_R = 50.0
SOCKET_R = BALL_R + 1.0  # 内腔球面 R51（1mm 间隙）

REAR_Y = 105.0           # 内腔后端壁面（相机尾极在 95，留 10）

RIM_Y = 4.0              # 前法兰厚度
RIM_R_OUTER = 62.0
# ⚠️ 开口与导入段都必须取整 51（= 球面赤道半径），这样导入圆柱与内腔球面在 y=45
#    处相切、内腔是**精确的 R51 同心球面**。先前取 51.5 + 样条逼近，样条在
#    (10.05,95)~(20,92) 之间鼓包切进相机球，实测干涉 83.9 mm3。
OPENING_R = 51.0         # 前方开口半径（Ø102，相机 Ø100 进得去，单边 1mm）
LEAD_R = 51.0            # 导入段圆柱半径
LEAD_Y1 = CENTER_Y       # 导入段到球心高度为止，与球面相切

STUD_R = 2.5             # M5x0.8
STUD_TIP_Y = 85.0        # 螺杆尖：相机 Ø5 孔在 85..95，咬 10mm

TAB_Y = 3.0              # 翼片厚度
TAB_R0 = RIM_R_OUTER
TAB_R1 = 95.0
TAB_HALF_W = 22.0

# 挂钩（眼环）位置。⚠️ 两个坑都踩过：
#   ① 起先放在 y 0..8，和 +Z 翼片（只占 y 0..3）在 z 上重叠 -> 挂钩被并进翼片，
#      读起来像"翼片上多了个孔"。挪到 y 16..26 与翼片彻底分开。
#   ② 孔原先在 z=66，而盒面在 z≈61.4 -> 孔到盒壁只剩 2.1mm 料。
#      外移到 z=71，两侧料厚变成内 7.1 / 外 10.5，均衡。
HOOK_Y0 = 16.0
HOOK_Y1 = 26.0
HOOK_Z0 = 52.0
HOOK_Z1 = 84.0
HOOK_HALF_X = 6.0
HOOK_HOLE_R = 2.5        # Ø5 安全绳孔
HOOK_HOLE_Z = 71.0

APPEARANCE = "塑料 - 粗面(白色)"
FILE_NAME = "WindowBox"
PROJECT_NAME = "Noorio B310"

MM = 0.1


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


def revolve_profile(name, lines, splines, arcs=None,
                    operation=adsk.fusion.FeatureOperations.NewBodyFeatureOperation):
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xYConstructionPlane, V(0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    sketch.name = name
    for (p1, p2) in lines:
        sketch.sketchCurves.sketchLines.addByTwoPoints(xy_point(*p1), xy_point(*p2))
    for points in splines:
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

OUTER = [(RIM_R_OUTER, RIM_Y), (58.0, 45.0), (52.0, 70.0), (38.0, 95.0),
         (14.0, 108.0), (0.0, 112.0)]
# ⚠️ 球面用**精确 R51 圆弧**（三点定圆：三点都在以 (0,45) 为心、R51 的圆上），
#    不要用样条逼近 —— 样条会鼓包切进相机。
SOCKET_ARC = [(51.0, 45.0), (37.1, 80.0), (10.05, 95.0)]
REAR_SPLINE = [(10.05, 95.0), (6.0, 105.0), (0.0, REAR_Y)]

body = revolve_profile(
    "box_profile",
    lines=[
        ((0.0, 112.0), (0.0, REAR_Y)),            # 后端壁（轴线上）
        ((LEAD_R, LEAD_Y1), (LEAD_R, 0.0)),       # 导入段圆柱壁
        ((LEAD_R, 0.0), (RIM_R_OUTER, 0.0)),      # 前法兰面
        ((RIM_R_OUTER, 0.0), (RIM_R_OUTER, RIM_Y)),  # 前法兰外缘
    ],
    splines=[OUTER, REAR_SPLINE],
    arcs=[SOCKET_ARC],
)
body.name = "WindowBox"
step("shell revolved: %.3f cm3" % body.volume)

# --------------------------------------------------------------------------- #
# 2. 后端 M5x0.8 螺杆
# --------------------------------------------------------------------------- #

try:
    stud = revolve_profile(
        "stud_profile",
        lines=[
            ((0.0, REAR_Y), (STUD_R, REAR_Y)),
            ((STUD_R, REAR_Y), (STUD_R, STUD_TIP_Y)),
            ((STUD_R, STUD_TIP_Y), (0.0, STUD_TIP_Y)),
            ((0.0, STUD_TIP_Y), (0.0, REAR_Y)),
        ],
        splines=[],
        operation=adsk.fusion.FeatureOperations.JoinFeatureOperation,
    )
    step("stud joined: %.3f cm3" % body.volume)
except Exception as exc:
    report["errors"].append("stud: %s: %s" % (type(exc).__name__, exc))

# 螺杆的真实 M5x0.8 6g 螺纹
try:
    query = fusion.ThreadDataQuery.create(False)
    thread_type = "ISO Metric profile"
    designation = None
    for size in query.allSizes(thread_type):
        if not size.startswith("5"):
            continue
        for candidate in query.allDesignations(thread_type, size):
            if candidate.strip() == "M5x0.8":
                designation = candidate
                break
        if designation:
            break
    stud_face = None
    for face in body.faces:
        geometry = face.geometry
        if (geometry.objectType.endswith("Cylinder")
                and abs(geometry.radius * 10 - STUD_R) < 0.01):
            bb = face.boundingBox
            if (bb.maxPoint.y / MM) < REAR_Y + 0.5:
                stud_face = face
                break
    if designation is None:
        report["errors"].append("M5x0.8 not found")
    elif stud_face is None:
        report["errors"].append("stud face not found")
    else:
        info = fusion.ThreadInfo.create(False, False, thread_type, designation, "6g", True)
        thread_input = root.features.threadFeatures.createInput(stud_face, info)
        thread_input.isModeled = True
        root.features.threadFeatures.add(thread_input)
        step("stud thread: %s 6g (模型外径 %.3f)" % (designation, info.majorDiameter * 10))
except Exception as exc:
    report["errors"].append("stud thread: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 3. 四片贴胶布翼片
# --------------------------------------------------------------------------- #

tab_specs = [
    ("tab_plus_x", (TAB_R0, -TAB_HALF_W), (TAB_R1, TAB_HALF_W)),
    ("tab_minus_x", (-TAB_R1, -TAB_HALF_W), (-TAB_R0, TAB_HALF_W)),
    ("tab_plus_z", (-TAB_HALF_W, -TAB_R1), (TAB_HALF_W, -TAB_R0)),
    ("tab_minus_z", (-TAB_HALF_W, TAB_R0), (TAB_HALF_W, TAB_R1)),
]
for name, p1, p2 in tab_specs:
    try:
        plane_input = root.constructionPlanes.createInput()
        plane_input.setByOffset(root.xZConstructionPlane, V(0))
        plane = root.constructionPlanes.add(plane_input)
        sketch = sketches.add(plane)
        sketch.name = name
        sketch.sketchCurves.sketchLines.addTwoPointRectangle(
            xz_point(sketch, p1[0], p1[1]), xz_point(sketch, p2[0], p2[1]))
        ext_input = extrudes.createInput(
            sketch.profiles.item(0), adsk.fusion.FeatureOperations.JoinFeatureOperation)
        ext_input.setDistanceExtent(False, V(TAB_Y))
        extrudes.add(ext_input)
        sketch.isVisible = False
    except Exception as exc:
        report["errors"].append("%s: %s: %s" % (name, type(exc).__name__, exc))
body = root.bRepBodies.item(0)
step("4 tabs: %.3f cm3" % body.volume)

# --------------------------------------------------------------------------- #
# 4. 挂钩（眼环）
# --------------------------------------------------------------------------- #

try:
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xZConstructionPlane, V(HOOK_Y0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    sketch.name = "hook"
    sketch.sketchCurves.sketchLines.addTwoPointRectangle(
        xz_point(sketch, -HOOK_HALF_X, HOOK_Z0), xz_point(sketch, HOOK_HALF_X, HOOK_Z1))
    ext_input = extrudes.createInput(
        sketch.profiles.item(0), adsk.fusion.FeatureOperations.JoinFeatureOperation)
    ext_input.setDistanceExtent(False, V(HOOK_Y1 - HOOK_Y0))
    extrudes.add(ext_input)
    sketch.isVisible = False

    hole_sketch = sketches.add(plane)
    hole_sketch.name = "hook_hole"
    hole_sketch.sketchCurves.sketchCircles.addByCenterRadius(
        xz_point(hole_sketch, 0.0, HOOK_HOLE_Z), HOOK_HOLE_R * MM)
    hole_input = extrudes.createInput(
        hole_sketch.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
    hole_input.setDistanceExtent(False, V(HOOK_Y1 - HOOK_Y0 + 2.0))
    extrudes.add(hole_input)
    hole_sketch.isVisible = False

    body = root.bRepBodies.item(0)
    step("hook + Ø%.0f hole: %.3f cm3" % (HOOK_HOLE_R * 2, body.volume))
except Exception as exc:
    report["errors"].append("hook: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 5. 材质 + 量结果
# --------------------------------------------------------------------------- #

appearance = find_appearance(APPEARANCE)
if appearance is not None:
    try:
        body.appearance = appearance
        step("appearance %r" % APPEARANCE)
    except Exception as exc:
        report["errors"].append("appearance: %s" % exc)

bb = body.boundingBox
report["body"] = {
    "name": body.name,
    "isSolid": bool(body.isSolid),
    "lumps": body.lumps.count,
    "shells": body.shells.count,
    "volume_cm3": round(body.volume, 3),
    "mass_g_PLA": round(body.volume * 1.24, 1),
    "bbox_mm": {
        "min": [round(v / MM, 1) for v in (bb.minPoint.x, bb.minPoint.y, bb.minPoint.z)],
        "max": [round(v / MM, 1) for v in (bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z)],
    },
}
step("volume %.3f cm3, %.1f g PLA, lumps=%d"
     % (body.volume, body.volume * 1.24, body.lumps.count))

# --------------------------------------------------------------------------- #
# 6. 保存
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
