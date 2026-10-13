# -*- coding: utf-8 -*-
"""⚠️ 已被取代：用户直接在 Fusion 里选了标准 **M42x1**，那比手工扫掠稳得多。
    本文件保留下来，是因为里面的实测结论值得留档（见下），不是要跑它。

给 `Bottom_bottom v2` 把标准螺纹换成「真外凸」的螺纹。

# 为什么要手工建模

用户的原始意图是：**圆柱本体保持 Ø40，螺纹从圆柱面往外凸 1mm（牙顶 Ø42），螺距 1mm**。

Fusion 的标准 `ThreadFeature` 做不到这件事，原因有二：

1. **它是往里切的。** 实测：抑制螺纹后圆柱本体是 r=20.000（Ø40），加上
   M40x2 6g 后牙顶变 r=19.911、牙底 r=18.764 —— 材料被切掉，体积
   15.5415 → 14.8588 cm³。所以"外径不到 4cm"是**必然**，不是 bug。
2. **它只会按公差带建模。** ISO 公制表里 ⌀40 只有 M40x3 / 2.5 / 2 / 1.5，
   **没有 M40x1**；而且每个都建在公称以下：

       M40x3 -> 39.7645 / M40x2.5 -> 39.7905 / M40x2 -> 39.822 / M40x1.5 -> 39.850

   `ThreadInfo.majorDiameter` 还是只读的，改不了。

而 Fusion 的 Coil 特征（本该用来做这件事）**在 API 里没有 createInput**，
所以只能自己造螺旋线再扫掠。

# 牙型

螺距 1mm 且径向凸出 1mm 时，牙侧每侧只有 0.5mm 轴向余量，因此**最大包容角只有
53.13°**（60° 标准牙型在这个螺距下最多只能做到 0.577mm 深）。这里取牙顶平台
0.1mm、牙侧斜 0.45mm/mm，得到包容角约 49.4° —— 比标准牙"方"一点，但牙顶不是
刀口，打印件不会一碰就崩。

牙顶 Ø42.0、牙底（相邻牙侧交点）正好落在 Ø40.0，与用户要求一致。
"""

import math
import time

import adsk.core
import adsk.fusion

# --------------------------------------------------------------------------- #
# 参数（毫米）
# --------------------------------------------------------------------------- #

ROOT_DIA = 40.0          # 牙底 = 圆柱本体直径（用户要求"内径 4cm"）
CREST_RISE = 1.0         # 从圆柱面往外凸出的量
PITCH = 1.0              # 螺距
THREAD_Z0 = 2.0          # 螺纹段起点（法兰顶面）
THREAD_Z1 = 10.0         # 螺纹段终点（Ø20 凸台肩面）
CREST_FLAT = 0.10        # 牙顶平台宽度
INNER_EXTRA = 1.0        # 牙型往圆柱面内部多伸多少，保证并集实在

DRY_RUN = True           # True = 在草稿文档里拿一段 Ø40 圆柱试；False = 改真件
TARGET_DOC = "Bottom_bottom v2"

MM = 0.1


def V(v):
    return adsk.core.ValueInput.createByReal(v * MM)


def P(x, y, z):
    return adsk.core.Point3D.create(x * MM, y * MM, z * MM)


R_ROOT = ROOT_DIA / 2.0                 # 20.0
R_CREST = R_ROOT + CREST_RISE           # 21.0
R_INNER = R_ROOT - INNER_EXTRA          # 19.0

# 牙侧斜率：牙顶半球高 CREST_FLAT/2，在 r=R_ROOT 处半高必须正好是 PITCH/2
# （这样相邻牙的牙侧交点刚好落在 Ø40 上）
SLOPE = (PITCH / 2.0 - CREST_FLAT / 2.0) / (R_CREST - R_ROOT)
HALF_AT_INNER = CREST_FLAT / 2.0 + SLOPE * (R_CREST - R_INNER)

# 牙型轴线高度：让牙型正好骑在螺纹段中间
PROFILE_ZC = (THREAD_Z0 + THREAD_Z1) / 2.0

