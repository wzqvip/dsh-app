# -*- coding: utf-8 -*-
"""Noorio 球机 —— 窗户挂盒 WindowBox（可自由调角度版）。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

# 用户需求与迭代

    全包的盒子，挂在窗户上
    靠近窗户那一面四个方向延伸出小平面贴胶布   -> 用户后来改成"做成一圈"（更结实）
    盒子本体提供挂钩栓安全绳                   -> 用户要求"做的结实一点"
    远离窗户那一面做穹顶配合弧度                -> 便于 3D 打印
    相机在内部自由调整角度，背后不留螺丝/固定    -> 去掉后端 M5 螺杆，改球窝+收口唇边
    后部切掉 Ø60 左右，贴上后还能调角度         -> 后端盖子上的 Ø60 调整孔
    前端要足够结实支撑整个摄像头                -> 前端是厚球面带 + 整圈法兰

# ⚠️ 装配矛盾（决定了为什么必须是两件）

刚性一件式壳体**无法既让 Ø100 相机球进去、又把它卡住** —— 球的投影永远是 Ø100，
所以"装入口"必须 >Ø100，而"卡住它的口"必须 <Ø100，两者不能是同一个口。

本设计的两个口：
    前口 Ø58.8   球窝前缘，**球不往前掉的唯一依靠**（不能放大）
    后口 Ø101    球唯一进得去的通道（所以不能砍成 Ø60）

于是后端做成**可拆的盖子**：取下盖子露出 Ø101 -> 球压过收口唇边坐进球窝 ->
盖回盖子（Ø60 调整孔）-> 之后伸手进去转角度。

# 三个关键的"为什么"

**一、相机前脸的形状决定了球窝只能在球心之后。**
相机前端是 R75.4 的球带（Ø100->Ø90->Ø60->Ø20），**比 R50 的球还要鼓**：
y=18 处相机半径 45.0，而 R50 球只有 42.1。所以前面不能包球面，只能是**让位腔**；
真正贴合的球窝只能做在相机后半球（R50 真球面）。

**二、这两个数字都是算出来的，不是拍的：**
    球窝 R50.4            单边 0.4mm 间隙 -> 能自由转，又不会晃
    收口唇边 R49.1        压入过盈 0.9mm/边（PLA 弹性内，手压得进）
                          到位后对球面过盈 0.26mm -> 提供"转到位就停住"的摩擦
    前口 R29.4            = R50.4 在 y=4 处的半径，球往前只能走 0.6mm 就被它挡住

**三、球窝必须在球心之前结束，否则装不进去。**
相机是从后方压入的，所以从后口到球窝的整条路径都得 ≥Ø100。

# 打印方向

法兰朝下平放、开口朝上。外壳全是上收面、内腔朝上敞开 —— 全程无悬垂。
盖子单独平放打印。
"""

import math
import time

import adsk.core
import adsk.fusion

MM = 0.1

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

CENTER_Y = 45.0          # 相机球心
BALL_R = 50.0
SOCKET_R = BALL_R + 0.6  # 球窝 R50.6（0.6mm/边；FDM 公差 ±0.2，0.4 会咬死）

RIM_Y = 3.0              # 前段外缘起点（也是贴窗法兰的背面高度）
RIM_R_OUTER = 62.0       # 前段外缘

# ⚠️ 前口不能是"球窝前缘"，必须单独算 —— 相机前端是 R75.4 球带，比 R50 球还鼓：
#    y=20 处相机半径 45.7，而 R50.4 球面只有 43.8。所以球窝只能做在球心之后，
#    前面必须是一条**让开相机前锥**的曲线，终点收成这圈挡边。
FRONT_OPEN_R = 42.5      # 前口半径（Ø85）；相机在 y≈12 处是 42.4 -> 往前被它挡住
FRONT_Y = 12.0           # 挡边所在高度
# ⚠️ 首个点必须引用 FRONT_OPEN_R，不能写死常量：曾用脚本全局替换 42.0->42.5
#    只改到前口内壁那条线，让位腔样条起点还留在 42.0，轮廓差 0.5mm 断开。
# ⚠️ 末个点必须与 SOCKET_ARC 的首点**逐位相同**，否则同样断开（踩过两次）。
SOCKET_ARC = [(50.51, 42.0), (50.59, 46.0), (50.35, 50.0)]
CAVITY_FRONT = [(FRONT_OPEN_R, FRONT_Y), (44.5, 15.0), (46.4, 20.0),
                (49.2, 30.0), SOCKET_ARC[0]]

