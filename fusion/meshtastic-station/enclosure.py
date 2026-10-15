# -*- coding: utf-8 -*-
"""
ESP32-S3 / SX1262 Meshtastic Station —— 3D 打印外壳（v2）

用法（仓库根执行）：
    python fusion/bridge_client.py exec --file fusion/meshtastic-station/enclosure.py --timeout 900

产出：`MeshCase_Tray`（背壳托盘）、`MeshCase_Cover`（前盖）。

坐标约定（沿用 PCB，Gerber 的 Y 已平移 -15，板下沿 = Y0）
    X 0..60   左右
    Y 0..80   下上
    Z 0..1.6  板厚；**Z+ 是 ESP32/Pico 那一面 = 外壳正面**

用户要求对应的实现
    ESP32 面为正面                    -> Z+ 是前盖
    底部左下 C 口 / DC5521 / 右下 ESP32 C 口 -> 托盘底壁(Y=-WALL)三个开孔
    顶部左上 SMA（向上）               -> 前盖顶壁 Ø6 通孔 @ X=15
    正面右上 12864 OLED                -> 前盖高区开窗
    两个按键：连体、三边挖槽、中间突起   -> 低区内顶面上的按键板 + 2 个凸起
    右侧上部温湿度传感器：直接开放窗口   -> 前盖右壁开口
    GPS 陶瓷贴片(20x5x6) 固定顶部右侧    -> 顶壁右侧 20.6x6.6 浅槽 + 挡边
    合盖方式                          -> 前盖带 1.5mm 止口，压入托盘

⚠️ 坐标换算一律走 sketch.modelToSketchSpace()：草图原点不是 plane.geometry.origin，
   自己推算会整体平移且不报错（上一个项目踩掉十几轮）。
"""

import math

MM = 0.1
DOC_TRAY = "MeshCase_Tray"
DOC_COVER = "MeshCase_Cover"

# --------------------------------------------------------------------------- #
# 参数
# --------------------------------------------------------------------------- #
BOARD_W, BOARD_D = 60.0, 80.0
WALL = 3.0
FIT = 0.25                 # 板与内腔单边间隙
LEDGE = 1.5                # 承板台阶宽

TRAY_Z0, TRAY_Z1 = -13.5, 6.0    # 托盘：底面 -> 接缝（底面要容下背面 470uF 的 10.5mm）
FLOOR = 2.5
SEAM = TRAY_Z1

COVER_LO_Z = 6.4            # 低区（按键上方）内顶面：只需盖过 Pico(5.1)/PDC004(5.5)
                            # DC 座(约 12mm) 改用局部凸台 DC_BOSS_Z 容纳，见下
COVER_LO_TOP = 8.9          # 低区外顶面
COVER_HI_Z = 15.5           # 高区（OLED/GPS）内顶面
COVER_HI_TOP = 18.0         # 高区外顶面
STEP_Y = 48.0               # 低/高区分界

# 底壁开孔
PD_X, PD_W, PD_Z0, PD_Z1 = 6.99, 10.0, 1.2, 5.0
DC_X, DC_D, DC_ZC = 20.57, 9.0, 3.2
PICO_X, PICO_W, PICO_Z0, PICO_Z1 = 46.23, 10.5, 1.2, 4.8

# 前盖
OLED_X, OLED_Y, OLED_W, OLED_H = 45.98, 65.46, 23.0, 12.0
BTN_X, BTN_Y, BTN_DX = 46.23, 25.7, 4.25
PLATE_W, PLATE_H = 7.0, 9.0    # **每块**按键板的尺寸（两个按钮各自独立）
SLOT_W = 1.0
HINGE_T = 1.3
BUMP_R, BUMP_H = 2.5, 2.0      # 凸起：顶面降到 6.4 后只需 2mm 就够到 Z~4.4 的按键

SENSOR_Y0, SENSOR_Y1, SENSOR_Z0, SENSOR_Z1 = 56.0, 76.0, 2.0, 14.0  # GY-BMP280 会探出板右侧

