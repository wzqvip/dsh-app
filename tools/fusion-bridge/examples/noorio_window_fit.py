# -*- coding: utf-8 -*-
"""窗户挂盒的配合验证：WindowBox + Gimbal + Camera 三件装起来验干涉。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

新建 `WindowBoxFit`，按窗口挂盒自己的坐标系摆放（玻璃在 y=0，相机朝 -Y）：

    WindowBox    恒等 —— 盒子本身就是按这套坐标设计的（球心 (0,45,0)）
    Camera       绕 X +90°，平移到 (0, 45, 0)    局部 z=0 = 球心

验完干涉会报出来 —— 关心三处，**都应当是 0**：
  1. 盒子内腔球面 vs 相机球     （R51 vs R50，恒 1mm 间隙）
  2. 盒子前端开口 vs 相机前锥    （开口 Ø103，相机该处的截面小得多）
  3. 后端螺杆 vs 相机 Ø5 孔      （同轴，螺杆 Ø5 与孔同径）

⚠️ 曾经这里还装过万向节（盒子出 M42 套筒、万向节拧上去），实测干涉 2.02 cm3，
   套筒撞穿万向节内部锥腔，方案已废弃 —— 详见 noorio_window_box.py 的说明。
"""

import math
import time

import adsk.core
import adsk.fusion

MM = 0.1
PROJECT_NAME = "Noorio B310"
FIT_NAME = "WindowBoxFit"

report = {"steps": [], "errors": []}


def step(msg):
    report["steps"].append(msg)


def find_doc(name):
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
    return adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))


# --------------------------------------------------------------------------- #
# 1. 打开/新建验证文档
# --------------------------------------------------------------------------- #

doc = find_doc(FIT_NAME)
created_new = False
if doc is None:
    folder = project_folder()
    existing = None
    if folder is not None:
        for i in range(folder.dataFiles.count):
            f = folder.dataFiles.item(i)
            if f.name == FIT_NAME:
                existing = f
                break
    if existing is not None:
        doc = app.documents.open(existing, True)
        for _ in range(80):
            adsk.doEvents()
            time.sleep(0.1)
            if doc.isSaved is not None:
                break
        step("opened existing %s" % FIT_NAME)
    else:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        created_new = True
        step("created new document")

time.sleep(0.6)
adsk.doEvents()
design = design_of(doc)
root = design.rootComponent
report["fitDocument"] = doc.name
if not (doc.name.startswith(FIT_NAME) or doc.name.startswith("无标题")):
    report["errors"].append("identity check failed: %s" % doc.name)
    result = report
    raise SystemExit

index = root.features.count - 1
while index >= 0:
    feature = root.features.item(index)
    kind = feature.objectType.split("::")[-1]
    if kind in ("DeriveFeature", "MoveFeature"):
        try:
            feature.deleteMe()
        except Exception as exc:
            report["errors"].append("deleteMe %s: %s" % (feature.name, exc))
            break
        index -= 1
    else:
        break
step("cleared trailing -> features=%d bodies=%d"
     % (root.features.count, root.bRepBodies.count))


def placement_matrix(y0_mm):
    matrix = adsk.core.Matrix3D.create()
    matrix.setToRotation(math.radians(90),
                         adsk.core.Vector3D.create(1, 0, 0),
                         adsk.core.Point3D.create(0, 0, 0))
    matrix.translation = adsk.core.Vector3D.create(0, y0_mm * MM, 0)
    return matrix


def derive_and_place(source_design, bodies, y0_mm, label):
    count_before = root.bRepBodies.count
    derive_input = root.features.deriveFeatures.createInput(source_design)
    derive_input.sourceEntities = list(bodies)      # 必须是列表，不是 ObjectCollection
    try:
        derive_input.isPlaceObjectsAtOrigin = True
    except Exception:
        pass
    root.features.deriveFeatures.add(derive_input)
    new_bodies = [root.bRepBodies.item(i)
                  for i in range(count_before, root.bRepBodies.count)]
    if y0_mm is not None and new_bodies:
        collection = adsk.core.ObjectCollection.create()
        for b in new_bodies:
            collection.add(b)
        move_input = root.features.moveFeatures.createInput2(collection)
        move_input.transform = placement_matrix(y0_mm)   # 没有 defineAsTransform
        root.features.moveFeatures.add(move_input)
    step("%-12s -> %d bodies, y0=%s" % (label, len(new_bodies), y0_mm))


box_doc = open_by_name("WindowBox")
box_design = design_of(box_doc)
# ⚠️ 必须把盒子的**所有**实体都派生进来。曾用 `if startswith("WindowBox"): box_body = b`
#    且**没写 break**，结果循环被最后一个匹配项（WindowBox cap）覆盖 —— 配合文档里
#    只剩盖子，壳体根本没参与干涉检查，却报出"干涉 0"的假结论。
box_bodies = []
for i in range(box_design.rootComponent.bRepBodies.count):
    b = box_design.rootComponent.bRepBodies.item(i)
    if b.name.startswith("WindowBox"):
        box_bodies.append(b)
report["boxBodyNames"] = [b.name for b in box_bodies]
derive_and_place(box_design, box_bodies, None, "WindowBox(+cap)")

# ⚠️ 不再装万向节：原设计的 M42 套筒方案实测干涉 2.02 cm3（套筒 Ø42 撞穿万向节
#    内部 y=110..125 那段 Ø41->Ø19 的锥腔，而且球头也占在同一个腔里），已改成
#    盒子后端直接出 M5 螺杆、相机单独拧上去。这里只验盒子和相机。
camera_doc = open_by_name("Camera B210")
camera_design = design_of(camera_doc)
derive_and_place(camera_design, [camera_design.rootComponent.bRepBodies.item(0)],
                 45.0, "Camera")

# --------------------------------------------------------------------------- #
# 2. 干涉检查
# --------------------------------------------------------------------------- #

report["bodies"] = []
for i in range(root.bRepBodies.count):
    b = root.bRepBodies.item(i)
    bb = b.boundingBox
    report["bodies"].append({
        "name": b.name,
        "volume_cm3": round(b.volume, 3),
        "y_mm": [round(bb.minPoint.y / MM, 1), round(bb.maxPoint.y / MM, 1)],
    })

try:
    entities = adsk.core.ObjectCollection.create()
    for i in range(root.bRepBodies.count):
        entities.add(root.bRepBodies.item(i))
    interference_input = design.createInterferenceInput(entities)
    results = design.analyzeInterference(interference_input)
    report["interferenceCount"] = results.count
    report["interferences"] = []
    for i in range(results.count):
        r = results.item(i)
        report["interferences"].append({
            "between": [r.entityOne.name, r.entityTwo.name],
            "volume_cm3": round(r.interferenceBody.volume, 4),
        })
    step("interference -> %d" % results.count)
except Exception as exc:
    report["errors"].append("interference: %s: %s" % (type(exc).__name__, exc))

# --------------------------------------------------------------------------- #
# 3. 保存
# --------------------------------------------------------------------------- #

try:
    if created_new:
        folder = project_folder()
        saved = doc.saveAs(FIT_NAME, folder, "", "")
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