# ⚠️⚠️ 这里**没有收口唇边**，这是踩过坑后的结论。
#
# 原先在 y=53 做了一个 Ø98.2 的收口唇边，想让它"卡住球头 + 提供定位摩擦"。
# **那是装不进去的**：球是 Ø100，要过去就得把这个刚性整圈撑开 1.8mm 直径，
# 环向应变 = 1.8π/(π×98.2) ≈ 1.8%，超出 PLA 弹性范围；而且整圈没有开缝、
# 壁厚 10mm，没有任何顺从性，手压不动，硬压会崩。
#
# 更本质：**任何要求球"轴向挤过去"的整圈都不行** —— 球面在圈口处几乎与轴线
# 平行，没有楔形放大，推力必须直接对抗整个过盈。要么开缝让指爪弯曲，要么
# 根本不要过盈。
#
# 而且**过盈本来就不必要**：相机质心就在球心上（它就是个球），重力对球心
# 不产生力矩，瞄准角度天然稳定，不靠摩擦卡住。
#
# 所以：纯间隙配合（0.4mm/边），靠「前端挡边 + 后盖」定轴向位置。

CAVITY_R = 50.5          # 球窝之后的让位腔 Ø101
REAR_Y = 97.0            # 后端盖接合面（相机尾极在 95，留 2）
REAR_R_OUTER = 58.0      # 后端外缘（留 7.5mm 给 M3 自攻）

# 贴窗法兰：**整圈**（用户点出四片翼片与本体连接太细；整圈是 360° 连续连接）
MOUNT_R_OUTER = 80.0     # 18mm 宽，足够贴胶；再宽只是费料
MOUNT_T = 3.0
MOUNT_CHAMFER = 1.5

# 后端盖子
CAP_Y0 = REAR_Y
CAP_Y1 = REAR_Y + 7.0
CAP_HOLE_R = 30.0        # Ø60 调整孔
CAP_CHAMFER = 2.0

# 4 颗 M3（自攻）均布在 r=55
SCREW_R = 55.0
SCREW_PILOT_R = 1.3      # Ø2.6 自攻底孔
SCREW_CLEAR_R = 1.6      # Ø3.2 过孔
SCREW_ANGLES = [45.0, 135.0, 225.0, 315.0]

# 挂绳眼环（用户要求做结实）：加宽加厚 + 深埋进本体
HOOK_Y0 = 16.0
HOOK_Y1 = 30.0
HOOK_Z0 = 50.0           # 埋进本体
HOOK_Z1 = 86.0
HOOK_HALF_X = 8.0
HOOK_HOLE_R = 3.0        # Ø6
HOOK_HOLE_Z = 73.0

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