# DC5521 桶形座高约 12mm，低区顶面只有 6.4 —— 在它正上方做一个凸台，
# 外侧抬高、内侧挖出凹腔把它罩住（外观像一个小小的接口仓）。
DC_POCKET_X0, DC_POCKET_X1 = 10.0, 31.0
DC_POCKET_Y0, DC_POCKET_Y1 = 3.0, 19.0
DC_POCKET_Z = 13.0          # 凹腔内顶面（DC 高 12 + 1 余量）
DC_BOSS_Z = 15.0            # 凸台外表面（顶壁留 2mm）

SMA_X, SMA_Z, SMA_D = 15.0, 10.0, 6.0
GPS_X0, GPS_X1, GPS_Z0, GPS_Z1 = 39.0, 59.0, 7.0, 13.0
GPS_DEPTH = 1.5
GPS_LIP = 1.2

TONGUE_D = 1.5              # 前盖止口深度
TONGUE_T = 1.5              # 止口壁厚

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
    """取文档并清空（保留文档身份）；不存在则新建。"""
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
    # ⚠️ 必须删**特征**，不能只删实体：只删实体时实体仍被时间轴特征引用，
    #    Fusion 会延迟重建 -> 下次统计仍看得到旧实体，体积在两次运行间乱跳。
    for i in range(root.features.count - 1, -1, -1):
        try:
            root.features.item(i).deleteMe()
        except Exception:
            pass
    for i in range(root.bRepBodies.count - 1, -1, -1):
        try:
            root.bRepBodies.item(i).deleteMe()
        except Exception:
            pass
    for i in range(root.sketches.count - 1, -1, -1):
        try:
            root.sketches.item(i).deleteMe()
        except Exception:
            pass
    for i in range(root.constructionPlanes.count - 1, -1, -1):
        try:
            root.constructionPlanes.item(i).deleteMe()
        except Exception:
            pass
    root.isConstructionFolderLightBulbOn = False
    root.isSketchFolderLightBulbOn = False
    root.isOriginFolderLightBulbOn = False
    step("[%s] ready (bodies=%d)" % (name, root.bRepBodies.count))
    return doc, design, root


def z_plane(root, z, tag):
    pi = root.constructionPlanes.createInput()
    pi.setByOffset(root.xYConstructionPlane, V(z))
    pl = root.constructionPlanes.add(pi)
    pl.name = "zp_%s" % tag
    return pl


def _sp(sk, x, y, z=0.0):
    """模型坐标 -> 草图坐标（必须用 Fusion 自己的换算）。"""
    return sk.modelToSketchSpace(P(x, y, z))


def draw_rounded_rect(sk, x0, y0, x1, y1, r):
    """圆角矩形。

    ⚠️ 四条边按逆时针画，四段弧的**起点必须取对应边的起点**，否则边和弧接不上、
       profiles.count = 0（报"轮廓未闭合"）。
    """
    ln = sk.sketchCurves.sketchLines
    ar = sk.sketchCurves.sketchArcs
    p = lambda x, y: _sp(sk, x, y)
    ln.addByTwoPoints(p(x0 + r, y0), p(x1 - r, y0))          # 下
    ln.addByTwoPoints(p(x1, y0 + r), p(x1, y1 - r))          # 右
    ln.addByTwoPoints(p(x1 - r, y1), p(x0 + r, y1))          # 上
    ln.addByTwoPoints(p(x0, y1 - r), p(x0, y0 + r))          # 左
    ar.addByCenterStartSweep(p(x1 - r, y0 + r), p(x1 - r, y0), math.radians(90))   # 右下
    ar.addByCenterStartSweep(p(x1 - r, y1 - r), p(x1, y1 - r), math.radians(90))   # 右上
    ar.addByCenterStartSweep(p(x0 + r, y1 - r), p(x0 + r, y1), math.radians(90))   # 左上
    ar.addByCenterStartSweep(p(x0 + r, y0 + r), p(x0, y0 + r), math.radians(90))   # 左下


def draw_rect(sk, x0, y0, x1, y1):
    ln = sk.sketchCurves.sketchLines
    ln.addByTwoPoints(_sp(sk, x0, y0), _sp(sk, x1, y0))
    ln.addByTwoPoints(_sp(sk, x1, y0), _sp(sk, x1, y1))
    ln.addByTwoPoints(_sp(sk, x1, y1), _sp(sk, x0, y1))
    ln.addByTwoPoints(_sp(sk, x0, y1), _sp(sk, x0, y0))


