# -*- coding: utf-8 -*-
"""Noorio B200 系列 —— 球头万向节（"万向节"）建模。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

本脚本**就地重建**工程里的 `Gimbal B210`：打开 → 校验身份 → 清空特征 → 重建 → save()。

# 尺寸（毫米，用户口述 + 两张带钢尺的照片）

    壳体外形   第一段 高15 外径 Ø53->Ø50；第二段 高15 锥段 Ø50->Ø23
    内腔       第一段壁厚 5mm；锥段壁厚 2mm
    内螺纹     M42x1，深 15（配 Bottom_bottom 的外螺纹）
    球头       Ø17，从 Ø23 端面外露 4mm
    螺杆       Ø5 × 18，M5x0.8 6g 真实螺纹

关于壁厚：外半径在 z=0 是 26.5、z=15 是 25，是个微锥。取圆柱内孔 Ø41
（BORE_R=20.5）后，壁厚从 6.0 收到 4.5，均值 ≈5.3mm，与"5mm"一致；
同时 Ø41 落在 M42x1 的牙底 40.737 与牙顶 41.884 之间，Fusion 才能攻出内螺纹
（内孔若取到 Ø42 就等于牙顶，没有料可切）。

# 鼻口收口是必须的

球头在鼻口平面（z=30）处的截面是 Ø14.4（球心在端面下方 4.5mm）。
锥段只有 2mm 壁厚时，内腔在 z=30 的半径是 9.5（Ø19）—— **Ø17 球头会直接掉出去**。
所以鼻口必须收口到 Ø13.5 才能卡住球头。

# ⚠️ 血泪教训：绝不可以用 app.activeProduct 取 design

上一版这里写的是 `design = wait_active()`，取的是"当前活动文档"。
而 Fusion 的 activate()/open() 在桥接（自定义事件处理器）里**会被延后** ——
API 的 activeDocument 名字变了，但真正的活动状态没跟上。结果脚本拿着**另一个
文档**的 design 继续跑，把那个文档的特征清空、在里面重建了本零件，
**实际覆盖掉了用户的 Stand v5**。

所以现在一律 `design = adsk.fusion.Design.cast(doc.products.itemByProductType(...))`，
写完前再校验一次 doc.name。
"""

import math
import time

import adsk.core
import adsk.fusion

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

SEG1_H = 15.0
SEG1_D0 = 53.0
SEG1_D1 = 50.0

SEG2_H = 15.0
SEG2_D0 = 50.0
SEG2_D1 = 23.0

NOSE_Z = SEG1_H + SEG2_H                     # 30.0

THREAD_DEPTH = 15.0                          # M42x1 内螺纹深度
THREAD_PREFIX = "M42x1"
BORE_R = 20.5                                # Ø41 内孔（牙底 40.737 < 41 < 牙顶 41.884）

SHELL = 2.0                                  # 锥段 2mm 壁厚

BALL_D = 17.0
BALL_R = BALL_D / 2.0                        # 8.5
BALL_PROTRUDE = 4.0
BALL_TOP_Z = NOSE_Z + BALL_PROTRUDE          # 34.0
BALL_CENTER_Z = BALL_TOP_Z - BALL_R          # 25.5

LIP_OPENING_R = 6.75                         # 鼻口收口 Ø13.5（< Ø14.4，球掉不出去）
LIP_UNDER_Z = 27.0
LIP_INNER_Z = 28.5

STUD_R = 2.5
STUD_LEN = 18.0
STUD_TOP_Z = BALL_TOP_Z + STUD_LEN           # 52.0

HOUSING_APPEARANCE = "塑料 - 粗面(白色)"
BALL_APPEARANCE = "铬"

FILE_NAME = "Gimbal B210"
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


def project_file(file_name):
    for i in range(app.data.dataProjects.count):
        p = app.data.dataProjects.item(i)
        if p.name != PROJECT_NAME:
            continue
        folder = p.rootFolder
        for j in range(folder.dataFiles.count):
            f = folder.dataFiles.item(j)
            if f.name == file_name:
                return f, folder
    return None, None


