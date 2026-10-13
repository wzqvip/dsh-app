# -*- coding: utf-8 -*-
"""导出可打印件的 STL。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

产出到仓库根的 `exports/`（已 gitignore —— STL 是二进制产物，每次重建都会变，
不跟着版本走；真正要复现的是本脚本）。

# ⚠️ exportManager 挂在 Design 上，不是 Application 上

    app.exportManager       ✗ AttributeError
    design.exportManager    ✓

# 导出清单

| 文件 | 来源文档 | 实体 | 用途 |
|---|---|---|---|
| `Stand_v5_plus_bottom.stl` | Stand v5 | Stand v5 + bottom | 桌面支架本体（已含底座，一次成型） |
| `WindowBox.stl`              | WindowBox | WindowBox | 窗户挂盒 |
| `Camera_B210_mock.stl`       | Camera B210 | Camera B210 | **试装假件** —— 先用它验间隙再打盒子 |

三个文档的 rootComponent 都只有**一个**实体，所以直接整体导出即可；
哪天某个文档多了实体，就得改成按可见性/单独导出了。
"""

import os
import time

import adsk.core
import adsk.fusion

EXPORT_DIR = r"C:\Users\WANGZ\Documents\GitHub\dsh-app\exports"

JOBS = [
    ("Stand v5", "Stand_v5_plus_bottom.stl"),
    ("WindowBox", "WindowBox.stl"),
    ("Camera B210", "Camera_B210_mock.stl"),
]

report = {"exports": [], "errors": []}


def find_doc(name):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


os.makedirs(EXPORT_DIR, exist_ok=True)

for doc_name, out_name in JOBS:
    doc = find_doc(doc_name)
    if doc is None:
        report["errors"].append("%s not open" % doc_name)
        continue
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    root = design.rootComponent
    path = os.path.join(EXPORT_DIR, out_name)
    if os.path.exists(path):
        os.remove(path)
    try:
        options = design.exportManager.createSTLExportOptions(root, path)
        try:
            options.meshRefinement = adsk.core.MeshRefinementSettings.MeshRefinementHigh
        except Exception:
            pass
        options.isBinary = True
        design.exportManager.execute(options)
        for _ in range(60):
            adsk.doEvents()
            time.sleep(0.2)
            if os.path.exists(path) and os.path.getsize(path) > 0:
                break
        size = os.path.getsize(path) if os.path.exists(path) else 0
        report["exports"].append({
            "document": doc.name,
            "file": path,
            "MB": round(size / 1048576.0, 2),
            "bodies": [root.bRepBodies.item(j).name
                       for j in range(root.bRepBodies.count)],
        })
    except Exception as exc:
        report["errors"].append("%s: %s: %s" % (doc_name, type(exc).__name__, exc))

result = report
