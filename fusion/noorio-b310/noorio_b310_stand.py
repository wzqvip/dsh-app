# -*- coding: utf-8 -*-
"""Noorio 球机桌面支架 —— Stand v5（鹅卵石底座 + 放样立柱 + 圆形徽章安装盘）。

    python fusion/bridge_client.py exec --file <本文件>

本脚本**就地重建**工程里的 `Stand v5`：打开 → 校验文档身份 → 清空特征 → 重建 → save()。
不用 saveAs（用已存在的名字会新建文件，不是新版本）。

# ⚠️ 血泪教训：绝不可以用 app.activeProduct 取 design

本文件上一版（以及同期的其它脚本）里写过：

    doc = find_doc("Gimbal B210")
    design = wait_active()      # ← 取的是"当前活动文档"，不是 doc

而 Fusion 的 activate()/open() 在桥接（自定义事件处理器）里**会被延后**：
API 的 activeDocument 名字变了，但画布与真正的活动状态没跟上。结果
`wait_active()` 返回了另一个文档的 design，脚本就**把那个文档的特征全清空、
在里面重建了别的零件** —— 实际把用户的 Stand v5 覆盖成了万向节。

所以现在一律：`design = adsk.fusion.Design.cast(doc.products.itemByProductType(...))`，
并且写操作前 `_assert_identity()` 二次确认。

# 安装面

用户明确要求：安装面是**纯平面**，不要卡扣（下半圈托边），也不要定位沉台。
法兰直接贴在这个平面上。

坐标：Z 向上，摄像机朝 -Y。
"""

import math
import time

import adsk.core
import adsk.fusion

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

BASE_RX = 51.0
BASE_RY = 88.0
# ⚠️ 前移量是算出来的，不是拍的：
# 装配后相机自身重心在 y≈-89，而底座前缘原本在 -92 —— 相机重心几乎压在前缘正上方
# （只余 3mm），整机靠支架自重才拉回稳定。把底座前移 28mm 后，足迹变成
# [-120, +56]，相机重心落进足迹内约 31mm，抗倾覆从 34.9° 提到约 45°。
BASE_CY = -32.0
BASE_T = 12.0
BASE_TOP_FILLET = 10.0
BASE_BOT_FILLET = 3.0

# 立柱放样截面：(z, 截面中心 y, X 半宽, Y 半深)
#
# ⚠️ 硬约束：摄像机组从安装面往前伸，其中 ⌀48 法兰占据「以 (0, PAD_Z) 为心、
# 半径 24 的圆盘，y ∈ [PAD_FACE_Y-2, PAD_FACE_Y]」。所以立柱在
# z ∈ [PAD_Z-24, PAD_Z+24] 这一段的前表面必须整体位于 PAD_FACE_Y 之后，
# 判据 front = cy - hy ≥ PAD_FACE_Y + 间隙。脊柱的明显后倾是净空逼出来的。
COLUMN_SECTIONS = [
    (8.0, 0.0, 27.0, 14.5),      # front -14.5
    (40.0, 12.0, 25.0, 12.5),    # front  -0.5
    (66.0, 24.0, 25.5, 11.5),    # front  12.5  ✓
    (92.0, 31.0, 24.0, 11.5),    # front  19.5  ✓
    (112.0, 37.0, 23.0, 11.5),   # front  25.5  ✓
    (126.0, 41.0, 22.0, 11.0),   # front  30.0  ✓
]

PAD_FACE_Y = 6.0        # 安装面（法兰贴合处）
PAD_BACK_Y = 34.0
PAD_DIA = 58.0
PAD_Z = 96.0

# 用户明确要求：不要托边、不要定位沉台。两个开关留着，但默认关闭。
CRADLE_LIP_ENABLED = False
LOCATING_RECESS_ENABLED = False
RECESS_DIA = 48.8
RECESS_DEPTH = 1.2

LIP_INNER_R = 24.6
LIP_OUTER_R = 29.0
LIP_DEPTH = 4.0

JUNCTION_FILLET = 5.0

# 质量取自用户实测。⚠️ 这只是**简化模型**（只有支架 + 相机两项），
# 精确值以 `noorio_assembly.py` 为准 —— 那里把 Bottom_bottom / 万向节都算进去了，
# 而且相机重心高度用的是实体几何而非安装盘高度。两者结论一致（约 45°）。
CAMERA_MASS_G = 456.0        # 用户实测
CAMERA_CG_OFFSET = 95.0      # 相机自身重心距安装面（装配实测 89mm + 安装面到轴线 6mm）
MASS_SENSITIVITY = [300.0, 456.0, 600.0, 726.0]
PLA_DENSITY = 1.24

