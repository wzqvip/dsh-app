# -*- coding: utf-8 -*-
"""Noorio B200 系列球机 —— 摄像头本体建模。

    python fusion/bridge_client.py exec --file <本文件>

用户口述的尺寸（毫米）：

    后半部分         半圆，直径 100，半径 50
    最尾部           Ø5 螺丝孔
    另一侧第一段     厚 27，按同等半圆收口，Ø100 -> Ø90
    唤醒补光灯环     厚 8，Ø90 -> Ø60
    感应区域         厚 5，Ø60 -> Ø20
    最后             平的摄像头（镜头面）

⚠️ 单位踩过一次：用户把后两项写成 "0.8mm / 0.5mm"，我按字面取成了 mm，
结果前脸只有 1.3mm 的台阶、总深 78.3。用户随后明确是 **cm**（0.8cm / 0.5cm），
即 8mm / 5mm，总深 90mm。别再用"和厂商公布的 75.7 对得上"来反推单位 ——
那个巧合是错的。

整体是一个绕 Z 轴的旋转体，所以用**一次 revolve** 做出来最干净。
坐标：Z 为轴，前端朝 +Z，尾部在 -Z。
"""

import math
import time

import adsk.core
import adsk.fusion

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

BALL_R = 50.0            # 后半球半径（Ø100）
REAR_DEPTH = 50.0        # 后半球轴向深度 = BALL_R
FRONT_ZONE_LEN = 27.0    # 前段等半圆收口长度
FRONT_ZONE_R0 = 50.0     # 收口起点半径（赤道 Ø100）
FRONT_ZONE_R1 = 45.0     # 收口终点半径（Ø90）

FILL_LIGHT_LEN = 8.0     # 唤醒补光灯环轴向厚度（0.8cm）
FILL_LIGHT_R = 30.0      # 该环内缘半径（Ø60）

SENSOR_LEN = 5.0         # 感应区域轴向厚度（0.5cm）
SENSOR_R = 10.0          # 感应区内缘半径（Ø20）

REAR_HOLE_D = 5.0        # 尾部螺丝孔
REAR_HOLE_DEPTH = 10.0

SAVE_NAME = "Camera B210"
SAVE_PROJECT = "Noorio B310"

MM = 0.1


def V(v):
    return adsk.core.ValueInput.createByReal(v * MM)


report = {"steps": [], "errors": [], "params": {}}


def step(msg):
    report["steps"].append(msg)


def xz_point(sketch, x_mm, z_mm):
    """法线沿 Y 的草图取点。实测局部 Y 轴指向模型 -Z，必须按真实轴向换算。"""
    xd, yd = sketch.xDirection, sketch.yDirection
    sx = -1.0 if (xd.x + xd.y + xd.z) < 0 else 1.0
    if abs(yd.z) > 0.5:
        sy = 1.0 if yd.z > 0 else -1.0
    else:
        sy = -1.0 if (yd.x + yd.y + yd.z) < 0 else 1.0
    return adsk.core.Point3D.create(sx * x_mm * MM, sy * z_mm * MM, 0)


# --------------------------------------------------------------------------- #
# 顺带把 M42x1 的螺纹表数据报出来（用户要用它替代 M40x2）
# --------------------------------------------------------------------------- #

try:
    q = fusion.ThreadDataQuery.create(False)
    tt = "ISO Metric profile"
    thread_rows = []
    for size in q.allSizes(tt):
        if not size.startswith("42"):
            continue
        for designation in q.allDesignations(tt, size):
            for cls in q.allClasses(False, tt, designation):
                ti = fusion.ThreadInfo.create(False, False, tt, designation, cls, True)
                thread_rows.append({
                    "designation": designation, "class": cls,
                    "major_mm": round(ti.majorDiameter * 10, 4),
                    "minor_mm": round(ti.minorDiameter * 10, 4),
                    "pitch_mm": round(ti.threadPitch * 10, 4),
                })
    report["M42_thread_table"] = thread_rows