# 扫掠路径（螺旋线）两端要各留出 HALF_AT_INNER，否则牙型会越过肩面悬空
PATH_Z0 = THREAD_Z0 + HALF_AT_INNER
PATH_Z1 = THREAD_Z1 - HALF_AT_INNER
HELIX_TURNS = (PATH_Z1 - PATH_Z0) / PITCH
# 螺旋线半径 = 牙型面积形心半径，扫出来的牙顶才正好落在 R_CREST
_a = CREST_FLAT
_b = 2.0 * HALF_AT_INNER
HELIX_R = R_CREST - (2.0 * INNER_EXTRA) * (_a + 2.0 * _b) / (3.0 * (_a + _b))
PROFILE_ZC_PATH = PATH_Z0   # 路径起点高度（牙型相对路径的偏移已由形心决定）

report = {"steps": [], "errors": [], "params": {
    "rootDia": ROOT_DIA, "crestDia": 2 * R_CREST, "pitch": PITCH,
    "threadZ": [THREAD_Z0, THREAD_Z1],
    "helixRadius": round(HELIX_R, 4),
    "helixZ": [round(PATH_Z0, 4), round(PATH_Z1, 4)],
    "turns": round(HELIX_TURNS, 4),
    "halfAtInner": round(HALF_AT_INNER, 4),
    "slope": round(SLOPE, 4),
    "includedAngleDeg": round(2 * math.degrees(math.atan(SLOPE)), 2),
}}


def step(msg):
    report["steps"].append(msg)


def find_doc(name):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name:
            return d
    return None


def xz_point(sketch, x_mm, z_mm):
    """法线沿 Y 的草图里取点。实测局部 Y 轴指向模型 -Z，必须按真实轴向换算。"""
    xd, yd = sketch.xDirection, sketch.yDirection
    sx = -1.0 if (xd.x + xd.y + xd.z) < 0 else 1.0
    if abs(yd.z) > 0.5:
        sy = 1.0 if yd.z > 0 else -1.0
    else:
        sy = -1.0 if (yd.x + yd.y + yd.z) < 0 else 1.0
    return adsk.core.Point3D.create(sx * x_mm * MM, sy * z_mm * MM, 0)


# --------------------------------------------------------------------------- #
# 准备目标
# --------------------------------------------------------------------------- #