def draw_circle(sk, cx, cy, d):
    sk.sketchCurves.sketchCircles.addByCenterRadius(_sp(sk, cx, cy), d / 2.0 * MM)


def op_at(root, z_lo, z_hi, draw, operation, name):
    """在 Z 区间 [z_lo, z_hi] 做一个拉伸/切除。

    ⚠️⚠️ 这个桥/版本里有两个反直觉行为，实测确认：

      1. `setByOffset(xYConstructionPlane, s)` 得到的平面**不影响拉伸的 Z 位置**——
         拉伸始终相对模型 Z=0 计量（平面在 +40，拉出来的实体却在 -5..0）。
      2. `setTwoSidesDistanceExtent(a, b)` 的实际区间是 **[-b, +a]**。

    所以配方是：**草图一律画在 XY 平面上**，用 `setTwoSidesDistanceExtent(z_hi, -z_lo)`
    把操作放到任意 Z 区间（实测 (10, -8) -> 恰好 8..10）。不用构造平面，完全确定。
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


def add_body(root, x0, y0, x1, y1, z_lo, z_hi, r, name):
    f = op_at(root, z_lo, z_hi,
              lambda sk: draw_rounded_rect(sk, x0, y0, x1, y1, r),
              adsk.fusion.FeatureOperations.NewBodyFeatureOperation, name)
    b = root.bRepBodies.item(root.bRepBodies.count - 1)
    b.name = name
    return b


def cut_rect(root, x0, y0, x1, y1, z_lo, z_hi, name):
    return op_at(root, z_lo, z_hi,
                 lambda sk: draw_rect(sk, x0, y0, x1, y1),
                 adsk.fusion.FeatureOperations.CutFeatureOperation, name)


def cut_circle(root, cx, cy, d, z_lo, z_hi, name):
    return op_at(root, z_lo, z_hi,
                 lambda sk: draw_circle(sk, cx, cy, d),
                 adsk.fusion.FeatureOperations.CutFeatureOperation, name)


def join_rect(root, x0, y0, x1, y1, z_lo, z_hi, name):
    return op_at(root, z_lo, z_hi,
                 lambda sk: draw_rect(sk, x0, y0, x1, y1),
                 adsk.fusion.FeatureOperations.JoinFeatureOperation, name)


def join_circle(root, cx, cy, d, z_lo, z_hi, name):
    return op_at(root, z_lo, z_hi,
                 lambda sk: draw_circle(sk, cx, cy, d),
                 adsk.fusion.FeatureOperations.JoinFeatureOperation, name)


def cut_circle_y(root, cx, cz, d, y_lo, y_hi, name):
    """沿 **Y** 方向切圆孔（草图画在 XZ 平面）。

    ⚠️ 桶形电源座、USB-C 这类**从侧壁穿出去**的孔，草图必须画在 XZ 平面上；
       画在 XY 平面上会变成沿 Z 的孔（实测只在外壁上留一条竖线）。
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


def info(root, key):
    b = root.bRepBodies.item(0)
    bb = b.boundingBox
    report["docs"][key] = {
        "volume_cm3": round(b.volume, 3),
        "mass_g_PLA": round(b.volume * 1.24, 1),
        "bbox_mm": [round((bb.maxPoint.x - bb.minPoint.x) / MM, 1),
                    round((bb.maxPoint.y - bb.minPoint.y) / MM, 1),
                    round((bb.maxPoint.z - bb.minPoint.z) / MM, 1)],
        "faces": b.faces.count,
    }


