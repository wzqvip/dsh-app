# -*- coding: utf-8 -*-
"""Noorio B200 整机装配：Stand v5 + Bottom_bottom + Gimbal + Camera。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

新建 `Assembly B210`，把五个体分别派生（Derive）进来并按链条摆好，然后
**用真实几何算整机重心**，回头检验支架的稳定性。

# 链条（坐标：Z 向上，摄像机朝 -Y，轴线在 x=0 / z=96）

所有零件局部都是绕 Z 轴的旋转体，装配统一用「绕 X 轴 +90°」，即局部 +Z → 世界 -Y。
剩下的只有一个平移量（局部 z=0 落在世界 y 的哪里）：

    Stand v5        本就在装配坐标系里，不平移
    Bottom_bottom   局 z=0 -> y=6     法兰贴安装面（安装面 y=6）
    Gimbal          局 z=0 -> y=4     Bottom_bottom 局 z=2 处是 y=4，壳体内螺纹拧在这
    Camera          局 z=0 -> y=-91   相机尾极 = -41，到壳体锥尖(-26) 正好 15mm
                                      （用户实测值；螺杆只咬约 7mm，未顶到孔底）

于是：
    球头球心      局 z=25.5 -> y=-21.5
    螺杆          局 z=34..52 -> y=-30..-48（其中 10mm 拧进相机孔，外露 8mm）
    相机尾极      局 z=-50 -> y=-38     （与球头顶 y=-30 相距 8mm）
    相机前脸      局 z=40  -> y=-128

# 质量假设（都要标注，因为它们决定重心结论）

    Stand / Bottom_bottom / 壳体   PLA 1.24 g/cm3
    球头+螺杆                      钢 7.85 g/cm3（照片上是镀铬金属）
    相机                            450 g（厂商毛重 712~726g 含配件，净重未公布）

# ⚠️ 仍然只用 doc.products 取 design

`app.activeProduct` / `wait_active()` 会取到未切换完成的另一个文档 —— 上一版就是
因此清空重建了别的零件。这里一律 `Design.cast(doc.products.itemByProductType(...))`。
"""

import math
import time

import adsk.core
import adsk.fusion

MM = 0.1
PROJECT_NAME = "Noorio B310"
ASSEMBLY_NAME = "Assembly B210"

# 局部 z=0 在世界 y 的位置（绕 X +90° 之后的平移量）
#
# ⚠️ Camera 的取值来自用户实测：相机尾面到壳体锥尖面是 **15mm**（不是模型早先的 12）。
#    壳体锥尖 y = 4-30 = -26；相机尾极 = y0+50。要差 15mm 就得 y0 = -91。
#    换句话说螺杆在相机孔里只咬约 7mm，并没有顶到 Ø5 孔底（我之前假设了 10mm 全咬合）。
PLACEMENT = {
    "Stand v5": 0.0,
    "Bottom_bottom": 6.0,
    "Gimbal B210": 4.0,
    "Camera B210": -91.0,
}
AXIS_Z = 96.0

DENSITY = {
    "stand": 1.24,          # PLA
    "bottom": 1.24,
    "gimbal_housing": 1.24,
    "ball_stud": 7.85,      # 钢
}
CAMERA_MASS_G = 456.0        # 用户实测
GIMBAL_TOTAL_MASS_G = 45.0   # 用户实测（按整个万向节单元：壳体 + 球头 + 螺杆）
PLA_DENSITY = 1.24
STEEL_DENSITY = 7.85

report = {"steps": [], "errors": []}


def step(msg):
    report["steps"].append(msg)


def find_doc(name):
    """⚠️ 标签名带版本号，必须前缀匹配。"""
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


def project_folder():
    for i in range(app.data.dataProjects.count):
        p = app.data.dataProjects.item(i)
        if p.name == PROJECT_NAME:
            return p.rootFolder
    return None


def open_by_name(name):
    doc = find_doc(name)
    if doc is not None:
        return doc
    folder = project_folder()
    if folder is None:
        return None
    for i in range(folder.dataFiles.count):
        f = folder.dataFiles.item(i)
        if f.name == name:
            opened = app.documents.open(f, True)
            for _ in range(80):
                adsk.doEvents()
                time.sleep(0.1)
                if opened.isSaved is not None:
                    break
            return opened
    return None


def design_of(doc):
    """⚠️ 只从 doc 自己身上取 design，绝不用 app.activeProduct。"""
    return adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))


def pick_body(design, name=None, volume=None):
    root = design.rootComponent
    for i in range(root.bRepBodies.count):
        b = root.bRepBodies.item(i)
        if name is not None and b.name == name:
            return b
        if volume is not None and abs(b.volume - volume) < 0.05:
            return b
    return None


def bbox_mm(body):
    bb = body.boundingBox
    return {"min": [round(v / MM, 2) for v in (bb.minPoint.x, bb.minPoint.y, bb.minPoint.z)],
            "max": [round(v / MM, 2) for v in (bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z)]}


# --------------------------------------------------------------------------- #
# 1. 打开（或新建）装配文档 —— 就地重建，避免 saveAs 每次都新建一个文件
# --------------------------------------------------------------------------- #

