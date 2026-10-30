#!/usr/bin/env python3
"""生成「使用姿态」的剖视图：沿 Y=0 切开，露出机器与夹持剖面。

输出：
    preview-use-iso.png   整件立体（含机器占位）
    preview-section.png   剖面（看得清倒钩与静压腔）
"""

import trimesh

from generate import build_use
from render import render_scene

W, D, H = 196.0, 189.0, 48.0


def main() -> None:
    bracket = build_use(140, W, D, H)
    device = trimesh.creation.box(extents=(W, D, H))
    device.apply_translation((0, 0, H / 2))

    render_scene(
        [(device, (90, 96, 106)), (bracket, (205, 208, 214))], "iso", (1200, 900)
    ).save("preview-use-iso.png")

    slab = trimesh.creation.box(extents=(600, 3, 600))
    bslice = trimesh.boolean.intersection([bracket, slab], engine="manifold")
    dslice = trimesh.creation.box(extents=(W, 3, H))
    dslice.apply_translation((0, 0, H / 2))
    render_scene(
        [(dslice, (90, 96, 106)), (bslice, (205, 208, 214))],
        "front",
        (1400, 1200),
        margin=0.92,
    ).save("preview-section.png")
    print("saved preview-use-iso.png, preview-section.png")


if __name__ == "__main__":
    main()