# --------------------------------------------------------------------------- #
# 背壳托盘
# --------------------------------------------------------------------------- #
def build_tray():
    doc, design, root = fresh(DOC_TRAY)
    ox0, oy0 = -WALL, -WALL
    ox1, oy1 = BOARD_W + WALL, BOARD_D + WALL

    add_body(root, ox0, oy0, ox1, oy1, TRAY_Z0, TRAY_Z1, 4.0, DOC_TRAY)
    step("托盘外形: %.3f cm3" % root.bRepBodies.item(0).volume)

    cx0, cy0, cx1, cy1 = -FIT, -FIT, BOARD_W + FIT, BOARD_D + FIT
    # Z<0 收 LEDGE -> 留 1.5mm 承板台阶
    cut_rect(root, cx0 - LEDGE, cy0 - LEDGE, cx1 + LEDGE, cy1 + LEDGE,
             TRAY_Z0 + FLOOR, 0.0, "cav_low")
    cut_rect(root, cx0, cy0, cx1, cy1, 0.0, TRAY_Z1 + 1.0, "cav_up")
    step("内腔+台阶: %.3f cm3" % root.bRepBodies.item(0).volume)

    wy0, wy1 = oy0 - 1.0, cy0 + 0.25   # 开到板边为止（再多会啃到板沿）
    cut_rect(root, PD_X - PD_W / 2, wy0, PD_X + PD_W / 2, wy1, PD_Z0, PD_Z1, "cut_pd")
    cut_circle_y(root, DC_X, DC_ZC, DC_D, wy0, wy1, "cut_dc")   # 桶形座沿 -Y 穿墙
    cut_rect(root, PICO_X - PICO_W / 2, wy0, PICO_X + PICO_W / 2, wy1,
             PICO_Z0, PICO_Z1, "cut_pico")
    step("底壁三孔: %.3f cm3" % root.bRepBodies.item(0).volume)

    info(root, DOC_TRAY)
    doc.save(doc.name)
    return doc