if DRY_RUN:
    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    for _ in range(80):
        adsk.doEvents()
        time.sleep(0.1)
        if adsk.fusion.Design.cast(app.activeProduct) is not None:
            break
    design = adsk.fusion.Design.cast(app.activeProduct)
    root = design.rootComponent
    # 造一段和真件同尺寸的 Ø40 圆柱（z 0..20 用不着，只做 2..10 那段够验证）
    sk = root.sketches.add(root.xYConstructionPlane)
    sk.sketchCurves.sketchCircles.addByCenterRadius(P(0, 0, 0), R_ROOT * MM)
    ext = root.features.extrudeFeatures
    ei = ext.createInput(sk.profiles.item(0),
                         adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    ei.setDistanceExtent(False, V(THREAD_Z1 - THREAD_Z0))
    ext.add(ei)
    sk.isVisible = False
    # 挪到 z=2..10，和真件的螺纹段对齐
    body = root.bRepBodies.item(0)
    move = root.features.moveFeatures
    coll = adsk.core.ObjectCollection.create()
    coll.add(body)
    mi = move.createInput2(coll)
    mi.defineAsTranslateXYZ(V(0), V(0), V(THREAD_Z0), True)
    move.add(mi)
    step("dry-run: scratch Ø40 cylinder built, z=%s..%s" % (THREAD_Z0, THREAD_Z1))
    suppress_thread = False
else:
    doc = find_doc(TARGET_DOC)
    if doc is None:
        report["errors"].append("document not found: %s" % TARGET_DOC)
        result = report
        raise SystemExit
    doc.activate()
    for _ in range(80):
        adsk.doEvents()
        time.sleep(0.1)
        if adsk.fusion.Design.cast(app.activeProduct) is not None:
            break
    design = adsk.fusion.Design.cast(app.activeProduct)
    root = design.rootComponent
    thread = root.features.itemByName("螺纹1")
    if thread is not None and not thread.isSuppressed:
        thread.isSuppressed = True
        adsk.doEvents()
        step("existing ThreadFeature '螺纹1' suppressed (可随时取消抑制)")
    body = root.bRepBodies.item(0)
    suppress_thread = True

report["bodyBefore"] = {
    "name": body.name,
    "volume_cm3": round(body.volume, 4),
    "cylinderRadii_mm": sorted({round(f.geometry.radius * 10, 3) for f in body.faces
                                if f.geometry.objectType.endswith("Cylinder")}),
}

# --------------------------------------------------------------------------- #
# 1. 螺旋线（先做成临时线体，再看能不能当 Path）
# --------------------------------------------------------------------------- #

helix_body = None
try:
    temp_mgr = adsk.fusion.TemporaryBRepManager.get()
    helix_body = temp_mgr.createHelixWire(
        adsk.core.Point3D.create(0, 0, PATH_Z0 * MM),
        adsk.core.Vector3D.create(0, 0, 1),
        adsk.core.Point3D.create(HELIX_R * MM, 0, PATH_Z0 * MM),
        PITCH * MM,
        HELIX_TURNS,
        0.0,
    )
    report["helixBody"] = {
        "type": type(helix_body).__name__,
        "isNone": helix_body is None,
        "edges": getattr(helix_body, "edges", None) and helix_body.edges.count,
    }
    step("helix wire created")
except Exception as exc:
    report["errors"].append("createHelixWire: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 2. 牙型草图（XZ 平面上，包含轴线的径向平面）
# --------------------------------------------------------------------------- #

profile = None
try:
    plane_input = root.constructionPlanes.createInput()
    plane_input.setByOffset(root.xZConstructionPlane, V(0))
    plane = root.constructionPlanes.add(plane_input)
    sketch = root.sketches.add(plane)
    sketch.name = "thread_profile"
    curves = sketch.sketchCurves

    zc = PROFILE_ZC
    pts = [
        (R_CREST, zc - CREST_FLAT / 2.0),
        (R_CREST, zc + CREST_FLAT / 2.0),
        (R_INNER, zc + HALF_AT_INNER),
        (R_INNER, zc - HALF_AT_INNER),
    ]
    sketch_pts = [xz_point(sketch, x, z) for (x, z) in pts]
    for i in range(4):
        curves.sketchLines.addByTwoPoints(sketch_pts[i], sketch_pts[(i + 1) % 4])

    if sketch.profiles.count < 1:
        raise RuntimeError("profile not closed (profiles=%d)" % sketch.profiles.count)
    profile = sketch.profiles.item(0)
    sketch.isVisible = False
    step("thread profile sketched (%d profiles)" % sketch.profiles.count)
except Exception as exc:
    report["errors"].append("profile sketch: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 3. 扫掠成螺纹
# --------------------------------------------------------------------------- #

if profile is not None and helix_body is not None:
    path = None
    try:
        path = adsk.fusion.Path.create(helix_body.edges.item(0), False)
        step("Path created from helix edge")
    except Exception as exc:
        report["errors"].append("Path.create(edge): %s: %s" % (type(exc).__name__, exc))
        try:
            path = adsk.fusion.Path.create(helix_body, False)
            step("Path created from helix body")
        except Exception as exc2:
            report["errors"].append("Path.create(body): %s: %s" % (type(exc2).__name__, exc2))

    if path is not None:
        try:
            sweeps = root.features.sweepFeatures
            sweep_input = sweeps.createInput(
                profile, path, adsk.fusion.FeatureOperations.JoinFeatureOperation
            )
            sweep_feature = sweeps.add(sweep_input)
            step("sweep added: %d bodies" % root.bRepBodies.count)
        except Exception as exc:
            report["errors"].append("sweep: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 4. 量结果
# --------------------------------------------------------------------------- #

try:
    bodies = [root.bRepBodies.item(i) for i in range(root.bRepBodies.count)]
    report["bodyCount"] = len(bodies)
    report["after"] = []
    for b in bodies:
        radii = sorted({round(f.geometry.radius * 10, 3) for f in b.faces
                        if f.geometry.objectType.endswith("Cylinder")})
        report["after"].append({
            "name": b.name,
            "volume_cm3": round(b.volume, 4),
            "bbox_z_mm": [round(b.boundingBox.minPoint.z * 10, 2),
                          round(b.boundingBox.maxPoint.z * 10, 2)],
            "maxRadius_mm": round(max([f.geometry.radius * 10 for f in b.faces
                                       if f.geometry.objectType.endswith("Cylinder")] or [0]), 3),
            "cylinderRadii_mm": radii,
        })
except Exception as exc:
    report["errors"].append("measure: %s: %s" % (type(exc).__name__, exc))

result = report
