# -*- coding: utf-8 -*-
"""Noorio B200 系列（B210/B211）球机 —— 优雅桌面支架 v5 "Arc"。

通过 FusionBridge 在 Fusion 360 里执行：
    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

# 设计约束（全部来自对已有模型的实测，不是目测）

`Bottom_bottom v2` 是绕 Z 轴的旋转体，总高 20mm：

    z 0→2   ⌀48 法兰   <- 安装面（原本贴桌面的那一面）
    z 2→10  M40x2 外螺纹（ISO 公制，60°，右旋）
    z 10→20 ⌀20 光圆柱
    z 15→20 ⌀18×5 盲孔

用户要求把该件旋转 90° 后竖直安装 —— 即让它的轴线水平。这里取**法兰面朝 -Y**，
因此摄像机朝 -Y 拍摄，+Z 向上。这个朝向与用户已有的 `Stand v4` 一致
（那一版把派生体的局部 z=0 面贴在立板正面 y=35 上）。

# 主要矛盾：重心

法兰是整个摄像机组（球 + 旋钮环 + 万向节）的悬臂根部。球径实测约 ⌀85，
后部接口是 1/4"-20 UNC 脚架孔；厂商公布的整机毛重 712~726g（含支架配件，
净重未公布）。所以取：

    重心距法兰面  CAMERA_CG_OFFSET = 80mm
    质量          CAMERA_MASS_G    = 450g（可调，见输出里的敏感性表）

对抗倾覆的手段有三个，都在参数里：
  1. 底座沿 Y 拉长（BASE_RY），并把圆心前移（BASE_CY，负值=前移）
  2. 安装面后移（PAD_FACE_Y），缩短有效悬臂
  3. 降低安装高度（PAD_Z），压低合成重心

坐标约定：Z 向上，摄像机看向 -Y。
"""

import math
import time

import adsk.core
import adsk.fusion

# --------------------------------------------------------------------------- #
# 参数（毫米 / 克）
# --------------------------------------------------------------------------- #

BASE_RX = 51.0
BASE_RY = 88.0
BASE_CY = -4.0          # 负值 = 底座圆心前移，前面多留料顶住悬臂
BASE_T = 12.0
BASE_TOP_FILLET = 10.0
BASE_BOT_FILLET = 3.0

# 立柱放样截面：(z, 截面中心 y, X 半宽, Y 半深)
#
# ⚠️ 硬约束（第一版就是在这里翻车的）：
# 摄像机组从安装面往前伸，其中 ⌀48 法兰占据「以 (x=0, z=PAD_Z) 为心、半径 24 的
# 圆盘，y ∈ [PAD_FACE_Y-2, PAD_FACE_Y]」。所以立柱在 z ∈ [PAD_Z-24, PAD_Z+24]
# 这一段的**前表面必须整体位于 PAD_FACE_Y 之后**，否则立柱会直接插进摄像机的
# 螺纹段和 ⌀20 凸台里。判据就是每段的 front = cy - hy ≥ PAD_FACE_Y + 间隙。
# 这也是为什么脊柱必须明显后倾 —— 不是审美选择，是净空逼出来的。
COLUMN_SECTIONS = [
    (8.0, 0.0, 27.0, 14.5),      # front -14.5  摄像机不在这个高度，随意
    (40.0, 12.0, 25.0, 12.5),    # front  -0.5
    (66.0, 24.0, 25.5, 11.5),    # front  12.5  ✓
    (92.0, 31.0, 24.0, 11.5),    # front  19.5  ✓
    (112.0, 37.0, 23.0, 11.5),   # front  25.5  ✓
    (126.0, 41.0, 22.0, 11.0),   # front  30.0  ✓
]

PAD_FACE_Y = 6.0        # 安装面（⌀48 法兰贴合处）—— 必须在立柱前表面之前
PAD_BACK_Y = 34.0       # 后端埋进立柱，免得徽章盘变成一个凸出来的圆桶
PAD_DIA = 58.0
PAD_Z = 96.0

RECESS_DIA = 48.8       # 让 ⌀48 法兰嵌进去的浅沉台
                        # （打印件别用 48.4：单边 0.2mm 根本塞不进，会崩边）
RECESS_DEPTH = 1.2

# 托边：下半圈的一道环带，托住 ⌀48 法兰。没有它，摄像机只会顺着竖直安装面滑下来
# —— 光靠"贴住"是撑不住的。只做下半圈，法兰才能从上方落进去。
LIP_ENABLED = True
LIP_INNER_R = 24.6      # 略大于法兰半径 24，留装配间隙
LIP_OUTER_R = 29.0      # 与徽章盘外径齐平，免得托边看起来像另加的一圈
LIP_DEPTH = 4.0

