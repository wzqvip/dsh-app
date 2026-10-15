# -*- coding: utf-8 -*-
"""
ESP32-S3 / SX1262 Meshtastic Station —— 3D 打印外壳（v3：方盒子）

    python fusion/bridge_client.py exec --file fusion/meshtastic-station/enclosure.py --timeout 900

产出 `MeshCase_Tray`（背壳托盘）、`MeshCase_Cover`（前盖）。

设计原则（按用户反馈精简）
    * **就是一个方盒子**：Tray + Cover，平顶，对应位置开窗，不做阶梯/凸台
    * 正面内高按 **OLED 的 12mm** 定（其他器件都没这么高）
    * 背面内高按 **470uF 大电容** 定
    * PCB 靠**侧边几个小托板**托住（不是整圈台阶）
    * 两个按键**各自独立**（三边挖槽 + 中间那道槽切开）
    * 按键凸起按"PCB 到按钮顶约 4mm"来定，**允许留缝**（行程长，不必紧贴）

坐标（沿用 PCB，Y 已平移 -15，板下沿 = Y0）
    X 0..60  左右      Y 0..80  下上      Z 0..1.6 板厚，**Z+ = ESP32 面 = 正面**
"""

import math

MM = 0.1
DOC_TRAY = "MeshCase_Tray"
DOC_COVER = "MeshCase_Cover"

# --------------------------------------------------------------------------- #
# 尺寸
# --------------------------------------------------------------------------- #
BOARD_W, BOARD_D, BOARD_T = 60.0, 80.0, 1.6
WALL = 3.0
FIT = 0.25                       # 板与内腔单边间隙

# 分模面放在**板的下面 1mm**：这样板、屏幕、三个连接器全在**前壳**里（用户要的），
# 背壳只是一个浅后盖，RF 天线（SMA）穿它的底面。
SEAM = -1.0
TRAY_Z0, TRAY_Z1 = -13.5, SEAM   # 背壳（后盖）：内部底面 -11，容 470uF 的 10.5
TRAY_FLOOR_IN = -11.0
FLOOR = 2.5

COVER_Z0 = SEAM                  # 前壳从分模面起
COVER_IN_Z = 15.0                # 前壳内顶面（平）：1.6 板 + 12 OLED + 1.4 余量
COVER_TOP = COVER_IN_Z + 2.5     # 前壳外顶面
TONGUE_D, TONGUE_T = 1.5, 1.0    # 止口：做成**壁厚内侧**的一圈，不侵占内腔
TONGUE_CLR = 0.30                # 止口与后壳让位之间的间隙
DC_RELIEF_W, DC_RELIEF_Z = 12.0, 10.0   # 前盖底壁给 DC 插头让路的开口

# PCB 托板（侧边几个小凸台，板搭在上面）
TAB_LEN, TAB_DEPTH, TAB_TH = 8.0, 1.5, 1.0    # 托板 1mm 厚（-1..0，板底面在 0）
TAB_YS = [8.0, 38.0, 68.0]       # 每侧 3 个

# 底壁开孔（都在托盘的 -Y 壁）
PD_X, PD_W, PD_Z0, PD_Z1 = 6.99, 10.0, 1.2, 5.0
DC_X, DC_D, DC_ZC = 20.57, 9.0, 3.2
PICO_X, PICO_W, PICO_Z0, PICO_Z1 = 46.23, 10.5, 1.2, 4.8

