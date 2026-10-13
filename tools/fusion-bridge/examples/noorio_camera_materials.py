# -*- coding: utf-8 -*-
"""给 `Camera B210` 按区域上材质。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

用户给的配色（照着他拍的照片）：

    摄像机机身    哑光白色
    螺丝孔        金属银色
    补光灯        亮蛋壳白
    感应区域      黑色
    摄像头区域    灰色

⚠️ Fusion 的外观库名称是**中文本地化**的（库名 "Fusion 外观库"），
用英文关键词（"white" / "plastic"）去搜会一个都找不到。必须用中文名。

分面靠几何判断，不靠选择集 —— 因为这个旋转体的各个面类型和位置是确定的：
    球面                -> 机身
    锥面(最大半径≈45)   -> 补光灯环
    锥面(最大半径≈30)   -> 感应区
    平面(z≈+40, 小圆)   -> 镜头
    圆柱 + 平面(z<0)    -> Ø5 螺丝孔
"""

import time

import adsk.core
import adsk.fusion

TARGET_DOC = "Camera B210"
MM = 0.1

# 外观名 -> 用在哪一类面上
APPEARANCES = {
    "body": "塑料 - 粗面(白色)",        # 哑光白
    "fill_light": "塑料 - 有光泽(白色)",  # 亮蛋壳白
    "sensor": "塑料 - 粗面(黑色)",       # 黑
    "lens": "塑料 - 有光泽(灰色)",       # 灰
    "screw_hole": "银 - 抛光",          # 金属银
}

report = {"steps": [], "errors": [], "faces": []}


def step(msg):
    report["steps"].append(msg)


def find_doc(name):
    """⚠️ 文档标签名带版本号（"Camera B210 v1"），不能精确匹配。"""
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


def find_appearance(name):
    """外观名是中文的，按名字在全部库里找。"""
    for i in range(app.materialLibraries.count):
        lib = app.materialLibraries.item(i)
        try:
            appearances = lib.appearances
        except Exception:
            continue
        try:
            found = appearances.itemByName(name)
        except Exception:
            found = None
        if found is not None:
            return found, lib.name
    return None, None


doc = find_doc(TARGET_DOC)
if doc is None:
    report["errors"].append("document not found: %s" % TARGET_DOC)
    result = report
else:
    doc.activate()
    for _ in range(60):
        adsk.doEvents()
        time.sleep(0.1)
        if adsk.fusion.Design.cast(app.activeProduct) is not None:
            break
    design = adsk.fusion.Design.cast(app.activeProduct)
    root = design.rootComponent
    body = root.bRepBodies.item(0)
    step("document %s, body %s" % (doc.name, body.name))

    resolved = {}
    for key, name in APPEARANCES.items():
        appearance, lib_name = find_appearance(name)
        if appearance is None:
            report["errors"].append("appearance not found: %s" % name)
        else:
            resolved[key] = appearance
            step("resolved %-11s -> %r (库: %s)" % (key, name, lib_name))

    def face_bbox_mm(face):
        bb = face.boundingBox
        return (
            bb.minPoint.x / MM, bb.maxPoint.x / MM,
            bb.minPoint.z / MM, bb.maxPoint.z / MM,
        )

    def classify(face):
        kind = face.geometry.objectType.split("::")[-1]
        x0, x1, z0, z1 = face_bbox_mm(face)
        max_r = max(abs(x0), abs(x1))
        if kind == "Cylinder":
            return "screw_hole", "圆柱面 r=%.2f" % max_r
        if kind == "Plane":
            if z1 > 10.0:
                return "lens", "平面 z=%.2f r=%.2f" % (z1, max_r)
            return "screw_hole", "平面 z=%.2f r=%.2f" % (z1, max_r)
        if kind == "Cone":
            if max_r > 38.0:
                return "fill_light", "锥面 r_max=%.2f" % max_r
            return "sensor", "锥面 r_max=%.2f" % max_r
        if kind == "Sphere":
            return "body", "球面 r_max=%.2f" % max_r
        return "body", kind

    counts = {}
    for i in range(body.faces.count):
        face = body.faces.item(i)
        key, why = classify(face)
        appearance = resolved.get(key)
        entry = {"index": i, "key": key, "why": why,
                 "area_mm2": round(face.area * 100, 1)}
        if appearance is None:
            entry["applied"] = False
        else:
            try:
                face.appearance = appearance
                entry["applied"] = True
                entry["appearance"] = appearance.name
            except Exception as exc:
                entry["applied"] = False
                entry["error"] = "%s: %s" % (type(exc).__name__, exc)
                report["errors"].append("face %d: %s" % (i, exc))
        counts[key] = counts.get(key, 0) + 1
        report["faces"].append(entry)

    report["faceCounts"] = counts
    step("faces: %s" % counts)

    # ------------------------------------------------------------------ #
    # 存回项目
    # ------------------------------------------------------------------ #
    try:
        saved = doc.save("")
        for _ in range(50):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved:
                break
        report["saved"] = {"returned": bool(saved), "isSaved": bool(doc.isSaved),
                           "name": app.activeDocument.name}
        step("saved (isSaved=%s)" % doc.isSaved)
    except Exception as exc:
        report["errors"].append("save: %s" % exc)

    result = report
