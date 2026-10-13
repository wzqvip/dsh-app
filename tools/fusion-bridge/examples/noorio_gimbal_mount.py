# -*- coding: utf-8 -*-
"""Noorio B200 系列 —— 球头万向节（"万向节"）建模，含内部镂空。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

# 尺寸（毫米，来自用户口述 + 两张带钢尺的照片）

    壳体外形   第一段 高15 外径 Ø53->Ø50；第二段 高15 锥段 Ø50->Ø23
    内部       球头侧起：2mm 塑料 / 2mm 镂空 / 1mm 内壁 / M42x1 内螺纹，深 15
               锥段是 2mm 塑料外壳，没有夹层，和外形融为一体
    球头       Ø17，从 Ø23 端面外露 4mm
    螺杆       Ø5 × 18，M5x0.8 6g 真实螺纹

径向叠加校验：外半径 26.5 − 2(外壁) − 2(镂空) − 1(内壁) = 21.5，
正好落在 M42x1 的牙顶半径（21.0 附近）—— 用户给的三层壁厚和螺纹是自洽的。

# 球头是怎么被锁住的（这条把结构讲通了）

球头坐在 `Bottom_bottom` 的 **Ø18 平底窝**里，壳体拧下去时**鼻口收口**从上方压住
球头，把它夹在「鼻口收口」和「窝底」之间 —— 所以这是个**可以锁紧的球关节**：
调好角度再拧紧。因此：

* Ø18 窝不是避让孔，是**下半个球窝**
* 鼻口收口内径必须小于球头在鼻口平面处的截面（Ø14.4），否则球会掉出去
  这里取 Ø14

# API 坑（都踩过）

1. **saveAs 用已存在的名字会新建文件，不是新版本** —— 因此这里改成
   打开现有文件 → 清空特征 → 重建 → save()，这样才产生 v(n+1)。
2. 外观库名是中文的；文档标签名带版本号；DeriveFeatureInput.sourceEntities
   要 Python 列表。
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
THREAD_DESIGNATION_PREFIX = "M42x1"
BORE_R = 20.4                                # 攻丝前底孔半径（Ø40.8 < 牙顶 20.94）

VOID_R0 = 22.5                               # 镂空内径
VOID_R1 = 24.5                               # 镂空外径（2mm 空腔）

SHELL = 2.0                                  # 锥段 2mm 塑料外壳

# ⚠️ 镂空开关。默认关闭，原因见文件头「关于镂空的实测结论」：
# 把「外壁 2mm / 镂空 2mm / 内壁 1mm」按**径向**字面实现，那 1mm 内壁会变成一根
# 两头开口的悬空管（底部 z=0 开口、顶部 z=15 被锥腔掏穿），结果 split 成两个
# 不相连的实体 —— 不是可制造的零件。需要用户确认镂空到底开在哪一端。
HOLLOW_ENABLED = False

BALL_D = 17.0
BALL_R = BALL_D / 2.0                        # 8.5
BALL_PROTRUDE = 4.0
BALL_TOP_Z = NOSE_Z + BALL_PROTRUDE          # 34.0
BALL_CENTER_Z = BALL_TOP_Z - BALL_R          # 25.5

SOCKET_R = BALL_R + 0.2                      # 8.7 球窝半径（留 0.2 间隙）
THROAT_R = 8.0                               # Ø16 喉口：小于球径，球卡住不掉

LIP_OPENING_R = 7.0                          # 鼻口收口 Ø14（< Ø14.4，球掉不出去）
LIP_UNDER_Z = 27.0                           # 收口外沿起点
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


def wait_active():
    for _ in range(100):
        adsk.doEvents()
        time.sleep(0.1)
        if adsk.fusion.Design.cast(app.activeProduct) is not None:
            return adsk.fusion.Design.cast(app.activeProduct)
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
# 打开现有文件（而不是 saveAs 新开一个）
# --------------------------------------------------------------------------- #

project = None
for i in range(app.data.dataProjects.count):
    p = app.data.dataProjects.item(i)
    if p.name == PROJECT_NAME:
        project = p
        break
if project is None:
    report["errors"].append("project not found: %s" % PROJECT_NAME)
    result = report
    raise SystemExit

folder = project.rootFolder
data_file = None
for i in range(folder.dataFiles.count):
    f = folder.dataFiles.item(i)
    if f.name == FILE_NAME:
        data_file = f
        break

doc = find_doc(FILE_NAME)
if doc is None:
    if data_file is None:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        step("no existing file, created new document")
    else:
        doc = app.documents.open(data_file, True)
        step("opened existing %s" % FILE_NAME)

design = wait_active()
root = design.rootComponent
step("document: %s, features=%d" % (doc.name, root.features.count))

# 清空旧特征（倒序删，避免依赖问题）
for i in range(root.features.count - 1, -1, -1):
    feature = root.features.item(i)
    name = feature.name
    try:
        feature.deleteMe()
    except Exception as exc:
        report["errors"].append("deleteMe %s: %s" % (name, exc))
step("cleared, features=%d bodies=%d" % (root.features.count, root.bRepBodies.count))

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
    """segments: [("line", (r,z), (r,z)), ("arc", (r,z), (rmid,zmid), (r,z))]"""
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xZConstructionPlane, V(0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = sketches.add(plane)
    sketch.name = name
    for segment in segments:
        kind = segment[0]
        if kind == "line":
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
# 1. 壳体外形（实心）
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

# --------------------------------------------------------------------------- #
# 2. 内部结构
# --------------------------------------------------------------------------- #

if not HOLLOW_ENABLED:
    # ---- 上一版可用结构：R8.7 球窝 + Ø16 喉口（球卡住不掉，但能任意转向）----
    dz = math.sqrt(max(SOCKET_R ** 2 - THROAT_R ** 2, 0.0))
    throat_bottom_z = BALL_CENTER_Z + dz
    ball_bottom_z = BALL_CENTER_Z - SOCKET_R
    mid = (math.cos(math.radians(-33.4)) * SOCKET_R,
           BALL_CENTER_Z + math.sin(math.radians(-33.4)) * SOCKET_R)
    socket = revolve("socket_tool", [
        ("arc", (0.0, ball_bottom_z), mid, (THROAT_R, throat_bottom_z)),
        ("line", (THROAT_R, throat_bottom_z), (THROAT_R, NOSE_Z + 2.0)),
        ("line", (THROAT_R, NOSE_Z + 2.0), (0.0, NOSE_Z + 2.0)),
        ("line", (0.0, NOSE_Z + 2.0), (0.0, ball_bottom_z)),
    ])
    cut(housing, socket)
    step("socket cut: %.3f cm3" % housing.volume)

if HOLLOW_ENABLED:
    # 2a. 攻丝底孔
    bore = revolve("bore_tool", [
        ("line", (0.0, 0.0), (BORE_R, 0.0)),
        ("line", (BORE_R, 0.0), (BORE_R, THREAD_DEPTH)),
        ("line", (BORE_R, THREAD_DEPTH), (0.0, THREAD_DEPTH)),
        ("line", (0.0, THREAD_DEPTH), (0.0, 0.0)),
    ])
    cut(housing, bore)
    step("bore cut: %.3f cm3" % housing.volume)

    # 2b. 2mm 环形镂空（第一段），向上通到锥腔
    void = revolve("void_tool", [
        ("line", (VOID_R0, 0.0), (VOID_R1, 0.0)),
        ("line", (VOID_R1, 0.0), (VOID_R1, SEG1_H)),
        ("line", (VOID_R1, SEG1_H), (VOID_R0, SEG1_H)),
        ("line", (VOID_R0, SEG1_H), (VOID_R0, 0.0)),
    ])
    cut(housing, void)
    step("void cut: %.3f cm3" % housing.volume)

    # 2c. 锥段 2mm 外壳（内腔自 z=15 的 r=23 收到 z=30 的 r=9.5）
    cone_outer_at_15 = SEG1_D1 / 2.0 - SHELL       # 23.0
    cone_outer_at_30 = SEG2_D1 / 2.0 - SHELL       # 9.5
    cone_cavity = revolve("cone_cavity_tool", [
        ("line", (cone_outer_at_15, SEG1_H), (cone_outer_at_30, NOSE_Z)),
        ("line", (cone_outer_at_30, NOSE_Z), (0.0, NOSE_Z)),
        ("line", (0.0, NOSE_Z), (0.0, SEG1_H)),
        ("line", (0.0, SEG1_H), (cone_outer_at_15, SEG1_H)),
    ])
    cut(housing, cone_cavity)
    step("cone cavity cut: %.3f cm3" % housing.volume)

    # 2d. 鼻口收口（把开口收到 Ø14，否则 Ø17 球头会掉出去）
    lip = revolve("nose_lip_tool", [
        ("line", (LIP_OPENING_R, NOSE_Z), (SEG2_D1 / 2.0, NOSE_Z)),
        ("line", (SEG2_D1 / 2.0, NOSE_Z), (SEG2_D1 / 2.0, LIP_UNDER_Z)),
        ("line", (SEG2_D1 / 2.0, LIP_UNDER_Z), (LIP_OPENING_R, LIP_INNER_Z)),
        ("line", (LIP_OPENING_R, LIP_INNER_Z), (LIP_OPENING_R, NOSE_Z)),
    ], operation=adsk.fusion.FeatureOperations.JoinFeatureOperation)
    step("nose lip joined: %.3f cm3" % housing.volume)

# --------------------------------------------------------------------------- #
# 3. M42x1 内螺纹（15mm 深）—— 只在镂空版里出现
# --------------------------------------------------------------------------- #
if HOLLOW_ENABLED:
  try:
    query = fusion.ThreadDataQuery.create(False)
    thread_type = "ISO Metric profile"
    designation = None
    for size in query.allSizes(thread_type):
        if not size.startswith("42"):
            continue
        for candidate in query.allDesignations(thread_type, size):
            if candidate.startswith(THREAD_DESIGNATION_PREFIX):
                designation = candidate
                break
        if designation:
            break
    if designation is None:
        report["errors"].append("%s not found" % THREAD_DESIGNATION_PREFIX)
    else:
        bore_face = None
        for face in housing.faces:
            geometry = face.geometry
            if (geometry.objectType.endswith("Cylinder")
                    and abs(geometry.radius * 10 - BORE_R) < 0.05):
                bore_face = face
                break
        if bore_face is None:
            report["errors"].append("bore cylindrical face not found for threading")
        else:
            # ⚠️ 内螺纹的 class 必须从表里取（外螺纹是 6g，内螺纹是 6H 之类）；
            #    硬写 "6H" 会报 "cannot get specific size for your input"
            classes = list(query.allClasses(True, thread_type, designation))
            thread_class = classes[0] if classes else "6H"
            info = fusion.ThreadInfo.create(True, True, thread_type, designation,
                                            thread_class, True)
            thread_input = root.features.threadFeatures.createInput(bore_face, info)
            thread_input.isFullLength = False
            try:
                thread_input.threadLength = V(THREAD_DEPTH)
            except Exception:
                pass
            thread_input.isModeled = True
            root.features.threadFeatures.add(thread_input)
            step("internal thread: %s %s, 深 %.0fmm (建模牙顶 %.3f)"
                 % (designation, thread_class, THREAD_DEPTH, info.majorDiameter * 10))
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
     (math.cos(math.radians(-8.5)) * BALL_R, BALL_CENTER_Z + math.sin(math.radians(-8.5)) * BALL_R),
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
        "mass_g_PLA": round(b.volume * 1.24, 1),
        "bbox_z_mm": [round(bb.minPoint.z * 10, 2), round(bb.maxPoint.z * 10, 2)],
        "maxRadius_mm": round(max(abs(bb.minPoint.x), abs(bb.maxPoint.x)) * 10, 2),
        "faceTypes": sorted({f.geometry.objectType.split("::")[-1] for f in b.faces}),
    })

try:
    if data_file is None:
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
    step("saved %s (isSaved=%s)" % (doc.name, doc.isSaved))
except Exception as exc:
    report["errors"].append("save: %s" % exc)

result = report
