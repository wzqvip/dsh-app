# -*- coding: utf-8 -*-
"""
外壳 vs PCB 的间隙检查（纯几何，不依赖 Fusion）

    python fusion/meshtastic-station/fit_check.py

把外壳的内腔当成一组盒子，把 PCB 上的模块当成盒子，逐条比较。
元件外形按标准模块尺寸取值（见下），偏保守——留余量的方向是"宁可报冲突"。

外壳内腔（与 enclosure.py 的参数一致）
    托盘   X -0.25..60.25   Y -0.25..80.25   Z -11.0 .. 6.0
    前壳（平顶）                              Z -1.0 .. 16.0
    前盖高区（Y>=48）                         Z  6.0 .. 15.5
"""

BOARD_W, BOARD_D, BOARD_T = 60.0, 80.0, 1.6
FIT = 0.6
TRAY_FLOOR_Z = -11.0
SEAM = 6.0
LO_Z = 16.0         # 方盒子：平顶（OLED 实测 14，留 2mm）
HI_Z = 16.0
STEP_Y = 48.0

CAV = {
    "x": (-FIT, BOARD_W + FIT),
    "y": (-FIT, BOARD_D + FIT),
    "tray_z": (TRAY_FLOOR_Z, SEAM),
    "lo_z": (SEAM, LO_Z),
    "hi_z": (SEAM, HI_Z),
}

# 元件盒：名称, x0, y0, x1, y1, z0, z1, 备注
COMPONENTS = [
    # ---- 正面（Z+，ESP32 这一面）----
    ("ESP32-S3-Pico",      35.73,  0.52, 56.73, 51.52,  1.6,  5.1, "51x21 邮票孔模块"),
    ("Pico-BOOT",          38.98, 22.70, 44.98, 28.70,  1.6,  4.2, "6x6 轻触开关"),
    ("Pico-RESET",         47.48, 22.70, 53.48, 28.70,  1.6,  4.2, "6x6 轻触开关"),
    ("OLED-0.96",          32.43, 51.56, 59.53, 79.36,  1.6, 14.0, "27.3x27.8 + 8.5 排针座"),
    ("ATGM336H-GPS",       22.08, 54.94, 47.08, 79.94,  1.6, 11.0, "25x25 模块"),
    ("GY-BMP280",          45.62, 60.65, 60.62, 71.65,  1.6, 11.0, "15x11，会探出板右侧"),
    ("DC-005-A200",        13.57,  6.03, 27.57, 15.03,  1.6, 12.0, "桶形电源座 14.2x9x11"),
    ("PDC004-PD",           0.99,  6.76, 12.99, 29.76,  1.6,  5.5, "23x12，USB-C 座朝 -Y"),
    # ---- 背面（Z-）----
    ("E22-900M33S",         2.24, 44.77, 28.24, 70.77, -4.0,  0.0, "26x26 射频模块"),
    ("GY-BMI160",          37.26, 61.54, 52.26, 72.54, -4.0,  0.0, "15x11"),
    ("PCF8563-HW-689",     34.11, 46.41, 59.11, 61.41, -5.0,  0.0, "25x15"),
    ("MP2482-DCDC",         5.50,  8.00, 25.50, 23.00, -10.0, 0.0, "成品降压小板"),
    ("C-470uF",            28.39, 32.05, 36.39, 40.05, -10.5, 0.0, "Ø8x10.5 电解"),
]

OPENINGS = [
    ("PD-USB-C",   6.99, 10.0,  1.2,  5.0),
    ("DC5521",    20.57,  9.0,  2.2,  4.2),   # Ø9 圆孔，中心 Z=3.2
    ("Pico-USB-C", 46.23, 10.5, 1.2,  4.8),
]


def overlap(a, b):
    return (min(a[1], b[1]) - max(a[0], b[0]))


def main():
    problems = []
    print("板 %.0f x %.0f x %.1f mm" % (BOARD_W, BOARD_D, BOARD_T))
    print("=" * 78)
    for (name, x0, y0, x1, y1, z0, z1, note) in COMPONENTS:
        # 1) 是否在内腔 XY 范围内
        dx_lo = x0 - CAV["x"][0]
        dx_hi = CAV["x"][1] - x1
        dy_lo = y0 - CAV["y"][0]
        dy_hi = CAV["y"][1] - y1
        # 2) Z 方向是否够
        if z0 < 0:                      # 背面元件
            z_ok = z0 >= CAV["tray_z"][0]
            z_head = "托盘底 %.1f (需 <= %.1f)" % (z0, CAV["tray_z"][0])
        else:                            # 正面元件
            ceil = HI_Z          # 平顶：所有正面元件同一个额度
            z_ok = z1 <= ceil
            z_head = "顶面 %.1f (可用 %.1f)" % (z1, ceil)
        flags = []
        if dx_lo < 0:
            flags.append("左侧越界 %.2f" % dx_lo)
        if dx_hi < 0:
            flags.append("右侧越界 %.2f" % dx_hi)
        if dy_lo < 0:
            flags.append("下侧越界 %.2f" % dy_lo)
        if dy_hi < 0:
            flags.append("上侧越界 %.2f" % dy_hi)
        if not z_ok:
            flags.append("Z 冲突")
        state = "OK " if not flags else "!! "
        print("%s%-16s %-22s x[%6.1f,%6.1f] y[%6.1f,%6.1f] %s"
              % (state, name, note, x0, x1, y0, y1, z_head))
        if flags:
            print("      -> " + "; ".join(flags))
            problems.append((name, flags))

    print("=" * 78)
    print("底壁开孔对位（开的孔中心 X vs 元件中心 X）")
    for (name, cx, w, z0, z1) in OPENINGS:
        print("   %-12s 孔 X=%.2f 宽 %.1f  Z %.1f..%.1f" % (name, cx, w, z0, z1))

    print("=" * 78)
    if problems:
        print("发现 %d 处需要处理：" % len(problems))
        for name, flags in problems:
            print("   %-16s %s" % (name, "; ".join(flags)))
    else:
        print("全部通过：所有元件都在内腔之内，且 Z 向都有余量。")
    return problems


if __name__ == "__main__":
    main()