FILE_NAME = "Stand v5"
PROJECT_NAME = "Noorio B310"

MM = 0.1


def V(v):
    return adsk.core.ValueInput.createByReal(v * MM)


def P(x, y, z):
    return adsk.core.Point3D.create(x * MM, y * MM, z * MM)


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
    """⚠️ 关键：从 doc.products 直接取 design，绝不用 app.activeProduct。"""
    return adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))


# --------------------------------------------------------------------------- #
# 1. 打开（或新建）目标文档
# --------------------------------------------------------------------------- #

doc = find_doc(FILE_NAME)
created_new = False
if doc is None:
    existing, folder = project_file(FILE_NAME)
    if existing is not None:
        doc = app.documents.open(existing, True)
        # 给 Fusion 一点时间把新文档装进 API 世界（不做写操作）
        for _ in range(60):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved is not None:
                break
        step("opened existing %s" % FILE_NAME)
    else:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        created_new = True
        step("no existing file, created new document")

time.sleep(0.5)
adsk.doEvents()

design = design_of(doc)
root = design.rootComponent
report["targetDocument"] = doc.name

# 身份校验：万一 open() 被延后，宁可直接停手也不要清错文档
actual_name = doc.name
if not actual_name.startswith(FILE_NAME):
    report["errors"].append("identity check failed: %s" % actual_name)
    result = report
    raise SystemExit

step("target=%s features=%d bodies=%d" % (doc.name, root.features.count, root.bRepBodies.count))

# --------------------------------------------------------------------------- #
# 2. 清空特征，重建
# --------------------------------------------------------------------------- #

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
lofts = root.features.loftFeatures
fillets = root.features.filletFeatures


def edges_at_z(body, z_mm, tol=0.02):
    collection = adsk.core.ObjectCollection.create()
    found = 0
    for edge in body.edges:
        bb = edge.boundingBox
        lo = bb.minPoint.z / MM
        hi = bb.maxPoint.z / MM
        if abs(lo - z_mm) < tol and abs(hi - z_mm) < tol:
            collection.add(edge)
            found += 1
    return collection, found


# --- 底座 ------------------------------------------------------------------ #
base_sketch = sketches.add(root.xYConstructionPlane)
base_sketch.name = "base_outline"
base_sketch.sketchCurves.sketchEllipses.add(
    P(0, BASE_CY, 0),
    P(0, BASE_CY + BASE_RY, 0),      # 长轴沿 Y
    P(BASE_RX, BASE_CY, 0),
)
ext_input = extrudes.createInput(base_sketch.profiles.item(0),
                                 adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
ext_input.setDistanceExtent(False, V(BASE_T))
base_body = extrudes.add(ext_input).bodies.item(0)
base_body.name = "stand_base"
base_sketch.isVisible = False
step("base extruded")

fillet_input = fillets.createInput()
bottom_edges, n_bottom = edges_at_z(base_body, 0.0)
top_edges, n_top = edges_at_z(base_body, BASE_T)
if n_bottom:
    fillet_input.addConstantRadiusEdgeSet(bottom_edges, V(BASE_BOT_FILLET), False)
if n_top:
    fillet_input.addConstantRadiusEdgeSet(top_edges, V(BASE_TOP_FILLET), False)
if n_bottom or n_top:
    fillets.add(fillet_input)
    step("base fillets: bottom=%d top=%d" % (n_bottom, n_top))
base_body = root.bRepBodies.item(0)

# --- 立柱放样 -------------------------------------------------------------- #
loft_sections = adsk.core.ObjectCollection.create()
for index, (z, cy, hx, hy) in enumerate(COLUMN_SECTIONS):
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xYConstructionPlane, V(z))
    plane = root.constructionPlanes.add(plane_input)
    section_sketch = sketches.add(plane)
    section_sketch.name = "column_section_%d" % index
    section_sketch.sketchCurves.sketchEllipses.add(
        P(0, cy, 0),
        P(hx, cy, 0),
        P(0, cy + hy, 0),
    )
    loft_sections.add(section_sketch.profiles.item(0))
    section_sketch.isVisible = False