JUNCTION_FILLET = 5.0
PAD_FILLET = 3.0

CAMERA_MASS_G = 450.0
CAMERA_CG_OFFSET = 80.0
MASS_SENSITIVITY = [300.0, 450.0, 600.0, 726.0]
PLA_DENSITY = 1.24      # g/cm3

SAVE_NAME = "Stand v5"       # 空字符串 = 不保存，只留一个「无标题」
SAVE_PROJECT = "Noorio B310"

MM = 0.1  # 毫米 -> Fusion 内部单位（厘米）


def V(value_mm):
    return adsk.core.ValueInput.createByReal(value_mm * MM)


def P(x_mm, y_mm, z_mm):
    return adsk.core.Point3D.create(x_mm * MM, y_mm * MM, z_mm * MM)


def xz_sketch_point(sketch, x_mm, z_mm):
    """在「法线沿 Y」的草图里取点。

    实测坑：xZConstructionPlane 上草图的局部 Y 轴指向模型 **-Z**
    （yDirection = (0,0,-1)）。硬编码正号会把图形画到 z 为负的一侧 ——
    表现为徽章盘飘在模型下方、join 不接触、最后多出一个独立实体。
    这里按草图真实轴向的符号换算，换平面也不会再错。
    """
    xd = sketch.xDirection
    yd = sketch.yDirection
    sign_x = -1.0 if (xd.x + xd.y + xd.z) < 0 else 1.0
    if abs(yd.z) > 0.5:
        sign_y = 1.0 if yd.z > 0 else -1.0
    else:
        sign_y = -1.0 if (yd.x + yd.y + yd.z) < 0 else 1.0
    return adsk.core.Point3D.create(sign_x * x_mm * MM, sign_y * z_mm * MM, 0)


# --------------------------------------------------------------------------- #
# 建一个新文档
# --------------------------------------------------------------------------- #

report = {"steps": [], "errors": []}


def step(msg):
    report["steps"].append(msg)


# 上一次失败的构建会留下一个「无标题」文档；重跑前先关掉它（不保存），
# 否则每跑一次就多一个垃圾文档。
for i in range(app.documents.count):
    candidate = app.documents.item(i)
    try:
        product = candidate.products.itemByProductType("DesignProductType")
        candidate_design = adsk.fusion.Design.cast(product)
        candidate_root = candidate_design.rootComponent if candidate_design else None
    except Exception:
        candidate_root = None
    if candidate_root is None:
        continue
    try:
        stale = any(
            candidate_root.bRepBodies.item(j).name.startswith("Stand v5")
            for j in range(candidate_root.bRepBodies.count)
        )
    except Exception:
        stale = False
    if stale:
        stale_name = candidate.name
        try:
            candidate.close(False)
            step("closed previous build: %s" % stale_name)
        except Exception as exc:
            report["errors"].append("close previous build: %s" % exc)
        break

doc = None
for attempt in (
    lambda: app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType),
    lambda: app.documents.add(),
):
    try:
        doc = attempt()
        break
    except Exception as exc:
        report["errors"].append("documents.add: %s: %s" % (type(exc).__name__, exc))

if doc is None:
    result = report
