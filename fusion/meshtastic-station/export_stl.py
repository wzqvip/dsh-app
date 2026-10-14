# -*- coding: utf-8 -*-
"""
导出外壳两个件的 STL 并重出渲染图。

    python fusion/bridge_client.py exec --file fusion/meshtastic-station/export_stl.py --timeout 900

产出到仓库根 exports/（已 gitignore）
"""

import os
import time

EXPORT_DIR = r"C:\Users\WANGZ\Documents\GitHub\dsh-app\exports"
SHOT_DIR = r"C:\Users\WANGZ\Documents\GitHub\dsh-app\fusion\meshtastic-station\shots"
for d in (EXPORT_DIR, SHOT_DIR):
    os.makedirs(d, exist_ok=True)

JOBS = [
    ("MeshCase_Tray", "MeshCase_Tray.stl"),
    ("MeshCase_Cover", "MeshCase_Cover.stl"),
]

report = {"exports": [], "shots": [], "errors": []}


def find_doc(name):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


for doc_name, filename in JOBS:
    doc = find_doc(doc_name)
    if doc is None:
        report["errors"].append(doc_name + " not open")
        continue
    doc.activate()
    # ⚠️ activate() 是延迟的，不等就会导到上一个文档
    for _ in range(30):
        adsk.doEvents()
        time.sleep(0.2)
    if not app.activeDocument.name.startswith(doc_name):
        report["errors"].append("activate 失败: %s" % app.activeDocument.name)
        continue
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    root = design.rootComponent
    root.isConstructionFolderLightBulbOn = False
    root.isSketchFolderLightBulbOn = False
    root.isOriginFolderLightBulbOn = False
    out = os.path.join(EXPORT_DIR, filename)
    if os.path.exists(out):
        os.remove(out)
    opts = design.exportManager.createSTLExportOptions(root, out)
    try:
        opts.meshRefinement = adsk.core.MeshRefinementSettings.MeshRefinementHigh
    except Exception:
        pass
    opts.isBinary = True
    design.exportManager.execute(opts)
    for _ in range(120):
        adsk.doEvents()
        time.sleep(0.2)
        if os.path.exists(out) and os.path.getsize(out) > 0:
            break
    body = root.bRepBodies.item(0)
    report["exports"].append({
        "document": doc.name,
        "file": filename,
        "KB": os.path.getsize(out) // 1024 if os.path.exists(out) else 0,
        "volume_cm3": round(body.volume, 3),
        "mass_g_PLA": round(body.volume * 1.24, 1),
    })
    # 渲染
    vp = app.activeViewport
    for tag, orient, persp in (("iso", adsk.core.ViewOrientations.IsoTopLeftViewOrientation, True),
                               ("iso2", adsk.core.ViewOrientations.IsoBottomRightViewOrientation, True),
                               ("bottom", adsk.core.ViewOrientations.BottomViewOrientation, False)):
        c = vp.camera
        c.viewOrientation = orient
        c.cameraType = (adsk.core.CameraTypes.PerspectiveCameraType if persp
                        else adsk.core.CameraTypes.OrthographicCameraType)
        c.isFitView = True
        vp.camera = c
        vp.visualStyle = adsk.core.VisualStyles.ShadedVisualStyle
        vp.refresh()
        adsk.doEvents()
        time.sleep(0.7)
        adsk.doEvents()
        path = os.path.join(SHOT_DIR, "%s_%s.png" % (doc_name, tag))
        if os.path.exists(path):
            os.remove(path)
        vp.saveAsImageFile(path, 1000, 800)
        report["shots"].append({"doc": doc_name, "view": tag,
                                "bytes": os.path.getsize(path) if os.path.exists(path) else 0})

result = report
