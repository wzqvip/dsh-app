# -*- coding: utf-8 -*-
"""Noorio B200 系列 —— 球头万向节（用户口中的"万向节"）建模。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

用户口述（配合两张带钢尺的照片，单位毫米）：

    从下往上  第一段  高 15，外径 Ø53 -> Ø50
              第二段  高 15，外径 Ø50 -> Ø23（锥段）
    然后      球头    Ø17，从 Ø23 端面**外露 4mm**
    再上      螺杆    长 18

# 与 Bottom_bottom v2 的关系（这条把整条链路闭合了）

`Bottom_bottom v2` 的局部剖面是：

    z 10->20   Ø20 光圆柱
    z 15->20   Ø18 × 5 盲孔（从顶面往下）

**Ø18 的窝正好装这只 Ø17 球头**，球头外露 4mm < 窝深 5mm，所以卡进去还有 1mm 余量。
这就是用户说的"底座可以连到相机万向节上直接固定"的物理含义 —— 球头坐进
Bottom_bottom v2 的球窝里。

# 建模方式

两个旋转体，分别绕 Z 轴：

  1. 壳体（白）：Ø53 段 + 锥段，内部挖出 R8.7 球窝 + Ø16 喉口
     （球窝比球大 0.2 做间隙；喉口 Ø16 < 球 Ø17，所以球是"卡"进去的，不会掉）
  2. 球头 + 螺杆（铬）：R8.5 球 + Ø5 × 18 杆

坐标：Z 为轴，球头朝 +Z，底面在 z=0。
"""

import math
import time

import adsk.core
import adsk.fusion

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

SEG1_H = 15.0            # 第一段高度
SEG1_D0 = 53.0           # 第一段底径
SEG1_D1 = 50.0           # 第一段顶径

SEG2_H = 15.0            # 第二段（锥段）高度
SEG2_D0 = 50.0
SEG2_D1 = 23.0           # 锥段顶端外径

NOSE_Z = SEG1_H + SEG2_H                  # 30.0，锥段端面

BALL_D = 17.0
BALL_R = BALL_D / 2.0                     # 8.5
BALL_PROTRUDE = 4.0                       # 球头从端面外露的量
BALL_TOP_Z = NOSE_Z + BALL_PROTRUDE       # 34.0
BALL_CENTER_Z = BALL_TOP_Z - BALL_R       # 25.5（球心在端面下方 4.5）

SOCKET_R = BALL_R + 0.2                   # 8.7，球窝留 0.2 间隙
THROAT_R = 8.0                            # Ø16 喉口，小于球径 -> 球卡住不掉

STUD_R = 2.5                              # Ø5 螺杆
STUD_LEN = 18.0
STUD_TOP_Z = BALL_TOP_Z + STUD_LEN        # 52.0

HOUSING_APPEARANCE = "塑料 - 粗面(白色)"
BALL_APPEARANCE = "铬"

SAVE_NAME = "Gimbal B210"
SAVE_PROJECT = "Noorio B310"

MM = 0.1


def V(v):
    return adsk.core.ValueInput.createByReal(v * MM)


report = {"steps": [], "errors": [], "params": {
    "segment1": [SEG1_H, SEG1_D0, SEG1_D1],
    "segment2": [SEG2_H, SEG2_D0, SEG2_D1],
    "ballDia": BALL_D, "ballProtrude": BALL_PROTRUDE,
    "ballCenterZ": BALL_CENTER_Z, "ballTopZ": BALL_TOP_Z,
    "socketR": SOCKET_R, "throatR": THROAT_R,
    "stud": [STUD_R * 2, STUD_LEN, STUD_TOP_Z],
}}


def step(msg):
    report["steps"].append(msg)


def find_doc(name):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


def xz_point(sketch, x_mm, z_mm):
    """法线沿 Y 的草图取点（实测局部 Y 轴指向模型 -Z）。"""
    xd, yd = sketch.xDirection, sketch.yDirection
    sx = -1.0 if (xd.x + xd.y + xd.z) < 0 else 1.0
    if abs(yd.z) > 0.5:
        sy = 1.0 if yd.z > 0 else -1.0
    else:
        sy = -1.0 if (yd.x + yd.y + yd.z) < 0 else 1.0
    return adsk.core.Point3D.create(sx * x_mm * MM, sy * z_mm * MM, 0)