# --------------------------------------------------------------------------- #
# 前盖
# --------------------------------------------------------------------------- #
def build_cover():
    doc, design, root = fresh(DOC_COVER)
    ox0, oy0 = -WALL, -WALL
    ox1, oy1 = BOARD_W + WALL, BOARD_D + WALL
    cx0, cy0, cx1, cy1 = -FIT, -FIT, BOARD_W + FIT, BOARD_D + FIT

    # 低区整块
    add_body(root, ox0, oy0, ox1, oy1, SEAM, COVER_LO_TOP, 4.0, DOC_COVER)
    # 高区抬起
    join_rect(root, ox0, STEP_Y, ox1, oy1, SEAM, COVER_HI_TOP, "hi_block")
    step("前盖毛坯: %.3f cm3" % root.bRepBodies.item(0).volume)

    # 内腔
    cut_rect(root, cx0, cy0, cx1, cy1, SEAM - 1.0, COVER_LO_Z, "cav_lo")
    cut_rect(root, cx0, STEP_Y, cx1, cy1, SEAM - 1.0, COVER_HI_Z, "cav_hi")
    step("内腔: %.3f cm3" % root.bRepBodies.item(0).volume)

    # 止口（插入托盘内腔的一圈舌头）
    # ⚠️ join 的上界必须是 SEAM（前盖本体底面）。写成 SEAM-1.0 会与本体差 1mm，
    #    join 变成无操作、止口整圈消失（日志现象：体积 20.222 -> 20.222 不变）。
    join_rect(root, cx0, cy0, cx1, cy1, SEAM - TONGUE_D, SEAM + 0.2, "tongue_out")
    cut_rect(root, cx0 + TONGUE_T, cy0 + TONGUE_T, cx1 - TONGUE_T, cy1 - TONGUE_T,
             SEAM - TONGUE_D - 0.5, SEAM + 0.5, "tongue_in")
    step("止口: %.3f cm3" % root.bRepBodies.item(0).volume)

    # OLED 窗口（高区顶面）
    cut_rect(root, OLED_X - OLED_W / 2, OLED_Y - OLED_H / 2,
             OLED_X + OLED_W / 2, OLED_Y + OLED_H / 2,
             COVER_HI_Z - 2.0, COVER_HI_TOP + 1.0, "win_oled")
    step("OLED 窗口")

    # 右侧壁传感器窗口
    cut_rect(root, BOARD_W + FIT - 1.0, SENSOR_Y0, BOARD_W + WALL + 1.0, SENSOR_Y1,
             SENSOR_Z0, SENSOR_Z1, "win_sensor")
    step("传感器窗口")

    # 顶壁 Ø6 SMA 通孔（左上，向上）
    # ⚠️ 必须用 cut_circle_y（草图画在 XZ 平面）——画在 XY 平面上孔轴会变成 Z，
    #    在顶壁上留下的是矩形/长条而不是 Ø6 圆孔（用户实测指出的）。
    cut_circle_y(root, SMA_X, SMA_Z, SMA_D,
                 BOARD_D + FIT - 1.0, BOARD_D + WALL + 1.0, "hole_sma")
    step("SMA Ø%.1f" % SMA_D)

    # 顶壁右侧 GPS 贴片浅槽 + 挡边
    wall_in, wall_out = BOARD_D + FIT - 0.5, BOARD_D + WALL
    # 贯穿顶壁的槽（Z 7..13），X 方向为贴片长度
    cut_rect(root, GPS_X0, wall_in, GPS_X1, wall_out + 1.0, GPS_Z0, GPS_Z1, "pocket_gps")
    # 槽底托住贴片（贴片躺在 Z=7 上）
    join_rect(root, GPS_X0 - GPS_LIP, wall_in, GPS_X1 + GPS_LIP, wall_out,
              GPS_Z0 - GPS_DEPTH, GPS_Z0, "gps_floor")
    # 外侧上沿两条挡边，压住贴片不会掉出来
    join_rect(root, GPS_X0 - GPS_LIP, wall_out - GPS_LIP, GPS_X1 + GPS_LIP, wall_out,
              GPS_Z1, GPS_Z1 + GPS_LIP, "gps_tab")
    step("GPS 槽")

    # DC5521 局部加高：外侧凸台 + 内侧凹腔
    join_rect(root, DC_POCKET_X0, DC_POCKET_Y0, DC_POCKET_X1, DC_POCKET_Y1,
              COVER_LO_TOP, DC_BOSS_Z, "dc_boss")
    cut_rect(root, DC_POCKET_X0 + 1.0, DC_POCKET_Y0 + 1.0,
             DC_POCKET_X1 - 1.0, DC_POCKET_Y1 - 1.0,
             COVER_LO_Z, DC_POCKET_Z, "dc_pocket")
    step("DC 凸台 + 凹腔")

    # 两块**互相独立**的按键板：各自三边挖槽、靠顶部 1.3mm 铰链悬臂，内侧各一个凸起。
    # 之前把两个按钮做成了一整块（用户指出：要能分别控制）——所以中间那道槽必须切开。
    py0, py1 = BTN_Y - PLATE_H / 2, BTN_Y + PLATE_H / 2
    zt0, zt1 = COVER_LO_Z - 1.0, COVER_LO_TOP + 1.0
    lx0, lx1 = BTN_X - BTN_DX - PLATE_W / 2, BTN_X - BTN_DX + PLATE_W / 2
    rx0, rx1 = BTN_X + BTN_DX - PLATE_W / 2, BTN_X + BTN_DX + PLATE_W / 2
    cut_rect(root, lx0 - SLOT_W, py0 - SLOT_W, lx0, py1 + SLOT_W, zt0, zt1, "slot_l_out")
    cut_rect(root, lx1, py0 - SLOT_W, rx0, py1 + SLOT_W, zt0, zt1, "slot_mid")
    cut_rect(root, rx1, py0 - SLOT_W, rx1 + SLOT_W, py1 + SLOT_W, zt0, zt1, "slot_r_out")
    cut_rect(root, lx0 - SLOT_W, py0 - SLOT_W, rx1 + SLOT_W, py0, zt0, zt1, "slot_bot")
    hz = COVER_LO_Z + (COVER_LO_TOP - COVER_LO_Z) - HINGE_T
    cut_rect(root, lx0, py1 - 1.0, lx1, py1 + SLOT_W, COVER_LO_Z, hz, "hinge_l")
    cut_rect(root, rx0, py1 - 1.0, rx1, py1 + SLOT_W, COVER_LO_Z, hz, "hinge_r")
    bz0, bz1 = COVER_LO_Z - BUMP_H, COVER_LO_Z + 1.0
    join_circle(root, BTN_X - BTN_DX, BTN_Y, BUMP_R * 2, bz0, bz1, "bump_a")
    join_circle(root, BTN_X + BTN_DX, BTN_Y, BUMP_R * 2, bz0, bz1, "bump_b")
    step("两块独立按键板（各三边挖槽 + 一个凸起）")

    info(root, DOC_COVER)
    doc.save(doc.name)
    return doc


# --------------------------------------------------------------------------- #
for fn in (build_tray, build_cover):
    try:
        fn()
    except Exception as exc:
        report["errors"].append("%s: %s: %s" % (fn.__name__, type(exc).__name__, exc))

result = report