loft_input = lofts.createInput(adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
for i in range(loft_sections.count):
    loft_input.loftSections.add(loft_sections.item(i))
loft_input.isSolid = True
lofts.add(loft_input)
step("column lofted (%d sections)" % loft_sections.count)

# --- 并集 ------------------------------------------------------------------ #
all_bodies = [root.bRepBodies.item(i) for i in range(root.bRepBodies.count)]
target = None
tools = adsk.core.ObjectCollection.create()
for body in all_bodies:
    if body.volume > 50.0 and target is None:
        target = body
    else:
        tools.add(body)
combine_input = root.features.combineFeatures.createInput(target, tools)
combine_input.operation = adsk.fusion.FeatureOperations.JoinFeatureOperation
root.features.combineFeatures.add(combine_input)
body = root.bRepBodies.item(0)
body.name = "Stand v5"
step("joined -> %.2f cm3" % body.volume)


# --- 安装盘（轴线沿 Y 的圆柱）----------------------------------------------- #
def xz_point(sketch, x_mm, z_mm):
    """法线沿 Y 的草图取点。实测局部 Y 轴指向模型 -Z，必须按真实轴向换算。"""
    xd, yd = sketch.xDirection, sketch.yDirection
    sx = -1.0 if (xd.x + xd.y + xd.z) < 0 else 1.0
    if abs(yd.z) > 0.5:
        sy = 1.0 if yd.z > 0 else -1.0
    else:
        sy = -1.0 if (yd.x + yd.y + yd.z) < 0 else 1.0
    return adsk.core.Point3D.create(sx * x_mm * MM, sy * z_mm * MM, 0)


pad_plane_input = root.constructionPlanes.createInput()
pad_plane_input.setByOffset(root.xZConstructionPlane, V(PAD_FACE_Y))
pad_plane = root.constructionPlanes.add(pad_plane_input)
pad_sketch = sketches.add(pad_plane)
pad_sketch.name = "mount_pad"
pad_sketch.sketchCurves.sketchCircles.addByCenterRadius(
    xz_point(pad_sketch, 0.0, PAD_Z), (PAD_DIA / 2.0) * MM)
pad_input = extrudes.createInput(pad_sketch.profiles.item(0),
                                 adsk.fusion.FeatureOperations.JoinFeatureOperation)
pad_input.setDistanceExtent(False, V(PAD_BACK_Y - PAD_FACE_Y))
extrudes.add(pad_input)
pad_sketch.isVisible = False
step("pad added -> %.2f cm3" % root.bRepBodies.item(0).volume)

# --- 定位沉台（默认关闭：用户要求纯平面）------------------------------------ #
if LOCATING_RECESS_ENABLED:
    recess_sketch = sketches.add(pad_plane)
    recess_sketch.name = "flange_recess"
    recess_sketch.sketchCurves.sketchCircles.addByCenterRadius(
        xz_point(recess_sketch, 0.0, PAD_Z), (RECESS_DIA / 2.0) * MM)
    recess_input = extrudes.createInput(recess_sketch.profiles.item(0),
                                        adsk.fusion.FeatureOperations.CutFeatureOperation)
    recess_input.setDistanceExtent(False, V(RECESS_DEPTH))
    extrudes.add(recess_input)
    recess_sketch.isVisible = False
    step("locating recess cut")

# --- 接缝圆角 -------------------------------------------------------------- #
body = root.bRepBodies.item(0)


def try_fillet(label, edge_filter, radii_mm):
    if isinstance(radii_mm, (int, float)):
        radii_mm = [radii_mm]
    collection = adsk.core.ObjectCollection.create()
    count = 0
    for edge in body.edges:
        if edge_filter(edge):
            collection.add(edge)
            count += 1
    if count == 0:
        step("%s: no edges matched" % label)
        return
    for radius_mm in radii_mm:
        try:
            fin = fillets.createInput()
            fin.addConstantRadiusEdgeSet(collection, V(radius_mm), False)
            fillets.add(fin)
            step("%s: filleted %d edges R%.1f" % (label, count, radius_mm))
            return
        except Exception as exc:
            report["errors"].append("%s R%.1f failed: %s" % (label, radius_mm, exc))
    step("%s: FAILED at every radius (skipped)" % label)


def is_column_base_junction(edge):
    bb = edge.boundingBox
    lo, hi = bb.minPoint.z / MM, bb.maxPoint.z / MM
    if abs(lo - BASE_T) > 0.05 or abs(hi - BASE_T) > 0.05:
        return False
    return (abs(bb.minPoint.x) / MM < 32.0) and (abs(bb.maxPoint.x) / MM < 32.0)


def is_pad_junction(edge):
    bb = edge.boundingBox
    ys = (bb.minPoint.y / MM, bb.maxPoint.y / MM)
    if ys[0] < PAD_FACE_Y + 0.5 or ys[1] > PAD_BACK_Y + 0.5:
        return False
    for corner in (bb.minPoint, bb.maxPoint):
        dx = corner.x / MM
        dz = corner.z / MM - PAD_Z
        if math.hypot(dx, dz) > (PAD_DIA / 2.0) + 1.0:
            return False
    return True


try_fillet("column/base junction", is_column_base_junction, [5.0, 4.0, 3.0])
try_fillet("pad junction", is_pad_junction, [3.0, 2.0, 1.5])

# --- 托边（默认关闭：用户要求不要卡扣）-------------------------------------- #
if CRADLE_LIP_ENABLED:
    try:
        lip_plane_input = root.constructionPlanes.createInput()
        lip_plane_input.setByOffset(root.xZConstructionPlane, V(PAD_FACE_Y - LIP_DEPTH))
        lip_plane = root.constructionPlanes.add(lip_plane_input)
        lip_sketch = sketches.add(lip_plane)
        lip_sketch.name = "cradle_lip"
        lip_curves = lip_sketch.sketchCurves

        def lip_point(radius, phi_deg):
            phi = math.radians(phi_deg)
            return xz_point(lip_sketch, radius * math.cos(phi), PAD_Z + radius * math.sin(phi))

        inner_start = lip_point(LIP_INNER_R, 195.0)
        inner_end = lip_point(LIP_INNER_R, 345.0)
        outer_start = lip_point(LIP_OUTER_R, 195.0)
        outer_end = lip_point(LIP_OUTER_R, 345.0)
        lip_curves.sketchArcs.addByThreePoints(inner_start, lip_point(LIP_INNER_R, 270.0), inner_end)
        lip_curves.sketchArcs.addByThreePoints(outer_end, lip_point(LIP_OUTER_R, 270.0), outer_start)
        lip_curves.sketchLines.addByTwoPoints(inner_start, outer_start)
        lip_curves.sketchLines.addByTwoPoints(inner_end, outer_end)
        lip_input = extrudes.createInput(lip_sketch.profiles.item(0),
                                         adsk.fusion.FeatureOperations.JoinFeatureOperation)
        lip_input.setDistanceExtent(False, V(LIP_DEPTH + 1.0))
        extrudes.add(lip_input)
        lip_sketch.isVisible = False
        step("cradle lip added")
    except Exception as exc:
        report["errors"].append("cradle lip: %s" % exc)

# --------------------------------------------------------------------------- #
# 3. 物理属性 / 重心
# --------------------------------------------------------------------------- #

body = root.bRepBodies.item(0)
props = body.getPhysicalProperties(adsk.fusion.CalculationAccuracy.HighCalculationAccuracy)
com = props.centerOfMass
volume_cm3 = body.volume
stand_mass = volume_cm3 * PLA_DENSITY
stand_cg_y = com.y / MM
stand_cg_z = com.z / MM

footprint_front = BASE_CY - BASE_RY
footprint_back = BASE_CY + BASE_RY
camera_cg_y = PAD_FACE_Y - CAMERA_CG_OFFSET


def combine(camera_mass_g):
    total = stand_mass + camera_mass_g
    cg_y = (stand_mass * stand_cg_y + camera_mass_g * camera_cg_y) / total
    cg_z = (stand_mass * stand_cg_z + camera_mass_g * PAD_Z) / total
    front_margin = cg_y - footprint_front
    return {
        "cameraMass_g": camera_mass_g,
        "combinedCoG_y_mm": round(cg_y, 1),
        "combinedCoG_z_mm": round(cg_z, 1),
        "frontMargin_mm": round(front_margin, 1),
        "tipAngleDeg_aboutFrontEdge": round(math.degrees(math.atan2(front_margin, cg_z)), 1),
    }


report.update({
    "standVolume_cm3": round(volume_cm3, 2),
    "standMass_g_PLA": round(stand_mass, 1),
    "standCoG_mm": {"y": round(stand_cg_y, 2), "z": round(stand_cg_z, 2)},
    "footprint_y_mm": [round(footprint_front, 1), round(footprint_back, 1)],
    "balance": [combine(m) for m in MASS_SENSITIVITY],
    "balance_atAssumed": combine(CAMERA_MASS_G),
    "bodyCount": root.bRepBodies.count,
})

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
