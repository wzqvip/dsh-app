# -*- coding: utf-8 -*-
"""
为外壳两个件出渲染图。

    python fusion/bridge_client.py exec --file fusion/meshtastic-station/render_case.py --timeout 600

输出到 fusion/meshtastic-station/shots/
"""

import os
import time

OUTDIR = r"C:\Users\WANGZ\Documents\GitHub\dsh-app\fusion\meshtastic-station\shots"
os.makedirs(OUTDIR, exist_ok=True)

report = {"shots": [], "errors": []}
VIEWS = [
    ("iso", adsk.core.ViewOrientations.IsoTopLeftViewOrientation, True),
    ("iso2", adsk.core.ViewOrientations.IsoBottomRightViewOrientation, True),
    ("front", adsk.core.ViewOrientations.FrontViewOrientation, False),
    ("back", adsk.core.ViewOrientations.BackViewOrientation, False),
    ("bottom", adsk.core.ViewOrientations.BottomViewOrientation, False),
]


def find_doc(name):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


def shots_for(doc_name):
    doc = find_doc(doc_name)
    if doc is None:
        report["errors"].append(doc_name + " not open")
        return
    doc.activate()
    # ⚠️ 跨文档重绘要等：activate() 是延迟的，不 doEvents 会渲到上一个文档
    for _ in range(30):
        adsk.doEvents()
        time.sleep(0.2)
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    root = design.rootComponent
    root.isConstructionFolderLightBulbOn = False
    root.isSketchFolderLightBulbOn = False
    root.isOriginFolderLightBulbOn = False
    vp = app.activeViewport
    for tag, orient, persp in VIEWS:
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
        path = os.path.join(OUTDIR, "%s_%s.png" % (doc_name, tag))
        if os.path.exists(path):
            os.remove(path)
        vp.saveAsImageFile(path, 1000, 800)
        report["shots"].append({"doc": doc_name, "view": tag,
                                "bytes": os.path.getsize(path) if os.path.exists(path) else 0})


for name in ("MeshCase_Tray", "MeshCase_Cover"):
    try:
        shots_for(name)
    except Exception as exc:
        report["errors"].append("%s: %s: %s" % (name, type(exc).__name__, exc))

result = report
