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
BOTTOM_NAME = "Bottom_bottom"
PROJECT_NAME = "Noorio B310"
PAD_FACE_Y = 6.0     # Stand v5 安装盘的外表面 y
PAD_Z = 96.0         # Stand v5 安装盘中心高度

# 用户要求安装面做成纯平面（不要托边、不要定位沉台），所以法兰直接贴在这个平面上。
FLANGE_FACE_Y = PAD_FACE_Y

# 用户要求把 Bottom_bottom 并进支架、一起打印。
# 并集之后 Stand v5 里只剩一个实体，可直接导出 STL 打印；万向节的 M42x1 内螺纹
# 就拧在这个打印件的外螺纹上。
MERGE_FOR_PRINTING = True

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
    # ⚠️ 不要用 app.activeProduct / wait_active()：open() 在桥接里会被延后，
    #    取到的可能是**另一个文档**的 design（本脚本上一版因此把 Stand v5 清空重建过）。
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    root = design.rootComponent
    if not doc.name.startswith(STAND_NAME):
        report["errors"].append("identity check failed: %s" % doc.name)
        result = report
        raise SystemExit
    step("reopened %s, features=%d" % (doc.name, root.features.count))

    # ------------------------------------------------------------------ #
    # 1b. 幂等：只删**时间轴尾部连续的那一段**装配特征。
    #
    # ⚠️ 不能"按类型删全部"：支架自己那个「底座+立柱」的合并也是 CombineFeature，
    #    按类型删会连它一起删掉、把支架拆了。这里从末尾往前删，一碰到非装配特征
    #    就停 —— 装配块永远是尾部的连续一段。
    # ------------------------------------------------------------------ #
    index = root.features.count - 1
    removed = 0
    while index >= 0:
        feature = root.features.item(index)
        kind = feature.objectType.split("::")[-1]
        if kind in ("DeriveFeature", "MoveFeature", "CombineFeature"):
            name = feature.name
            try:
                feature.deleteMe()
                removed += 1
                step("removed trailing %s: %s" % (kind, name))
            except Exception as exc:
                report["errors"].append("deleteMe %s: %s" % (name, exc))
                break
            index -= 1
        else:
            break
    if removed == 0:
        step("no trailing assembly features to remove")

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

        # -------------------------------------------------------------- #
        # 3b. 并成一个实体 —— 用户要求支架和 Bottom_bottom 一起打印
        #     法兰面正好落在安装盘面 y=6 上，两面共面，Join 后是一个连通实体。
        # -------------------------------------------------------------- #
        if MERGE_FOR_PRINTING:
            stand_body = None
            bottom_in_stand = None
            for i in range(root.bRepBodies.count):
                b = root.bRepBodies.item(i)
                if b.name.startswith("Stand"):
                    stand_body = b
                elif abs(b.volume - bottom_body.volume) < 0.05:
                    bottom_in_stand = b
            if stand_body is None or bottom_in_stand is None:
                report["errors"].append("merge: bodies not found")
            else:
                try:
                    tools = adsk.core.ObjectCollection.create()
                    tools.add(bottom_in_stand)
                    combine_input = root.features.combineFeatures.createInput(stand_body, tools)
                    combine_input.operation = adsk.fusion.FeatureOperations.JoinFeatureOperation
                    root.features.combineFeatures.add(combine_input)
                    merged = root.bRepBodies.item(0)
                    merged.name = "Stand v5 + bottom"
                    step("merged -> %s (%.3f cm3)" % (merged.name, merged.volume))
                    report["merged"] = {
                        "name": merged.name,
                        "volume_cm3": round(merged.volume, 3),
                        "expected_cm3": round(313.700 + bottom_body.volume, 3),
                        "bodyCount": root.bRepBodies.count,
                    }
                except Exception as exc:
                    report["errors"].append("merge: %s: %s" % (type(exc).__name__, exc))

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
                "axisHeightZ_mm": round((bb["min"][2] + bb["max"][2]) / 2.0, 2),
                "expectedAxisZ_mm": PAD_Z,
                "forwardExtent_mm": round(bb["max"][1] - bb["min"][1], 2),
            }
            step("check: 法兰外表面 y=%.2f (期望 %.1f，偏差 %.3f)，轴线 z=%.2f (期望 %.1f)"
                 % (bb["max"][1], FLANGE_FACE_Y, report["check"]["delta_mm"],
                    report["check"]["axisHeightZ_mm"], PAD_Z))

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