def design_of(doc):
    """⚠️ 只从 doc 自己身上取 design。用 app.activeProduct 会踩到未切换的文档。"""
    return adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))


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
# 1. 打开（或新建）
# --------------------------------------------------------------------------- #

doc = find_doc(FILE_NAME)
created_new = False
if doc is None:
    existing, folder = project_file(FILE_NAME)
    if existing is not None:
        doc = app.documents.open(existing, True)
        for _ in range(60):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved is not None:
                break
        step("opened existing %s" % FILE_NAME)
    else:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        created_new = True
        step("created new document")

time.sleep(0.5)
adsk.doEvents()

design = design_of(doc)
root = design.rootComponent
report["targetDocument"] = doc.name
if not doc.name.startswith(FILE_NAME):
    report["errors"].append("identity check failed: %s" % doc.name)
    result = report
    raise SystemExit
step("target=%s features=%d" % (doc.name, root.features.count))

for i in range(root.features.count - 1, -1, -1):
    feature = root.features.item(i)
    name = feature.name
    try:
        feature.deleteMe()
    except Exception as exc:
        report["errors"].append("deleteMe %s: %s" % (name, exc))
step("cleared -> features=%d bodies=%d" % (root.features.count, root.bRepBodies.count))

# --------------------------------------------------------------------------- #
# 几何辅助
# --------------------------------------------------------------------------- #

sketches = root.sketches
revolves = root.features.revolveFeatures
combines = root.features.combineFeatures


def xz_point(sketch, x_mm, z_mm):
    xd, yd = sketch.xDirection, sketch.yDirection
    sx = -1.0 if (xd.x + xd.y + xd.z) < 0 else 1.0
    if abs(yd.z) > 0.5:
        sy = 1.0 if yd.z > 0 else -1.0
    else:
        sy = -1.0 if (yd.x + yd.y + yd.z) < 0 else 1.0
    return adsk.core.Point3D.create(sx * x_mm * MM, sy * z_mm * MM, 0)