# 前盖
OLED_X, OLED_Y, OLED_W, OLED_H = 45.98, 65.46, 23.0, 12.0
BTN_X, BTN_Y, BTN_DX = 46.23, 25.7, 4.25
PLATE_W, PLATE_H = 7.0, 9.0      # **每块**按键板
SLOT_W = 1.0
HINGE_T = 1.3
PLUNGER_R = 2.5
BTN_TOP_Z = 5.6                  # 板上表面 1.6 + 4mm（用户给的参考）
PLUNGER_TIP_Z = 7.5              # 尖端到 7.5 -> 与按钮顶留 1.9mm 缝（行程长，不必紧贴）
SENSOR_Y0, SENSOR_Y1, SENSOR_Z0, SENSOR_Z1 = 56.0, 76.0, 2.0, 14.0
SMA_X, SMA_Z, SMA_D = 15.24, -4.0, 6.0   # 后壳**顶部壁**（+Y），贴 E22 模块的高度
GPS_X0, GPS_X1, GPS_Z0, GPS_Z1 = 39.0, 59.0, 8.0, 14.0
GPS_DEPTH, GPS_LIP = 1.5, 1.2

# --------------------------------------------------------------------------- #
app = adsk.core.Application.get()
report = {"steps": [], "errors": [], "docs": {}}


def step(m):
    report["steps"].append(m)


def V(v):
    return adsk.core.ValueInput.createByReal(v * MM)


def P(x, y, z=0.0):
    return adsk.core.Point3D.create(x * MM, y * MM, z * MM)


def design_of(doc):
    return adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))


def find_doc(name):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.name == name or d.name.startswith(name + " "):
            return d
    return None


def fresh(name):
    doc = find_doc(name)
    if doc is None:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        try:
            doc.name = name
        except Exception:
            pass
    design = design_of(doc)
    if design is None:
        raise RuntimeError("design is None: " + name)
    root = design.rootComponent
    # ⚠️ 必须删特征，不能只删实体（只删实体仍被时间轴引用，体积会在两次运行之间乱跳）
    for i in range(root.features.count - 1, -1, -1):
        try:
            root.features.item(i).deleteMe()
        except Exception:
            pass
    for coll in (root.bRepBodies, root.sketches, root.constructionPlanes):
        for i in range(coll.count - 1, -1, -1):
            try:
                coll.item(i).deleteMe()
            except Exception:
                pass
    root.isConstructionFolderLightBulbOn = False
    root.isSketchFolderLightBulbOn = False
    root.isOriginFolderLightBulbOn = False
    step("[%s] ready" % name)
    return doc, design, root


def _sp(sk, x, y, z=0.0):
    """模型坐标 -> 草图坐标（必须用 Fusion 自己的换算，自己推会整体平移且不报错）"""
    return sk.modelToSketchSpace(P(x, y, z))


def draw_rect(sk, x0, y0, x1, y1):
    ln = sk.sketchCurves.sketchLines
    ln.addByTwoPoints(_sp(sk, x0, y0), _sp(sk, x1, y0))
    ln.addByTwoPoints(_sp(sk, x1, y0), _sp(sk, x1, y1))
    ln.addByTwoPoints(_sp(sk, x1, y1), _sp(sk, x0, y1))
    ln.addByTwoPoints(_sp(sk, x0, y1), _sp(sk, x0, y0))


def draw_rounded_rect(sk, x0, y0, x1, y1, r):
    """圆角矩形：四边逆时针，四段弧的**起点取对应边的起点**，否则接不上、profiles=0"""
    ln = sk.sketchCurves.sketchLines
    ar = sk.sketchCurves.sketchArcs
    p = lambda x, y: _sp(sk, x, y)
    ln.addByTwoPoints(p(x0 + r, y0), p(x1 - r, y0))
    ln.addByTwoPoints(p(x1, y0 + r), p(x1, y1 - r))
    ln.addByTwoPoints(p(x1 - r, y1), p(x0 + r, y1))
    ln.addByTwoPoints(p(x0, y1 - r), p(x0, y0 + r))
    ar.addByCenterStartSweep(p(x1 - r, y0 + r), p(x1 - r, y0), math.radians(90))
    ar.addByCenterStartSweep(p(x1 - r, y1 - r), p(x1, y1 - r), math.radians(90))
    ar.addByCenterStartSweep(p(x0 + r, y1 - r), p(x0 + r, y1), math.radians(90))
    ar.addByCenterStartSweep(p(x0 + r, y0 + r), p(x0, y0 + r), math.radians(90))


