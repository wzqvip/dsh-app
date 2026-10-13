# -*- coding: utf-8 -*-
"""把 `Bottom_bottom v4` 派生进 `Stand v5` 并摆到安装面上。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

# 姿态

`Stand v5` 的安装面在 **y = 6mm**、法线朝 **-Y**（摄像机朝 -Y 拍）。
`Bottom_bottom` 局部是绕 Z 轴的旋转体，法兰面在局部 z=0。
所以变换是：

    绕 X 轴 +90°   ->  局部 +Z 映射到世界 -Y
    平移 (0, 6, 96) ->  法兰面落到 y=6，轴线抬到安装盘中心高度 z=96

摆好之后 `Bottom_bottom` 应占：
    x -24..24   y -14..6   z 72..120

# 三个 API 坑（都踩过）

1. `DeriveFeatureInput.sourceEntities` 要的是 **Python 列表**（SWIG 的
   `std::vector<Ptr<Base>>`），传 `ObjectCollection` 会 TypeError；
   而且 `createInput(sourceDesign)` **不会**自动带上实体 —— 不传就派生出一个空的。
2. `MoveFeatureInput` **没有** `defineAsTransform`，要直接写 `mi.transform = matrix`。
3. 文档标签名带版本号（"Stand v5 v1"），精确匹配找不到。
"""

import math
import time

import adsk.core
import adsk.fusion

MM = 0.1

STAND_NAME = "Stand v5"
BOTTOM_NAME = "Bottom_bottom v4"
PROJECT_NAME = "Noorio B310"
PAD_FACE_Y = 6.0     # Stand v5 安装盘的外表面 y
RECESS_DEPTH = 1.2   # 安装盘上 ⌀48.8 沉台的深度（就是给法兰定位用的）
PAD_Z = 96.0         # Stand v5 安装盘中心高度

# 法兰（局部 z=0..2 那 2mm）要**嵌进**沉台，所以法兰外表面不该停在沉台口 y=6，
# 而应落在沉台底 y=6+1.2=7.2 —— 这样法兰后 1.2mm 埋在沉台里、前 0.8mm 露在外面。
FLANGE_FACE_Y = PAD_FACE_Y + RECESS_DEPTH

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


def project_file(file_name):
    project = None
    for i in range(app.data.dataProjects.count):
        p = app.data.dataProjects.item(i)
        if p.name == PROJECT_NAME:
            project = p
            break
    if project is None:
        return None
    folder = project.rootFolder
    for i in range(folder.dataFiles.count):
        f = folder.dataFiles.item(i)
        if f.name == file_name:
            return f
    return None


def bbox_mm(body):
    bb = body.boundingBox
    return {"min": [round(v / MM, 2) for v in (bb.minPoint.x, bb.minPoint.y, bb.minPoint.z)],
            "max": [round(v / MM, 2) for v in (bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z)]}


# --------------------------------------------------------------------------- #
# 1. 不保存关掉 Stand v5，丢掉之前试错留下的空特征
# --------------------------------------------------------------------------- #

stand = find_doc(STAND_NAME)
if stand is not None:
    try:
        stand.close(False)
        step("closed %s without saving" % STAND_NAME)
    except Exception as exc:
        report["errors"].append("close: %s" % exc)

target_file = project_file(STAND_NAME)
if target_file is None:
    report["errors"].append("datafile not found: %s" % STAND_NAME)
    result = report