except Exception as exc:
    report["errors"].append("thread table query: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 新文档（先关掉上一次跑失败留下的空文档，免得越堆越多）
# --------------------------------------------------------------------------- #

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
        stale = (
            (candidate_root.bRepBodies.count == 0
             and candidate_root.features.count > 0
             and candidate.name.startswith("无标题"))
            or candidate.name.startswith(SAVE_NAME)
        )
    except Exception:
        stale = False
    if stale:
        stale_name = candidate.name
        try:
            candidate.close(False)
            step("closed stale document: %s" % stale_name)
        except Exception as exc:
            report["errors"].append("close stale doc: %s" % exc)
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
    # 注意：design.unitsManager.defaultLengthUnits 是只读的，别想着在这里改单位
    step("document created, units=%s" % design.unitsManager.defaultLengthUnits)

    sketch = root.sketches.add(root.xZConstructionPlane)
    sketch.name = "camera_profile"
    curves = sketch.sketchCurves

    z_eq = 0.0                                        # 赤道
    z_front_arc_end = FRONT_ZONE_LEN                  # 收口末端
    z_fill_end = z_front_arc_end + FILL_LIGHT_LEN
    z_sensor_end = z_fill_end + SENSOR_LEN
    z_rear_pole = -REAR_DEPTH
    z_bore_bottom = z_rear_pole + REAR_HOLE_DEPTH
    r_hole = REAR_HOLE_D / 2.0

    # 前段收口弧：过 (R0, 0) 与 (R1, L)，且在赤道处切线竖直（与后半球光滑相接）
    # 切线竖直 => 圆心与 (R0, 0) 同 z，即圆心在 (R0 - Rc, 0)，Rc 为弧半径。
    #   (R1 - (R0 - Rc))^2 + L^2 = Rc^2
    #   (d + Rc)^2 + L^2 = Rc^2,  d = R1 - R0
    #   2*d*Rc = -(d^2 + L^2)
    #   Rc = -(d^2 + L^2) / (2*d)
    # ⚠️ 这里踩过一次：把式子写成 (R1² + L² - R0²)/(2(R1-R0)) 会得到负数，
    #    弧退化成一条甩到 r≈100 的大弧，模型直接变成 Ø227。
    d_r = FRONT_ZONE_R1 - FRONT_ZONE_R0
    rc = -(d_r ** 2 + FRONT_ZONE_LEN ** 2) / (2.0 * d_r)
    center_r = FRONT_ZONE_R0 - rc
    report["params"]["frontArcRadius"] = round(rc, 4)
    report["params"]["frontArcCenter_r"] = round(center_r, 4)

    # 弧中点（用于三点定弧）
    a0 = math.atan2(0.0 - 0.0, FRONT_ZONE_R0 - center_r)
    a1 = math.atan2(z_front_arc_end, FRONT_ZONE_R1 - center_r)
    am = (a0 + a1) / 2.0
    front_mid = (center_r + rc * math.cos(am), rc * math.sin(am))

    # 后半球弧中点：极角 -45°
    rear_mid = (BALL_R * math.cos(math.radians(-45)),
                BALL_R * math.sin(math.radians(-45)))

    p_rear_hole = xz_point(sketch, r_hole, z_rear_pole)
    p_rear_mid = xz_point(sketch, rear_mid[0], rear_mid[1])
    p_equator = xz_point(sketch, FRONT_ZONE_R0, z_eq)
    p_front_mid = xz_point(sketch, front_mid[0], front_mid[1])
    p_front_end = xz_point(sketch, FRONT_ZONE_R1, z_front_arc_end)
    p_fill_end = xz_point(sketch, FILL_LIGHT_R, z_fill_end)
    p_sensor_end = xz_point(sketch, SENSOR_R, z_sensor_end)
    p_axis_front = xz_point(sketch, 0.0, z_sensor_end)
    p_axis_bore = xz_point(sketch, 0.0, z_bore_bottom)
    p_bore_wall = xz_point(sketch, r_hole, z_bore_bottom)

    try:
        curves.sketchArcs.addByThreePoints(p_rear_hole, p_rear_mid, p_equator)
        step("rear hemisphere arc")
    except Exception as exc:
        report["errors"].append("rear arc: %s: %s" % (type(exc).__name__, exc))
    try:
        curves.sketchArcs.addByThreePoints(p_equator, p_front_mid, p_front_end)
        step("front spherical-zone arc")
    except Exception as exc:
        report["errors"].append("front arc: %s: %s" % (type(exc).__name__, exc))

    for label, a, b in (
        ("fill light ring", p_front_end, p_fill_end),
        ("sensor ring", p_fill_end, p_sensor_end),
        ("front flat face", p_sensor_end, p_axis_front),
        ("axis", p_axis_front, p_axis_bore),
        ("bore bottom", p_axis_bore, p_bore_wall),
        ("bore wall", p_bore_wall, p_rear_hole),
    ):
        try:
            curves.sketchLines.addByTwoPoints(a, b)
        except Exception as exc:
            report["errors"].append("%s: %s" % (label, exc))
    step("profile curves: %d" % sketch.sketchCurves.count)

    report["profiles"] = sketch.profiles.count
    if sketch.profiles.count < 1:
        result = report
    else:
        profile = sketch.profiles.item(0)
        sketch.isVisible = False
        try:
            revolves = root.features.revolveFeatures
            rev_input = revolves.createInput(
                profile, root.zConstructionAxis,
                adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
            )
            try:
                rev_input.setFullExtent()
            except Exception:
                rev_input.setAngleExtent(False, adsk.core.ValueInput.createByReal(2.0 * math.pi))
            revolve_feature = revolves.add(rev_input)
            body = revolve_feature.bodies.item(0)
            body.name = "Camera B210"
            step("revolved -> %s, %.3f cm3" % (body.name, body.volume))
        except Exception as exc:
            report["errors"].append("revolve: %s: %s" % (type(exc).__name__, exc))

        body = root.bRepBodies.item(0)
        bb = body.boundingBox
        report["body"] = {
            "name": body.name,
            "volume_cm3": round(body.volume, 3),
            "mass_g_PLA": round(body.volume * 1.24, 1),
            "bbox_mm": {
                "min": [round(v * 10, 2) for v in (bb.minPoint.x, bb.minPoint.y, bb.minPoint.z)],
                "max": [round(v * 10, 2) for v in (bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z)],
            },
            "depth_mm": round((bb.maxPoint.z - bb.minPoint.z) * 10, 2),
            "width_mm": round((bb.maxPoint.x - bb.minPoint.x) * 10, 2),
        }

    # ------------------------------------------------------------------ #
    # 存进项目
    # ------------------------------------------------------------------ #
    if SAVE_NAME:
        try:
            target_project = None
            for i in range(app.data.dataProjects.count):
                candidate = app.data.dataProjects.item(i)
                if candidate.name == SAVE_PROJECT:
                    target_project = candidate
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
                report["savedAs"] = {"name": SAVE_NAME, "project": SAVE_PROJECT,
                                     "returned": bool(saved), "isSaved": bool(doc.isSaved)}
                step("saved as %r in %r" % (SAVE_NAME, SAVE_PROJECT))
        except Exception as exc:
            report["errors"].append("saveAs: %s" % exc)

    result = report