else:
    for _ in range(80):
        adsk.doEvents()
        time.sleep(0.1)
        if adsk.fusion.Design.cast(app.activeProduct) is not None:
            break

    design = adsk.fusion.Design.cast(app.activeProduct)
    design.designType = adsk.fusion.DesignTypes.ParametricDesignType
    root = design.rootComponent
    report["document"] = app.activeDocument.name
    step("document created")

    # ------------------------------------------------------------------ #
    # 1. 鹅卵石底座
    # ------------------------------------------------------------------ #
    base_sketch = root.sketches.add(root.xYConstructionPlane)
    base_sketch.name = "base_outline"
    base_sketch.sketchCurves.sketchEllipses.add(
        P(0, BASE_CY, 0),
        P(0, BASE_CY + BASE_RY, 0),   # 长轴沿 Y
        P(BASE_RX, BASE_CY, 0),
    )
    base_profile = base_sketch.profiles.item(0)
    base_sketch.isVisible = False

    extrudes = root.features.extrudeFeatures
    ext_input = extrudes.createInput(
        base_profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation
    )
    ext_input.setDistanceExtent(False, V(BASE_T))
    base_feature = extrudes.add(ext_input)
    base_body = base_feature.bodies.item(0)
    base_body.name = "stand_base"
    step("base extruded")

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

    fillets = root.features.filletFeatures
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

    # ------------------------------------------------------------------ #
    # 2. 放样立柱（有机曲面 + 腰身 + 后倾）
    # ------------------------------------------------------------------ #
    loft_sections = adsk.core.ObjectCollection.create()
    for index, (z, cy, hx, hy) in enumerate(COLUMN_SECTIONS):
        plane_input = root.constructionPlanes.createInput()
        plane_input.setByOffset(root.xYConstructionPlane, V(z))
        plane = root.constructionPlanes.add(plane_input)
        section_sketch = root.sketches.add(plane)
        section_sketch.name = "column_section_%d" % index
        section_sketch.sketchCurves.sketchEllipses.add(
            P(0, cy, 0),
            P(hx, cy, 0),          # 长轴沿 X
            P(0, cy + hy, 0),
        )
        loft_sections.add(section_sketch.profiles.item(0))
        section_sketch.isVisible = False
    step("column sections: %d" % loft_sections.count)

    lofts = root.features.loftFeatures
    loft_input = None
    for factory in (
        lambda: lofts.createInput(adsk.fusion.FeatureOperations.NewBodyFeatureOperation),
        lambda: lofts.createInput(True),
    ):
        try:
            loft_input = factory()
            break
        except Exception as exc:
            report["errors"].append("loft createInput: %s" % exc)
    if loft_input is None:
        raise RuntimeError("cannot create loft input")
    for i in range(loft_sections.count):
        loft_input.loftSections.add(loft_sections.item(i))
    loft_input.isSolid = True
    try:
        loft_input.operation = adsk.fusion.FeatureOperations.NewBodyFeatureOperation
    except Exception:
        pass
    column_feature = lofts.add(loft_input)
    step("column lofted")

    all_bodies = [root.bRepBodies.item(i) for i in range(root.bRepBodies.count)]
    target = None
    tools = adsk.core.ObjectCollection.create()
    for body in all_bodies:
        if body.volume > 50.0 and target is None:
            target = body
        else:
            tools.add(body)
    if target is None or tools.count == 0:
        raise RuntimeError("cannot identify bodies to join")
    combine_input = root.features.combineFeatures.createInput(target, tools)
    combine_input.operation = adsk.fusion.FeatureOperations.JoinFeatureOperation
    root.features.combineFeatures.add(combine_input)
    body = root.bRepBodies.item(0)
    body.name = "Stand v5"
    step("joined -> %.2f cm3" % body.volume)

    # ------------------------------------------------------------------ #
    # 3. 顶部徽章安装盘（轴线沿 Y 的圆柱）
    # ------------------------------------------------------------------ #
    pad_plane_input = root.constructionPlanes.createInput()
    pad_plane_input.setByOffset(root.xZConstructionPlane, V(PAD_FACE_Y))
    pad_plane = root.constructionPlanes.add(pad_plane_input)
    pad_sketch = root.sketches.add(pad_plane)
    pad_sketch.name = "mount_pad"
    pad_sketch.sketchCurves.sketchCircles.addByCenterRadius(
        xz_sketch_point(pad_sketch, 0.0, PAD_Z),
        (PAD_DIA / 2.0) * MM,
    )
    pad_profile = pad_sketch.profiles.item(0)
    pad_sketch.isVisible = False

    pad_input = extrudes.createInput(
        pad_profile, adsk.fusion.FeatureOperations.JoinFeatureOperation
    )
    pad_input.setDistanceExtent(False, V(PAD_BACK_Y - PAD_FACE_Y))
    extrudes.add(pad_input)
    step("pad added -> %.2f cm3" % root.bRepBodies.item(0).volume)

    # ------------------------------------------------------------------ #
    # 4. 法兰沉台
    # ------------------------------------------------------------------ #
    recess_sketch = root.sketches.add(pad_plane)
    recess_sketch.name = "flange_recess"
    recess_sketch.sketchCurves.sketchCircles.addByCenterRadius(
        xz_sketch_point(recess_sketch, 0.0, PAD_Z),
        (RECESS_DIA / 2.0) * MM,
    )
    recess_input = extrudes.createInput(
        recess_sketch.profiles.item(0),
        adsk.fusion.FeatureOperations.CutFeatureOperation,
    )
    recess_input.setDistanceExtent(False, V(RECESS_DEPTH))
    extrudes.add(recess_input)
    recess_sketch.isVisible = False
    body = root.bRepBodies.item(0)
    step("recess cut -> %.2f cm3" % body.volume)

    # ------------------------------------------------------------------ #
    # 5. 接缝圆角 + 徽章盘边缘倒角（失败就跳过，模型仍然有效）
    # ------------------------------------------------------------------ #
    def try_fillet(label, edge_filter, radii_mm):
        """按从大到小试半径 —— 圆角失败通常是"这个位置放不下这么大"，
        降一档往往就过了，没必要为一个装饰性圆角让整个建模失败。"""
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

    # ------------------------------------------------------------------ #
    # 5b. 下半圈托边（托住法兰，防止沿竖直安装面下滑）
    # ------------------------------------------------------------------ #
    if LIP_ENABLED:
        try:
            lip_plane_input = root.constructionPlanes.createInput()
            lip_plane_input.setByOffset(
                root.xZConstructionPlane, V(PAD_FACE_Y - LIP_DEPTH)
            )
            lip_plane = root.constructionPlanes.add(lip_plane_input)
            lip_sketch = root.sketches.add(lip_plane)
            lip_sketch.name = "cradle_lip"
            lip_curves = lip_sketch.sketchCurves

            def lip_point(radius, phi_deg):
                phi = math.radians(phi_deg)
                return xz_sketch_point(
                    lip_sketch,
                    radius * math.cos(phi),
                    PAD_Z + radius * math.sin(phi),
                )

            start_deg, end_deg = 195.0, 345.0   # 270° = 正下方
            inner_start = lip_point(LIP_INNER_R, start_deg)
            inner_end = lip_point(LIP_INNER_R, end_deg)
            outer_start = lip_point(LIP_OUTER_R, start_deg)
            outer_end = lip_point(LIP_OUTER_R, end_deg)
            lip_curves.sketchArcs.addByThreePoints(
                inner_start, lip_point(LIP_INNER_R, 270.0), inner_end
            )
            lip_curves.sketchArcs.addByThreePoints(
                outer_end, lip_point(LIP_OUTER_R, 270.0), outer_start
            )
            lip_curves.sketchLines.addByTwoPoints(inner_start, outer_start)
            lip_curves.sketchLines.addByTwoPoints(inner_end, outer_end)

            lip_input = extrudes.createInput(
                lip_sketch.profiles.item(0),
                adsk.fusion.FeatureOperations.JoinFeatureOperation,
            )
            # 多伸 1mm 埋进主体，保证并集是实心连接而不是两个贴合的面
            lip_input.setDistanceExtent(False, V(LIP_DEPTH + 1.0))
            extrudes.add(lip_input)
            lip_sketch.isVisible = False
            step("cradle lip added")
        except Exception as exc:
            report["errors"].append("cradle lip failed: %s" % exc)
            step("cradle lip: FAILED (skipped)")

    body = root.bRepBodies.item(0)
    if root.bRepBodies.count > 1:
        report["errors"].append(
            "expected a single body, got %d: %s"
            % (root.bRepBodies.count,
               [root.bRepBodies.item(i).name for i in range(root.bRepBodies.count)])
        )

    # ------------------------------------------------------------------ #
    # 6. 物理属性 / 重心核算
    # ------------------------------------------------------------------ #
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
        # 摄像机重心近似取安装面高度，偏保守（真实值更低）
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
        "cameraAssumption": {
            "cgOffsetFromFlangeFace_mm": CAMERA_CG_OFFSET,
            "note": "球径⌀85、整机毛重712-726g（含配件）。净重未公布，故给出敏感性表。",
        },
        "footprint_y_mm": [round(footprint_front, 1), round(footprint_back, 1)],
        "balance": [combine(m) for m in MASS_SENSITIVITY],
        "balance_atAssumed": combine(CAMERA_MASS_G),
        "bodyCount": root.bRepBodies.count,
        "bbox_mm": {
            "min": [round(v / MM, 1) for v in
                    (body.boundingBox.minPoint.x, body.boundingBox.minPoint.y, body.boundingBox.minPoint.z)],
            "max": [round(v / MM, 1) for v in
                    (body.boundingBox.maxPoint.x, body.boundingBox.maxPoint.y, body.boundingBox.maxPoint.z)],
        },
    })

    # ------------------------------------------------------------------ #
    # 7. 存进项目 —— 别只留一个「无标题」，Fusion 一重启就没了
    # ------------------------------------------------------------------ #
    if SAVE_NAME:
        try:
            target_project = None
            for i in range(app.data.dataProjects.count):
                project_candidate = app.data.dataProjects.item(i)
                if project_candidate.name == SAVE_PROJECT:
                    target_project = project_candidate
                    break
            if target_project is None:
                report["errors"].append("project not found: %s" % SAVE_PROJECT)
            else:
                saved = doc.saveAs(SAVE_NAME, target_project.rootFolder, "", "")
                for _ in range(50):
                    adsk.doEvents()
                    time.sleep(0.1)
                    if doc.isSaved:
                        break
                report["savedAs"] = {
                    "name": SAVE_NAME,
                    "project": SAVE_PROJECT,
                    "returned": bool(saved),
                    "isSaved": bool(doc.isSaved),
                    "documentName": app.activeDocument.name,
                }
                step("saved as %r in %r (isSaved=%s)" % (SAVE_NAME, SAVE_PROJECT, doc.isSaved))
        except Exception as exc:
            report["errors"].append("saveAs failed: %s" % exc)

    result = report