doc = find_doc(ASSEMBLY_NAME)
created_new = False
if doc is None:
    folder = project_folder()
    existing = None
    if folder is not None:
        for i in range(folder.dataFiles.count):
            f = folder.dataFiles.item(i)
            if f.name == ASSEMBLY_NAME:
                existing = f
                break
    if existing is not None:
        doc = app.documents.open(existing, True)
        for _ in range(80):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved is not None:
                break
        step("opened existing %s" % ASSEMBLY_NAME)
    else:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        created_new = True
        step("created new assembly document")

time.sleep(0.8)
adsk.doEvents()
design = design_of(doc)
root = design.rootComponent
report["assemblyDocument"] = doc.name
if not (doc.name.startswith(ASSEMBLY_NAME) or doc.name.startswith("无标题")):
    report["errors"].append("identity check failed: %s" % doc.name)
    result = report
    raise SystemExit

# 清空旧特征（上一次跑的派生/移动），保证幂等
for i in range(root.features.count - 1, -1, -1):
    feature = root.features.item(i)
    name = feature.name
    try:
        feature.deleteMe()
    except Exception as exc:
        report["errors"].append("deleteMe %s: %s" % (name, exc))
step("cleared assembly -> features=%d bodies=%d"
     % (root.features.count, root.bRepBodies.count))


def placement_matrix(y_local_zero_mm):
    """绕 X +90°（局部 +Z -> 世界 -Y），再平移到 (0, y, AXIS_Z)。"""
    matrix = adsk.core.Matrix3D.create()
    matrix.setToRotation(math.radians(90),
                         adsk.core.Vector3D.create(1, 0, 0),
                         adsk.core.Point3D.create(0, 0, 0))
    matrix.translation = adsk.core.Vector3D.create(0, y_local_zero_mm * MM, AXIS_Z * MM)
    return matrix


def derive_and_place(source_design, source_bodies, y_local_zero_mm, label):
    """y_local_zero_mm=None 表示不平移也不旋转（零件本就在装配坐标系里）。"""
    count_before = root.bRepBodies.count
    derive_input = root.features.deriveFeatures.createInput(source_design)
    # ⚠️ sourceEntities 必须是 Python 列表（SWIG 的 std::vector<Ptr<Base>>）；
    #    传 ObjectCollection 会 TypeError，不传则派生出一个空的。
    derive_input.sourceEntities = list(source_bodies)
    try:
        derive_input.isPlaceObjectsAtOrigin = True
    except Exception:
        pass
    root.features.deriveFeatures.add(derive_input)

    new_bodies = [root.bRepBodies.item(i)
                  for i in range(count_before, root.bRepBodies.count)]
    if not new_bodies:
        report["errors"].append("%s: derive produced no bodies" % label)
        return []

    if y_local_zero_mm is not None:
        collection = adsk.core.ObjectCollection.create()
        for b in new_bodies:
            collection.add(b)
        move_input = root.features.moveFeatures.createInput2(collection)
        # ⚠️ MoveFeatureInput 没有 defineAsTransform，直接写 transform
        move_input.transform = placement_matrix(y_local_zero_mm)
        root.features.moveFeatures.add(move_input)

    step("%-14s -> %d bodies, y0=%s" % (label, len(new_bodies), y_local_zero_mm))
    return new_bodies


# --------------------------------------------------------------------------- #
# 2. 逐个派生并摆位
# --------------------------------------------------------------------------- #

sources = {}

stand_doc = open_by_name("Stand v5")
stand_design = design_of(stand_doc)
sources["stand"] = (stand_design, [pick_body(stand_design, name="Stand v5")])

bottom_doc = open_by_name("Bottom_bottom")
bottom_design = design_of(bottom_doc)
sources["bottom"] = (bottom_design,
                     [bottom_design.rootComponent.bRepBodies.item(0)])

gimbal_doc = open_by_name("Gimbal B210")
gimbal_design = design_of(gimbal_doc)
gimbal_bodies = [gimbal_design.rootComponent.bRepBodies.item(i)
                 for i in range(gimbal_design.rootComponent.bRepBodies.count)]
sources["gimbal"] = (gimbal_design, gimbal_bodies)

camera_doc = open_by_name("Camera B210")
camera_design = design_of(camera_doc)
sources["camera"] = (camera_design,
                     [camera_design.rootComponent.bRepBodies.item(0)])

for key, y0 in (("stand", None),          # 支架本就在装配坐标系里，恒等变换
                ("bottom", PLACEMENT["Bottom_bottom"]),
                ("gimbal", PLACEMENT["Gimbal B210"]),
                ("camera", PLACEMENT["Camera B210"])):
    source_design, bodies = sources[key]
    if any(b is None for b in bodies):
        report["errors"].append("%s: source body not found" % key)
        continue
    derive_and_place(source_design, bodies, y0, key)

# --------------------------------------------------------------------------- #
# 3. 量结果 + 真实重心
# --------------------------------------------------------------------------- #