def op_at(root, z_lo, z_hi, draw, operation, name):
    """在 Z 区间 [z_lo, z_hi] 做拉伸/切除。

    ⚠️ 这个桥里：草图一律画在 XY 平面；`setTwoSidesDistanceExtent(a, b)` 的实际区间是
       **[-b, +a]**（实测 (10,-8) -> 8..10）。用构造平面偏移**不会**改变拉伸的 Z 位置。
    """
    sk = root.sketches.add(root.xYConstructionPlane)
    sk.name = name + "_sk"
    draw(sk)
    if sk.profiles.count < 1:
        raise RuntimeError("%s: 轮廓未闭合 (profiles=%d)" % (name, sk.profiles.count))
    ext = root.features.extrudeFeatures
    ei = ext.createInput(sk.profiles.item(0), operation)
    ei.setTwoSidesDistanceExtent(V(z_hi), V(-z_lo))
    f = ext.add(ei)
    f.name = name
    sk.isVisible = False
    return f


def body_rect(root, x0, y0, x1, y1, z_lo, z_hi, r, name):
    op_at(root, z_lo, z_hi, lambda sk: draw_rounded_rect(sk, x0, y0, x1, y1, r),
          adsk.fusion.FeatureOperations.NewBodyFeatureOperation, name)
    b = root.bRepBodies.item(root.bRepBodies.count - 1)
    b.name = name
    return b


def cut_rect(root, x0, y0, x1, y1, z_lo, z_hi, name):
    return op_at(root, z_lo, z_hi, lambda sk: draw_rect(sk, x0, y0, x1, y1),
                 adsk.fusion.FeatureOperations.CutFeatureOperation, name)


def join_rect(root, x0, y0, x1, y1, z_lo, z_hi, name):
    return op_at(root, z_lo, z_hi, lambda sk: draw_rect(sk, x0, y0, x1, y1),
                 adsk.fusion.FeatureOperations.JoinFeatureOperation, name)