def hole_at_y(plane_y, hole_r, depth, angle_deg=None, radial_mm=None,
              participant=None):
    """在法线沿 Y 的平面上开孔，沿 **+Y** 挤入 depth。

    ⚠️ 两个坑：
      ① 挤出的方向是草图平面的法线方向（+Y）。想在 y=97 的面上往**本体内**打孔，
         就得把草图平面放在 y=97-depth 处再往 +Y 打，不能放在 97 上。
      ② 后端盖的过孔会顺带把前壳上的自攻底孔一起扩成 Ø3.2，所以要显式指定
         participantBodies 限定只切盖子。
    """
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xZConstructionPlane, V(plane_y))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    if radial_mm is None:
        x, z = 0.0, 0.0
    else:
        ang = math.radians(angle_deg)
        x, z = radial_mm * math.cos(ang), radial_mm * math.sin(ang)
    sketch.sketchCurves.sketchCircles.addByCenterRadius(
        xz_point(sketch, x, z), hole_r * MM)
    ext_input = extrudes.createInput(
        sketch.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
    ext_input.setDistanceExtent(False, V(depth))
    if participant is not None:
        ext_input.participantBodies = [participant]
    extrudes.add(ext_input)
    sketch.isVisible = False


# --------------------------------------------------------------------------- #
# 1. 前壳（含整圈贴窗法兰）
# --------------------------------------------------------------------------- #

# 外轮廓：前段外缘 -> 微微收腰 -> 后端外缘
OUTER = [(RIM_R_OUTER, RIM_Y), (58.0, 40.0), (56.0, 70.0), (REAR_R_OUTER, REAR_Y)]
# 球窝：**精确 R50.4 圆弧**（三点都在以 (0,45) 为心、R50.4 的圆上）。
# ⚠️ 别用样条逼近 —— 之前样条在两点之间鼓包切进相机，实测干涉 83.9 mm3。
# ⚠️ 而且球窝只能做在球心**之后**：相机前锥比 R50 球还鼓，包到前面就撞。
SOCKET_EXIT = [(50.35, 50.0), (CAVITY_R, 57.0)]   # 球窝自然收到让位腔（无收口唇边）

cup = revolve_profile(
    "cup_profile",
    lines=[
        ((FRONT_OPEN_R, 0.0), (FRONT_OPEN_R, FRONT_Y)),        # 前口内壁（挡边）
        ((CAVITY_R, 57.0), (CAVITY_R, REAR_Y)),                # 球窝之后的让位腔
        ((CAVITY_R, REAR_Y), (REAR_R_OUTER, REAR_Y)),          # 后端接合面
        # ⚠️ 这里**不能**再补一条 (REAR_R_OUTER,REAR_Y)->(RIM_R_OUTER,RIM_Y) 的直线：
        #    它和 OUTER 样条连着同样的两点，会把闭合区域切碎，
        #    结果 item(0) 取到的是不含法兰与整圈的那块（踩过）。
        ((RIM_R_OUTER, RIM_Y), (MOUNT_R_OUTER, RIM_Y)),        # 贴窗法兰背面（整圈）
        ((MOUNT_R_OUTER, RIM_Y), (MOUNT_R_OUTER - MOUNT_CHAMFER, 0.0)),  # 法兰倒角
        ((MOUNT_R_OUTER - MOUNT_CHAMFER, 0.0), (FRONT_OPEN_R, 0.0)),     # 法兰正面
    ],
    splines=[OUTER, CAVITY_FRONT, SOCKET_EXIT],
    arcs=[SOCKET_ARC],
)
cup.name = "WindowBox"
step("cup revolved: %.3f cm3" % cup.volume)

# --------------------------------------------------------------------------- #
# 2. 挂绳眼环（加宽加厚 + 深埋）
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
    cup = root.bRepBodies.item(0)
    step("hook Ø%.0f x %d wide x %d thick: %.3f cm3"
         % (HOOK_HOLE_R * 2, HOOK_HALF_X * 2, HOOK_Y1 - HOOK_Y0, cup.volume))
except Exception as exc:
    report["errors"].append("hook: %s: %s" % (type(exc).__name__, exc))

for angle in SCREW_ANGLES:
    try:
        hole_at_y(REAR_Y - 9.0, SCREW_PILOT_R, 9.0, angle, SCREW_R)
    except Exception as exc:
        report["errors"].append("screw pilot %.0f: %s" % (angle, exc))
step("4 x M3 pilot holes (Ø%.1f) on rear face" % (SCREW_PILOT_R * 2))

# --------------------------------------------------------------------------- #
# 3. 后端盖（Ø60 调整孔）
# --------------------------------------------------------------------------- #

cap = revolve_profile(
    "cap_profile",
    lines=[
        # ⚠️ 内表面做成锥面，用来**限制相机往后滑的行程**：
        #    相机 r=30 那一圈在 y=85，锥面在 r=30 处是 y=87 -> 只能后滑 2mm。
        #    如果这里是平face（y=97 通面），相机尾极会直接钻进门洞、后滑 12mm。
        #    锥面只占 r 30..50，Ø60 调整孔（r<30）完全不被挡。
        ((CAP_HOLE_R, CAP_Y0 - 10.0), (50.0, CAP_Y0)),                       # 锥形内表面
        ((50.0, CAP_Y0), (REAR_R_OUTER, CAP_Y0)),                            # 接合面
        ((REAR_R_OUTER, CAP_Y0), (REAR_R_OUTER, CAP_Y1 - CAP_CHAMFER)),      # 外缘
        ((REAR_R_OUTER, CAP_Y1 - CAP_CHAMFER), (REAR_R_OUTER - CAP_CHAMFER, CAP_Y1)),
        ((REAR_R_OUTER - CAP_CHAMFER, CAP_Y1), (CAP_HOLE_R, CAP_Y1)),        # 背面
        ((CAP_HOLE_R, CAP_Y1), (CAP_HOLE_R, CAP_Y0 - 10.0)),                 # Ø60 孔壁
    ],
    splines=[],
)
cap.name = "WindowBox cap"
step("cap: %.3f cm3 (Ø%.0f 调整孔)" % (cap.volume, CAP_HOLE_R * 2))

for angle in SCREW_ANGLES:
    try:
        hole_at_y(CAP_Y0, SCREW_CLEAR_R, CAP_Y1 - CAP_Y0 + 1.0, angle, SCREW_R,
                  participant=cap)
    except Exception as exc:
        report["errors"].append("cap screw hole %.0f: %s" % (angle, exc))
step("cap: 4 x Ø%.1f clearance holes" % (SCREW_CLEAR_R * 2))

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
step("total %.3f cm3, %.1f g PLA" % (total, total * 1.24))

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