bodies = []
for i in range(root.bRepBodies.count):
    b = root.bRepBodies.item(i)
    props = b.getPhysicalProperties(adsk.fusion.CalculationAccuracy.HighCalculationAccuracy)
    com = props.centerOfMass
    bodies.append({
        "name": b.name,
        "volume_cm3": round(b.volume, 3),
        "bbox_mm": bbox_mm(b),
        "com_mm": [round(com.x / MM, 2), round(com.y / MM, 2), round(com.z / MM, 2)],
    })
report["bodies"] = bodies

# 质量分配：
#   相机            用户实测 456g
#   万向节单元      用户实测 45g（壳体+球头+螺杆整体）—— 壳体按 PLA 算，余下给金属球头
#   Stand / Bottom  按 PLA 体积算
mass_rows = []
for entry in bodies:
    volume = entry["volume_cm3"]
    if abs(volume - 502.766) < 0.5:
        mass, note = CAMERA_MASS_G, "实测 456g"
    elif abs(volume - 14.703) < 0.5:
        mass, note = volume * PLA_DENSITY, "PLA（万向节壳体）"
    elif abs(volume - 2.853) < 0.1:
        mass, note = None, "待定：球头+螺杆 = 45g 减去壳体"
    else:
        mass, note = volume * PLA_DENSITY, "PLA"
    mass_rows.append({
        "name": entry["name"], "volume_cm3": volume,
        "mass_g": None if mass is None else round(mass, 1),
        "note": note, "com_mm": entry["com_mm"],
    })

# 球头+螺杆的质量 = 万向节整体 45g − 壳体
# ⚠️ 这里必须同时判 mass_g 不为 None：球头那行的说明里也含"壳体"二字，
#    只按文字过滤会把 None 带进求和（踩过）。
housing_mass = sum(r["mass_g"] for r in mass_rows
                   if r["mass_g"] is not None and "万向节壳体" in r["note"])
for row in mass_rows:
    if row["mass_g"] is None:
        row["mass_g"] = round(GIMBAL_TOTAL_MASS_G - housing_mass, 1)
        row["note"] = "实测：45g 单元 − 壳体 %.1fg" % housing_mass

total_mass = sum(r["mass_g"] for r in mass_rows)
cg_x = sum(r["mass_g"] * r["com_mm"][0] for r in mass_rows) / total_mass
cg_y = sum(r["mass_g"] * r["com_mm"][1] for r in mass_rows) / total_mass
cg_z = sum(r["mass_g"] * r["com_mm"][2] for r in mass_rows) / total_mass

# Stand v5 的底面足迹 —— ⚠️ 从支架实体实测包围盒取，不要硬编码。
# 上一版把足迹写死成 [-92, +84]，后来底座前移 28mm 变成 [-120, +56]，
# 结果算出来的前缘余量/抗倾覆全是错的（43.9mm/31.4° vs 实际 71.9mm/45.0°）。
stand_body = None
for i in range(root.bRepBodies.count):
    b = root.bRepBodies.item(i)
    if b.name.startswith("Stand"):
        stand_body = b
        break
if stand_body is not None:
    FOOTPRINT_FRONT = round(stand_body.boundingBox.minPoint.y / MM, 2)
    FOOTPRINT_BACK = round(stand_body.boundingBox.maxPoint.y / MM, 2)
else:
    FOOTPRINT_FRONT, FOOTPRINT_BACK = -92.0, 84.0
front_margin = cg_y - FOOTPRINT_FRONT

report["masses"] = mass_rows
report["totalMass_g"] = round(total_mass, 1)
report["assemblyCoG_mm"] = [round(cg_x, 2), round(cg_y, 2), round(cg_z, 2)]
report["stability"] = {
    "footprint_y_mm": [FOOTPRINT_FRONT, FOOTPRINT_BACK],
    "cog_y_mm": round(cg_y, 2),
    "frontMargin_mm": round(front_margin, 2),
    "tipAngleDeg_aboutFrontEdge": round(math.degrees(math.atan2(front_margin, cg_z)), 1),
}
step("CoG=(%.1f, %.1f, %.1f) 总质量 %.0fg 前缘余量 %.1fmm 抗倾覆 %.1f°"
     % (cg_x, cg_y, cg_z, total_mass, front_margin,
        report["stability"]["tipAngleDeg_aboutFrontEdge"]))

bb = root.boundingBox
report["assemblyBBox_mm"] = {
    "min": [round(v / MM, 2) for v in (bb.minPoint.x, bb.minPoint.y, bb.minPoint.z)],
    "max": [round(v / MM, 2) for v in (bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z)],
}

# --------------------------------------------------------------------------- #
# 4. 保存
# --------------------------------------------------------------------------- #

folder = project_folder()
try:
    if folder is None:
        report["errors"].append("project folder not found")
    elif created_new:
        saved = doc.saveAs(ASSEMBLY_NAME, folder, "", "")
        for _ in range(60):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved:
                break
        report["saved"] = {"returned": bool(saved), "isSaved": bool(doc.isSaved),
                           "documentName": doc.name}
        step("saved as %r" % ASSEMBLY_NAME)
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