def arc_xy(center_r, center_z, radius, deg):
    a = math.radians(deg)
    return (center_r + radius * math.cos(a), center_z + radius * math.sin(a))


# --------------------------------------------------------------------------- #
# 新文档
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
    if candidate.name.startswith(SAVE_NAME) or (
        candidate.name.startswith("无标题") and candidate_root.features.count > 0
        and candidate_root.bRepBodies.count == 0
    ):
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
    root = design.rootComponent
    sketches = root.sketches
    extrudes = root.features.extrudeFeatures
    revolves = root.features.revolveFeatures

    def revolve_profile(name, builder):
        """在 XZ 平面上画一条封闭轮廓并绕 Z 轴整圈旋转，返回生成的实体。"""
        plane_input = root.constructionPlanes.createInput()
        plane_input.setByOffset(root.xZConstructionPlane, V(0))
        plane = root.constructionPlanes.add(plane_input)
        sketch = sketches.add(plane)
        sketch.name = name
        builder(sketch)
        if sketch.profiles.count < 1:
            raise RuntimeError("%s: profile not closed (%d)"
                               % (name, sketch.profiles.count))
        rev_input = revolves.createInput(
            sketch.profiles.item(0), root.zConstructionAxis,
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        try:
            rev_input.setFullExtent()
        except Exception:
            rev_input.setAngleExtent(False, adsk.core.ValueInput.createByReal(2 * math.pi))
        feature = revolves.add(rev_input)
        sketch.isVisible = False
        return feature.bodies.item(0)

    # ------------------------------------------------------------------ #
    # 1. 壳体外形（先做整块实心，稍后挖球窝）
    # ------------------------------------------------------------------ #
    def housing_profile(sketch):
        curves = sketch.sketchCurves
        pts = [
            xz_point(sketch, 0.0, 0.0),
            xz_point(sketch, SEG1_D0 / 2.0, 0.0),
            xz_point(sketch, SEG1_D1 / 2.0, SEG1_H),
            xz_point(sketch, SEG2_D1 / 2.0, NOSE_Z),
            xz_point(sketch, 0.0, NOSE_Z),
        ]
        for i in range(len(pts)):
            curves.sketchLines.addByTwoPoints(pts[i], pts[(i + 1) % len(pts)])

    try:
        housing = revolve_profile("housing_outer", housing_profile)
        housing.name = "Gimbal housing"
        step("housing revolved: %.3f cm3" % housing.volume)
    except Exception as exc:
        report["errors"].append("housing: %s: %s" % (type(exc).__name__, exc))
        housing = None

    # ------------------------------------------------------------------ #
    # 2. 球窝刀具：R8.7 球 + Ø16 喉口，并成一个旋转体，然后从壳体切掉
    # ------------------------------------------------------------------ #
    # 喉口圆柱 r=8 与球的交点高度
    dz = math.sqrt(max(SOCKET_R ** 2 - THROAT_R ** 2, 0.0))
    throat_bottom_z = BALL_CENTER_Z + dz        # 圆柱壁下沿
    ball_bottom_z = BALL_CENTER_Z - SOCKET_R    # 球底

    def socket_profile(sketch):
        curves = sketch.sketchCurves
        p_ball_bottom = xz_point(sketch, 0.0, ball_bottom_z)
        mid = arc_xy(0.0, BALL_CENTER_Z, SOCKET_R, -33.4)
        p_mid = xz_point(sketch, mid[0], mid[1])
        p_throat_bottom = xz_point(sketch, THROAT_R, throat_bottom_z)
        p_throat_top = xz_point(sketch, THROAT_R, NOSE_Z + 2.0)
        p_axis_top = xz_point(sketch, 0.0, NOSE_Z + 2.0)
        curves.sketchArcs.addByThreePoints(p_ball_bottom, p_mid, p_throat_bottom)
        curves.sketchLines.addByTwoPoints(p_throat_bottom, p_throat_top)
        curves.sketchLines.addByTwoPoints(p_throat_top, p_axis_top)
        curves.sketchLines.addByTwoPoints(p_axis_top, p_ball_bottom)

    socket_tool = None
    try:
        socket_tool = revolve_profile("socket_tool", socket_profile)
        step("socket tool revolved: %.3f cm3" % socket_tool.volume)
    except Exception as exc:
        report["errors"].append("socket tool: %s: %s" % (type(exc).__name__, exc))

    if housing is not None and socket_tool is not None:
        try:
            tools = adsk.core.ObjectCollection.create()
            tools.add(socket_tool)
            combine_input = root.features.combineFeatures.createInput(housing, tools)
            combine_input.operation = adsk.fusion.FeatureOperations.CutFeatureOperation
            root.features.combineFeatures.add(combine_input)
            step("socket cut -> %.3f cm3" % housing.volume)
        except Exception as exc:
            report["errors"].append("socket cut: %s: %s" % (type(exc).__name__, exc))

    # ------------------------------------------------------------------ #
    # 3. 球头 + 螺杆
    # ------------------------------------------------------------------ #
    stud_root_z = BALL_CENTER_Z + math.sqrt(max(BALL_R ** 2 - STUD_R ** 2, 0.0))

    def ball_profile(sketch):
        curves = sketch.sketchCurves
        p_axis_top = xz_point(sketch, 0.0, STUD_TOP_Z)
        p_stud_top = xz_point(sketch, STUD_R, STUD_TOP_Z)
        p_stud_bottom = xz_point(sketch, STUD_R, stud_root_z)
        mid = arc_xy(0.0, BALL_CENTER_Z, BALL_R, -8.5)
        p_mid = xz_point(sketch, mid[0], mid[1])
        p_ball_bottom = xz_point(sketch, 0.0, BALL_CENTER_Z - BALL_R)
        curves.sketchLines.addByTwoPoints(p_axis_top, p_stud_top)
        curves.sketchLines.addByTwoPoints(p_stud_top, p_stud_bottom)
        curves.sketchArcs.addByThreePoints(p_stud_bottom, p_mid, p_ball_bottom)
        curves.sketchLines.addByTwoPoints(p_ball_bottom, p_axis_top)

    ball = None
    try:
        ball = revolve_profile("ball_and_stud", ball_profile)
        ball.name = "Ball stud"
        step("ball+stud revolved: %.3f cm3" % ball.volume)
    except Exception as exc:
        report["errors"].append("ball: %s: %s" % (type(exc).__name__, exc))

    # ------------------------------------------------------------------ #
    # 3b. 螺杆的真实螺纹（照片上那截是有牙的）
    #     注意 Fusion 的牙是"往里切"的：M5x0.8 6g 会把 Ø5 光杆削到外径约 4.87。
    # ------------------------------------------------------------------ #
    if ball is not None:
        try:
            stud_face = None
            for face in ball.faces:
                geometry = face.geometry
                if (geometry.objectType.endswith("Cylinder")
                        and abs(geometry.radius * 10 - STUD_R) < 0.01):
                    stud_face = face
                    break
            if stud_face is None:
                report["errors"].append("stud cylindrical face not found")
            else:
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
                if designation is None:
                    report["errors"].append("M5x0.8 not found in ISO Metric profile")
                else:
                    info = fusion.ThreadInfo.create(
                        False, False, thread_type, designation, "6g", True)
                    thread_input = root.features.threadFeatures.createInput(stud_face, info)
                    thread_input.isModeled = True
                    root.features.threadFeatures.add(thread_input)
                    step("stud threaded: %s 6g (modeled OD %.3f)"
                         % (designation, info.majorDiameter * 10))
        except Exception as exc:
            report["errors"].append("stud thread: %s: %s" % (type(exc).__name__, exc))

    # ------------------------------------------------------------------ #
    # 4. 量结果
    # ------------------------------------------------------------------ #
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

    # ------------------------------------------------------------------ #
    # 5. 材质
    # ------------------------------------------------------------------ #
    def find_appearance(name):
        for i in range(app.materialLibraries.count):
            lib = app.materialLibraries.item(i)
            try:
                appearances = lib.appearances
                found = appearances.itemByName(name)
            except Exception:
                found = None
            if found is not None:
                return found
        return None

    for body, appearance_name in (
        (housing, HOUSING_APPEARANCE), (ball, BALL_APPEARANCE),
    ):
        if body is None:
            continue
        appearance = find_appearance(appearance_name)
        if appearance is None:
            report["errors"].append("appearance not found: %s" % appearance_name)
            continue
        try:
            body.appearance = appearance
            step("appearance %r -> %s" % (appearance_name, body.name))
        except Exception as exc:
            report["errors"].append("appearance assign: %s" % exc)

    # ------------------------------------------------------------------ #
    # 6. 存进项目
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
