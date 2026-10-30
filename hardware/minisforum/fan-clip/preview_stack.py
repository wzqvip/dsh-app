#!/usr/bin/env python3
"""叠装（上下双风扇）预览：上夹 + 托盘 + 机器占位 + 两把风扇占位。"""

import trimesh

from generate import PLENUM, TRAY_T, build_stack_clip, build_tray
from render import render_scene

W, D, H = 196.0, 189.0, 56.0  # H=56：MS-01 装 718278 后的高度


def main() -> None:
    clip = build_stack_clip(140, W, D, H)
    tray = build_tray(140, W, D)

    dev = trimesh.creation.box(extents=(W, D, H))
    dev.apply_translation((0, 0, TRAY_T + PLENUM + H / 2))

    top_fan = trimesh.creation.cylinder(radius=70, height=25, sections=48)
    top_fan.apply_translation((0, 0, TRAY_T + PLENUM + H + 10 + 4 + 12.5))
    bot_fan = trimesh.creation.cylinder(radius=70, height=25, sections=48)
    bot_fan.apply_translation((0, 0, -12.5))

    parts = [
        (dev, (90, 96, 106)),
        (bot_fan, (60, 64, 72)),
        (top_fan, (60, 64, 72)),
        (tray, (170, 175, 182)),
        (clip, (205, 208, 214)),
    ]
    render_scene(parts, "iso", (1200, 900)).save("preview-stack-iso.png")

    slab = trimesh.creation.box(extents=(600, 3, 600))
    cut = []
    for m, c in parts:
        s = trimesh.boolean.intersection([m, slab], engine="manifold")
        if len(s.faces):
            cut.append((s, c))
    render_scene(cut, "front", (1400, 1400), margin=0.94).save("preview-stack-section.png")
    print("saved preview-stack-iso.png, preview-stack-section.png")


if __name__ == "__main__":
    main()