def cut_circle_y(root, cx, cz, d, y_lo, y_hi, name):
    """沿 **Y** 方向切圆孔（草图画在 XZ 平面）。

    ⚠️ 从侧壁穿出去的孔（DC5521、SMA）必须用它。草图画在 XY 平面上会变成沿 Z 的孔，
       在侧壁上只留下一条竖线（实测踩过两次）。
    """
    sk = root.sketches.add(root.xZConstructionPlane)
    sk.name = name + "_sk"
    sk.sketchCurves.sketchCircles.addByCenterRadius(
        sk.modelToSketchSpace(P(cx, 0.0, cz)), d / 2.0 * MM)
    if sk.profiles.count < 1:
        raise RuntimeError("%s: 圆未闭合" % name)
    ext = root.features.extrudeFeatures
    ei = ext.createInput(sk.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
    ei.setTwoSidesDistanceExtent(V(y_hi), V(-y_lo))
    f = ext.add(ei)
    f.name = name
    sk.isVisible = False
    return f


def cut_circle_z(root, cx, cy, d, z_lo, z_hi, name):
    """沿 **Z** 方向切圆孔（草图画在 XY 平面）。背面的 RF 天线孔用它。"""
    sk = root.sketches.add(root.xYConstructionPlane)
    sk.name = name + "_sk"
    sk.sketchCurves.sketchCircles.addByCenterRadius(_sp(sk, cx, cy), d / 2.0 * MM)
    if sk.profiles.count < 1:
        raise RuntimeError("%s: 圆未闭合" % name)
    ext = root.features.extrudeFeatures
    ei = ext.createInput(sk.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
    ei.setTwoSidesDistanceExtent(V(z_hi), V(-z_lo))
    f = ext.add(ei)
    f.name = name
    sk.isVisible = False
    return f


def join_circle_z(root, cx, cy, d, z_lo, z_hi, name):
    """沿 Z 方向合并圆柱（按键凸起）。"""
    sk = root.sketches.add(root.xYConstructionPlane)
    sk.name = name + "_sk"
    sk.sketchCurves.sketchCircles.addByCenterRadius(_sp(sk, cx, cy), d / 2.0 * MM)
    ext = root.features.extrudeFeatures
    ei = ext.createInput(sk.profiles.item(0), adsk.fusion.FeatureOperations.JoinFeatureOperation)
    ei.setTwoSidesDistanceExtent(V(z_hi), V(-z_lo))
    f = ext.add(ei)
    f.name = name
    sk.isVisible = False
    return f


def info(root, key):
    b = root.bRepBodies.item(0)
    bb = b.boundingBox
    report["docs"][key] = {
        "volume_cm3": round(b.volume, 3),
        "mass_g_PLA": round(b.volume * 1.24, 1),
        "bbox_mm": [round((bb.maxPoint.x - bb.minPoint.x) / MM, 1),
                    round((bb.maxPoint.y - bb.minPoint.y) / MM, 1),
                    round((bb.maxPoint.z - bb.minPoint.z) / MM, 1)],
        "z_range": [round(bb.minPoint.z / MM, 1), round(bb.maxPoint.z / MM, 1)],
        "faces": b.faces.count,
        "bodies": root.bRepBodies.count,
    }


# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# 背壳（后盖）：浅盒 + 背面 RF 天线孔 + 止口让位
#   用户明确：DC 和两个 USB-C 属于**屏幕那一半**（前壳），RF 天线在**另外一侧**（背面）
# --------------------------------------------------------------------------- #
def build_tray():
    doc, design, root = fresh(DOC_TRAY)
    ox0, oy0, ox1, oy1 = -WALL, -WALL, BOARD_W + WALL, BOARD_D + WALL
    cx0, cy0, cx1, cy1 = -FIT, -FIT, BOARD_W + FIT, BOARD_D + FIT

    body_rect(root, ox0, oy0, ox1, oy1, TRAY_Z0, TRAY_Z1, 4.0, DOC_TRAY)
    step("后壳外形: %.3f cm3" % root.bRepBodies.item(0).volume)

    # 内腔：从内部底面到分模面（容背面的 470uF 等）
    cut_rect(root, cx0, cy0, cx1, cy1, TRAY_FLOOR_IN, TRAY_Z1 + 1.0, "cavity")
    step("背壳内腔: %.3f cm3" % root.bRepBodies.item(0).volume)

    # 前壳止口插进来的让位：止口在壁厚内侧（cx0-TONGUE_T .. cx0），
    # 所以这里要把对应位置挖开一点
    cut_rect(root, cx0 - TONGUE_T - TONGUE_CLR, cy0 - TONGUE_T - TONGUE_CLR,
             cx1 + TONGUE_T + TONGUE_CLR, cy1 + TONGUE_T + TONGUE_CLR,
             SEAM - TONGUE_D, SEAM + 0.2, "rim_relief")
    step("止口让位: %.3f cm3" % root.bRepBodies.item(0).volume)

    # PCB 托板：从分模面往上涨到 Z=0，托住板（放在后壳，前壳内腔才通畅）
    for y in TAB_YS:
        ty0, ty1 = y - TAB_LEN / 2, y + TAB_LEN / 2
        join_rect(root, cx0 - 2.0, ty0, cx0 + TAB_DEPTH, ty1, TRAY_Z1 - TAB_TH, 0.0, "tab_l_%.0f" % y)
        join_rect(root, cx1 - TAB_DEPTH, ty0, cx1 + 2.0, ty1, TRAY_Z1 - TAB_TH, 0.0, "tab_r_%.0f" % y)
    join_rect(root, 12.0, cy0 - 2.0, 15.0, cy0 + TAB_DEPTH, TRAY_Z1 - TAB_TH, 0.0, "tab_b1")
    join_rect(root, 26.0, cy0 - 2.0, 48.0, cy0 + TAB_DEPTH, TRAY_Z1 - TAB_TH, 0.0, "tab_b2")
    join_rect(root, 12.0, cy1 - TAB_DEPTH, 48.0, cy1 + 2.0, TRAY_Z1 - TAB_TH, 0.0, "tab_t")
    step("PCB 托板: %.3f cm3" % root.bRepBodies.item(0).volume)

    # RF 天线：Ø6 圆孔开在**后壳顶部壁（+Y）**，天线从顶部出去
    cut_circle_y(root, SMA_X, SMA_Z, SMA_D,
                 BOARD_D + FIT - 1.0, BOARD_D + WALL + 1.0, "hole_sma")
    step("SMA Ø%.1f 顶部圆孔" % SMA_D)

    info(root, DOC_TRAY)
    return doc


# --------------------------------------------------------------------------- #
# 前壳：收下板 + 屏幕 + 三个连接器（都在这一半）
# --------------------------------------------------------------------------- #
def build_cover():
    doc, design, root = fresh(DOC_COVER)
    ox0, oy0, ox1, oy1 = -WALL, -WALL, BOARD_W + WALL, BOARD_D + WALL
    cx0, cy0, cx1, cy1 = -FIT, -FIT, BOARD_W + FIT, BOARD_D + FIT

    body_rect(root, ox0, oy0, ox1, oy1, COVER_Z0, COVER_TOP, 4.0, DOC_COVER)
    step("前壳外形: %.3f cm3" % root.bRepBodies.item(0).volume)

    # 平的内腔：从分模面一直到内顶面
    cut_rect(root, cx0, cy0, cx1, cy1, COVER_Z0 - 1.0, COVER_IN_Z, "cavity")
    step("内腔: %.3f cm3" % root.bRepBodies.item(0).volume)

    # ⚠️ 前壳内腔**不放任何托板**：板要从 -Z 侧整体放进这个腔，
    #    腔里只要多出 1mm 就会把板挡住（原来 8 个内侧托板就是这么挡的）。
    #    托板改到后壳上，从分模面往上涨到 Z=0（见 build_tray）。

    # 止口：往下插进背壳，必须搭到本体的底面（否则无操作、整圈消失）
    # ⚠️ 止口必须在**壁厚里**（cx0-TONGUE_T .. cx0），不能伸进内腔 ——
    #    之前做成 cx0..cx0+TONGUE_T，等于在内腔里加了一圈 1.5mm 的收口，
    #    板只比内腔小 0.25mm，根本放不进去（用户实测）。
    join_rect(root, cx0 - TONGUE_T, cy0 - TONGUE_T, cx1 + TONGUE_T, cy1 + TONGUE_T,
              SEAM - TONGUE_D, SEAM + 0.2, "tongue_out")
    cut_rect(root, cx0, cy0, cx1, cy1, SEAM - TONGUE_D - 0.5, SEAM + 0.5, "tongue_in")
    step("止口: %.3f cm3" % root.bRepBodies.item(0).volume)

    # 底壁三个连接器开口 —— 全部在这一半的底壁（用户：屏幕那一侧的底部）
    wy0, wy1 = oy0 - 1.0, cy0 + 0.25
    cut_rect(root, PD_X - PD_W / 2, wy0, PD_X + PD_W / 2, wy1, PD_Z0, PD_Z1, "cut_pd")
    cut_circle_y(root, DC_X, DC_ZC, DC_D, wy0, wy1, "cut_dc")
    cut_rect(root, PICO_X - PICO_W / 2, wy0, PICO_X + PICO_W / 2, wy1,
             PICO_Z0, PICO_Z1, "cut_pico")
    step("底壁三孔: %.3f cm3" % root.bRepBodies.item(0).volume)

    # OLED 窗口
    cut_rect(root, OLED_X - OLED_W / 2, OLED_Y - OLED_H / 2,
             OLED_X + OLED_W / 2, OLED_Y + OLED_H / 2,
             COVER_IN_Z - 2.0, COVER_TOP + 1.0, "win_oled")
    step("OLED 窗口")

    # 右侧壁传感器窗口
    cut_rect(root, BOARD_W + FIT - 1.0, SENSOR_Y0, BOARD_W + WALL + 1.0, SENSOR_Y1,
             SENSOR_Z0, SENSOR_Z1, "win_sensor")
    step("传感器窗口")

    # 顶壁右侧：GPS 陶瓷贴片槽 + 槽底 + 挡边
    wall_in, wall_out = BOARD_D + FIT - 0.5, BOARD_D + WALL
    cut_rect(root, GPS_X0, wall_in, GPS_X1, wall_out + 1.0, GPS_Z0, GPS_Z1, "pocket_gps")
    join_rect(root, GPS_X0 - GPS_LIP, wall_in, GPS_X1 + GPS_LIP, wall_out,
              GPS_Z0 - GPS_DEPTH, GPS_Z0, "gps_floor")
    join_rect(root, GPS_X0 - GPS_LIP, wall_out - GPS_LIP, GPS_X1 + GPS_LIP, wall_out,
              GPS_Z1, GPS_Z1 + GPS_LIP, "gps_tab")
    step("GPS 槽")

    # 两块独立按键板
    py0, py1 = BTN_Y - PLATE_H / 2, BTN_Y + PLATE_H / 2
    zt0, zt1 = COVER_Z0 - 1.0, COVER_TOP + 1.0
    lx0, lx1 = BTN_X - BTN_DX - PLATE_W / 2, BTN_X - BTN_DX + PLATE_W / 2
    rx0, rx1 = BTN_X + BTN_DX - PLATE_W / 2, BTN_X + BTN_DX + PLATE_W / 2
    cut_rect(root, lx0 - SLOT_W, py0 - SLOT_W, lx0, py1 + SLOT_W, zt0, zt1, "slot_l_out")
    cut_rect(root, lx1, py0 - SLOT_W, rx0, py1 + SLOT_W, zt0, zt1, "slot_mid")
    cut_rect(root, rx1, py0 - SLOT_W, rx1 + SLOT_W, py1 + SLOT_W, zt0, zt1, "slot_r_out")
    cut_rect(root, lx0 - SLOT_W, py0 - SLOT_W, rx1 + SLOT_W, py0, zt0, zt1, "slot_bot")
    hz = COVER_IN_Z + (COVER_TOP - COVER_IN_Z) - HINGE_T
    cut_rect(root, lx0, py1 - 1.0, lx1, py1 + SLOT_W, COVER_IN_Z, hz, "hinge_l")
    cut_rect(root, rx0, py1 - 1.0, rx1, py1 + SLOT_W, COVER_IN_Z, hz, "hinge_r")
    join_circle_z(root, BTN_X - BTN_DX, BTN_Y, PLUNGER_R * 2, PLUNGER_TIP_Z,
                  COVER_IN_Z + 1.0, "plunger_a")
    join_circle_z(root, BTN_X + BTN_DX, BTN_Y, PLUNGER_R * 2, PLUNGER_TIP_Z,
                  COVER_IN_Z + 1.0, "plunger_b")
    step("两块独立按键板（尖端 Z=%.1f，按钮顶 Z=%.1f，留缝 %.1f）"
         % (PLUNGER_TIP_Z, BTN_TOP_Z, PLUNGER_TIP_Z - BTN_TOP_Z))

    info(root, DOC_COVER)
    return doc


# --------------------------------------------------------------------------- #
for fn in (build_tray, build_cover):
    try:
        fn()
    except Exception as exc:
        report["errors"].append("%s: %s: %s" % (fn.__name__, type(exc).__name__, exc))

result = report
