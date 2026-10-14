# -*- coding: utf-8 -*-
"""把当前活动文档从多个视角截图，用来肉眼验收 Fusion 里的模型。

    python fusion/bridge_client.py exec --file fusion/noorio-b310/shoot_views.py

为什么需要它：Fusion 的 API 能读到精确尺寸，但读不出"好不好看"。
改一版、截一版、看图再改，是这套桥最有价值的用法之一。

顶部 CONFIG 直接改；默认对**当前活动文档**操作。
"""

import os
import time

import adsk.core

CONFIG = {
    # None = 用当前活动文档；否则填文档名，脚本会先激活它
    "document": None,
    "outdir": r"C:\Users\WANGZ\Documents\GitHub\dsh-app\.fusion-shots",
    "width": 1100,
    "height": 850,
    "views": ["iso", "front", "right", "left", "top"],
    "prefix": "",          # 留空则用文档名
    "restore_camera": True,
}

_ORIENTATIONS = {
    "iso": "IsoTopRightViewOrientation",
    "iso_left": "IsoTopLeftViewOrientation",
    "front": "FrontViewOrientation",
    "back": "BackViewOrientation",
    "right": "RightViewOrientation",
    "left": "LeftViewOrientation",
    "top": "TopViewOrientation",
    "bottom": "BottomViewOrientation",
}


def _find_document(name):
    for i in range(app.documents.count):
        candidate = app.documents.item(i)
        if candidate.name == name:
            return candidate
    return None


doc = app.activeDocument
if CONFIG["document"]:
    found = _find_document(CONFIG["document"])
    if found is None:
        result = {"ok": False, "error": "document not found", "requested": CONFIG["document"],
                  "open": [d.name for d in app.documents]}
        raise SystemExit
    found.activate()
    for _ in range(60):
        adsk.doEvents()
        time.sleep(0.1)
        if adsk.fusion.Design.cast(app.activeProduct) is not None:
            break
    doc = found

outdir = CONFIG["outdir"]
os.makedirs(outdir, exist_ok=True)

viewport = app.activeViewport
if viewport is None:
    result = {"ok": False, "error": "no active viewport"}
else:
    camera = viewport.camera
    saved = {
        "viewOrientation": camera.viewOrientation,
        "cameraType": camera.cameraType,
        "isFitView": camera.isFitView,
        "eye": (camera.eye.x, camera.eye.y, camera.eye.z),
        "target": (camera.target.x, camera.target.y, camera.target.z),
    }
    saved_style = viewport.visualStyle

    prefix = CONFIG["prefix"] or doc.name.replace(" ", "_")
    shots = []
    orientations = adsk.core.ViewOrientations
    for label in CONFIG["views"]:
        attr = _ORIENTATIONS.get(label)
        if attr is None:
            shots.append({"view": label, "error": "unknown view"})
            continue
        cam = viewport.camera
        cam.viewOrientation = getattr(orientations, attr)
        cam.cameraType = adsk.core.CameraTypes.OrthographicCameraType
        cam.isFitView = True
        viewport.camera = cam
        viewport.visualStyle = adsk.core.VisualStyles.ShadedWithVisibleEdgesOnlyVisualStyle
        viewport.refresh()
        adsk.doEvents()
        time.sleep(0.3)
        adsk.doEvents()

        path = os.path.join(outdir, "%s_%s.png" % (prefix, label))
        viewport.saveAsImageFile(path, CONFIG["width"], CONFIG["height"])
        # 同 saveAsImageFile 的老规矩：不看返回值，看文件真的写出来了
        shots.append({
            "view": label,
            "path": path,
            "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
        })

    if CONFIG["restore_camera"]:
        cam = viewport.camera
        cam.viewOrientation = saved["viewOrientation"]
        cam.cameraType = saved["cameraType"]
        cam.isFitView = saved["isFitView"]
        viewport.camera = cam
        viewport.visualStyle = saved_style
        viewport.refresh()
        adsk.doEvents()

    result = {"document": doc.name, "outdir": outdir, "shots": shots}