def revolve(name, segments, operation=adsk.fusion.FeatureOperations.NewBodyFeatureOperation):
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xZConstructionPlane, V(0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    sketch.name = name
    for segment in segments:
        if segment[0] == "line":
            sketch.sketchCurves.sketchLines.addByTwoPoints(
                xz_point(sketch, segment[1][0], segment[1][1]),
                xz_point(sketch, segment[2][0], segment[2][1]))
        else:
            sketch.sketchCurves.sketchArcs.addByThreePoints(
                xz_point(sketch, segment[1][0], segment[1][1]),
                xz_point(sketch, segment[2][0], segment[2][1]),
                xz_point(sketch, segment[3][0], segment[3][1]))
    if sketch.profiles.count < 1:
        raise RuntimeError("%s: profile not closed (%d)" % (name, sketch.profiles.count))
    rev_input = revolves.createInput(sketch.profiles.item(0), root.zConstructionAxis, operation)
    try:
        rev_input.setFullExtent()
    except Exception:
        rev_input.setAngleExtent(False, adsk.core.ValueInput.createByReal(2 * math.pi))
    feature = revolves.add(rev_input)
    sketch.isVisible = False
    return feature.bodies.item(0)


def cut(target, tool):
    tools = adsk.core.ObjectCollection.create()
    tools.add(tool)
    combine_input = combines.createInput(target, tools)
    combine_input.operation = adsk.fusion.FeatureOperations.CutFeatureOperation
    combines.add(combine_input)


# --------------------------------------------------------------------------- #
# 2. 壳体
# --------------------------------------------------------------------------- #

housing = revolve("housing_outer", [
    ("line", (0.0, 0.0), (SEG1_D0 / 2.0, 0.0)),
    ("line", (SEG1_D0 / 2.0, 0.0), (SEG1_D1 / 2.0, SEG1_H)),
    ("line", (SEG1_D1 / 2.0, SEG1_H), (SEG2_D1 / 2.0, NOSE_Z)),
    ("line", (SEG2_D1 / 2.0, NOSE_Z), (0.0, NOSE_Z)),
    ("line", (0.0, NOSE_Z), (0.0, 0.0)),
])
housing.name = "Gimbal housing"
step("housing outer: %.3f cm3" % housing.volume)

# 2a. 第一段内孔：圆柱 Ø41，深 15 -> 该段壁厚 6.0 收到 4.5
bore = revolve("bore_tool", [
    ("line", (0.0, 0.0), (BORE_R, 0.0)),
    ("line", (BORE_R, 0.0), (BORE_R, THREAD_DEPTH)),
    ("line", (BORE_R, THREAD_DEPTH), (0.0, THREAD_DEPTH)),
    ("line", (0.0, THREAD_DEPTH), (0.0, 0.0)),
])
cut(housing, bore)
step("bore cut: %.3f cm3" % housing.volume)

# 2b. 锥段内腔：2mm 壁厚，自 z=15 的 r=23 收到 z=30 的 r=9.5
cone_r0 = SEG1_D1 / 2.0 - SHELL
cone_r1 = SEG2_D1 / 2.0 - SHELL
cone_cavity = revolve("cone_cavity_tool", [
    ("line", (cone_r0, SEG1_H), (cone_r1, NOSE_Z)),
    ("line", (cone_r1, NOSE_Z), (0.0, NOSE_Z)),
    ("line", (0.0, NOSE_Z), (0.0, SEG1_H)),
    ("line", (0.0, SEG1_H), (cone_r0, SEG1_H)),
])
cut(housing, cone_cavity)
step("cone cavity (2mm shell): %.3f cm3" % housing.volume)

# 2c. 鼻口收口：否则 Ø17 球头会从 Ø19 的锥腔内孔掉出去
lip = revolve("nose_lip_tool", [
    ("line", (LIP_OPENING_R, NOSE_Z), (SEG2_D1 / 2.0, NOSE_Z)),
    ("line", (SEG2_D1 / 2.0, NOSE_Z), (SEG2_D1 / 2.0, LIP_UNDER_Z)),
    ("line", (SEG2_D1 / 2.0, LIP_UNDER_Z), (LIP_OPENING_R, LIP_INNER_Z)),
    ("line", (LIP_OPENING_R, LIP_INNER_Z), (LIP_OPENING_R, NOSE_Z)),
], operation=adsk.fusion.FeatureOperations.JoinFeatureOperation)
step("nose lip (Ø%.1f): %.3f cm3" % (LIP_OPENING_R * 2, housing.volume))

# --------------------------------------------------------------------------- #
# 3. M42x1 内螺纹（深 15）
# --------------------------------------------------------------------------- #
try:
    query = fusion.ThreadDataQuery.create(False)
    thread_type = "ISO Metric profile"
    designation = None
    for size in query.allSizes(thread_type):
        if not size.startswith("42"):
            continue
        for candidate in query.allDesignations(thread_type, size):
            # ⚠️ 必须精确匹配：startswith("M42x1") 会把 M42x1.5 也吃进去，
            #    建出来的牙顶 42.208 / 牙底 40.526 与 Bottom_bottom 的
            #    M42x1（41.884 / 40.737）配不上。
            if candidate.strip() == THREAD_PREFIX:
                designation = candidate
                break
        if designation:
            break
    if designation is None:
        report["errors"].append("%s not found" % THREAD_PREFIX)
    else:
        bore_face = None
        for face in housing.faces:
            geometry = face.geometry
            if (geometry.objectType.endswith("Cylinder")
                    and abs(geometry.radius * 10 - BORE_R) < 0.05):
                bore_face = face
                break
        if bore_face is None:
            report["errors"].append("bore face not found for threading")
        else:
            # 内螺纹的 class 必须从表里取（硬写 "6H" 会报
            # "cannot get specific size for your input"）
            classes = list(query.allClasses(True, thread_type, designation))
            thread_class = classes[0] if classes else "6H"
            # ⚠️ 签名是 create(isTapered, isInternal, ...)。第一个参数传 True 会去查
            #    锥管螺纹表，M42x1 当然找不到 -> "cannot get specific size for your input"
            info = fusion.ThreadInfo.create(False, True, thread_type, designation,
                                            thread_class, True)
            thread_input = root.features.threadFeatures.createInput(bore_face, info)
            thread_input.isFullLength = False
            try:
                thread_input.threadLength = V(THREAD_DEPTH)
            except Exception:
                pass
            thread_input.isModeled = True
            root.features.threadFeatures.add(thread_input)
            step("internal thread: %s %s 深 %.0f (牙顶 %.3f / 牙底 %.3f)"
                 % (designation, thread_class, THREAD_DEPTH,
                    info.majorDiameter * 10, info.minorDiameter * 10))
except Exception as exc:
    report["errors"].append("internal thread: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 4. 球头 + 螺杆
# --------------------------------------------------------------------------- #
stud_root_z = BALL_CENTER_Z + math.sqrt(max(BALL_R ** 2 - STUD_R ** 2, 0.0))
ball = revolve("ball_and_stud", [
    ("line", (0.0, STUD_TOP_Z), (STUD_R, STUD_TOP_Z)),
    ("line", (STUD_R, STUD_TOP_Z), (STUD_R, stud_root_z)),
    ("arc", (STUD_R, stud_root_z),
     (math.cos(math.radians(-8.5)) * BALL_R,
      BALL_CENTER_Z + math.sin(math.radians(-8.5)) * BALL_R),
     (0.0, BALL_CENTER_Z - BALL_R)),
    ("line", (0.0, BALL_CENTER_Z - BALL_R), (0.0, STUD_TOP_Z)),
])
ball.name = "Ball stud"
step("ball+stud: %.3f cm3" % ball.volume)

try:
    stud_face = None
    for face in ball.faces:
        geometry = face.geometry
        if (geometry.objectType.endswith("Cylinder")
                and abs(geometry.radius * 10 - STUD_R) < 0.01):
            stud_face = face
            break
    if stud_face is not None:
        query = fusion.ThreadDataQuery.create(False)
        thread_type = "ISO Metric profile"
        designation = None
        for size in query.allSizes(thread_type):
            if not size.startswith("5"):
                continue
            for candidate in query.allDesignations(thread_type, size):
                if candidate.startswith("M5x0.8"):
                    designation = candidate
                    break
            if designation:
                break
        if designation:
            info = fusion.ThreadInfo.create(False, False, thread_type, designation, "6g", True)
            thread_input = root.features.threadFeatures.createInput(stud_face, info)
            thread_input.isModeled = True
            root.features.threadFeatures.add(thread_input)
            step("stud thread: %s 6g (模型外径 %.3f)" % (designation, info.majorDiameter * 10))
except Exception as exc:
    report["errors"].append("stud thread: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 5. 材质
# --------------------------------------------------------------------------- #
for body, appearance_name in ((housing, HOUSING_APPEARANCE), (ball, BALL_APPEARANCE)):
    appearance = find_appearance(appearance_name)
    if appearance is None:
        report["errors"].append("appearance not found: %s" % appearance_name)
        continue
    try:
        body.appearance = appearance
        step("appearance %r -> %s" % (appearance_name, body.name))
    except Exception as exc:
        report["errors"].append("appearance: %s" % exc)

# --------------------------------------------------------------------------- #
# 6. 量结果 + 保存
# --------------------------------------------------------------------------- #
report["bodies"] = []
for i in range(root.bRepBodies.count):
    b = root.bRepBodies.item(i)
    bb = b.boundingBox
    report["bodies"].append({
        "name": b.name,
        "volume_cm3": round(b.volume, 3),
        "bbox_z_mm": [round(bb.minPoint.z * 10, 2), round(bb.maxPoint.z * 10, 2)],
        "maxRadius_mm": round(max(abs(bb.minPoint.x), abs(bb.maxPoint.x)) * 10, 2),
        "faceTypes": sorted({f.geometry.objectType.split("::")[-1] for f in b.faces}),
    })
report["bodyCount"] = root.bRepBodies.count

try:
    if created_new:
        _, folder = project_file(FILE_NAME)
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