else:
    doc = app.documents.open(target_file, True)
    design = wait_active()
    root = design.rootComponent
    step("reopened %s, features=%d" % (doc.name, root.features.count))

    # ------------------------------------------------------------------ #
    # 1b. 幂等：先把上次装配留下的派生/移动特征删掉，免得越叠越多
    #     （Stand v5 原本的 9 个特征里没有任何 Derive/Move，所以按类型删是安全的）
    # ------------------------------------------------------------------ #
    for i in range(root.features.count - 1, -1, -1):
        feature = root.features.item(i)
        kind = feature.objectType.split("::")[-1]
        if kind in ("DeriveFeature", "MoveFeature"):
            name = feature.name
            try:
                feature.deleteMe()
                step("removed stale %s: %s" % (kind, name))
            except Exception as exc:
                report["errors"].append("deleteMe %s: %s" % (name, exc))

    # ------------------------------------------------------------------ #
    # 2. 派生（sourceEntities 必须是列表）
    # ------------------------------------------------------------------ #
    bottom = find_doc(BOTTOM_NAME)
    bottom_design = adsk.fusion.Design.cast(
        bottom.products.itemByProductType("DesignProductType"))
    bottom_body = bottom_design.rootComponent.bRepBodies.item(0)
    step("source body: %s (%.3f cm3)" % (bottom_body.name, bottom_body.volume))

    derive_input = root.features.deriveFeatures.createInput(bottom_design)
    try:
        derive_input.sourceEntities = [bottom_body]
    except Exception as exc:
        report["errors"].append("sourceEntities: %s: %s" % (type(exc).__name__, exc))
    try:
        derive_input.isPlaceObjectsAtOrigin = True
    except Exception:
        pass
    root.features.deriveFeatures.add(derive_input)
    step("derived")

    derived = None
    for i in range(root.bRepBodies.count):
        candidate = root.bRepBodies.item(i)
        if abs(candidate.volume - bottom_body.volume) < 0.05:
            derived = candidate
            break
    if derived is None:
        report["errors"].append("derived body not found")
    else:
        step("derived body: %s (%.3f cm3)" % (derived.name, derived.volume))

        # -------------------------------------------------------------- #
        # 3. 定位：绕 X +90°，再平移到安装面
        # -------------------------------------------------------------- #
        matrix = adsk.core.Matrix3D.create()
        matrix.setToRotation(math.radians(90),
                             adsk.core.Vector3D.create(1, 0, 0),
                             adsk.core.Point3D.create(0, 0, 0))
        matrix.translation = adsk.core.Vector3D.create(0, FLANGE_FACE_Y * MM, PAD_Z * MM)

        collection = adsk.core.ObjectCollection.create()
        collection.add(derived)
        move_input = root.features.moveFeatures.createInput2(collection)
        try:
            move_input.transform = matrix          # ← 不是 defineAsTransform
            root.features.moveFeatures.add(move_input)
            step("moved to mount face")
        except Exception as exc:
            report["errors"].append("move: %s: %s" % (type(exc).__name__, exc))

        report["bodies"] = []
        for i in range(root.bRepBodies.count):
            b = root.bRepBodies.item(i)
            report["bodies"].append({"name": b.name,
                                     "volume_cm3": round(b.volume, 3),
                                     "bbox_mm": bbox_mm(b)})

        # -------------------------------------------------------------- #
        # 4. 间隙校验：法兰面是否真的贴在 y=6，有没有插进安装盘
        # -------------------------------------------------------------- #
        moved = None
        for i in range(root.bRepBodies.count):
            b = root.bRepBodies.item(i)
            if abs(b.volume - bottom_body.volume) < 0.05:
                moved = b
        if moved is not None:
            bb = bbox_mm(moved)
            report["check"] = {
                "flangeOuterFaceY_mm": bb["max"][1],
                "expected": FLANGE_FACE_Y,
                "delta_mm": round(bb["max"][1] - FLANGE_FACE_Y, 3),
                "seatedInRecess_mm": round(min(RECESS_DEPTH,
                                               bb["max"][1] - PAD_FACE_Y), 3),
                "proudOfPad_mm": round(PAD_FACE_Y - (bb["max"][1] - 2.0), 3),
                "axisHeightZ_mm": round((bb["min"][2] + bb["max"][2]) / 2.0, 2),
                "expectedAxisZ_mm": PAD_Z,
                "forwardExtent_mm": round(bb["max"][1] - bb["min"][1], 2),
            }
            step("check: 法兰外表面 y=%.2f (期望 %.1f)，嵌入沉台 %.2fmm，露出 %.2fmm，轴线 z=%.2f"
                 % (bb["max"][1], FLANGE_FACE_Y,
                    report["check"]["seatedInRecess_mm"],
                    report["check"]["proudOfPad_mm"],
                    report["check"]["axisHeightZ_mm"]))

    # ------------------------------------------------------------------ #
    # 5. 保存
    # ------------------------------------------------------------------ #
    try:
        saved = doc.save("")
        for _ in range(50):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved:
                break
        report["saved"] = {"returned": bool(saved), "isSaved": bool(doc.isSaved)}
        step("saved (isSaved=%s)" % doc.isSaved)
    except Exception as exc:
        report["errors"].append("save: %s" % exc)

    result = report
