# Noorio B310 —— 球形摄像机的支架与窗户挂盒

给 Noorio B310（Ø100 球形摄像机）做的两套东西：

1. **桌面支架**（`Stand v5` + `Gimbal B210`）—— 球机横放（支架转 90°），重心算过、能稳
2. **窗户挂盒**（`WindowBox` / `WindowBoxHex`）—— 吸在玻璃上，球机从前方塞进去

建模全部通过 `fusion/bridge_client.py` 驱动 Fusion 360 完成。桥怎么用见
[../README.md](../README.md)。

---

## 零件清单

| 文档 | 是什么 | 体积 / 质量 | 打印 |
|---|---|---|---|
| `Camera B210` | 摄像机模型（**测量基准**，不是产品件） | — | 建议 5% 填充 / 2 圈墙 |
| `Bottom_bottom` | 球头底座（维护者原有文件） | — | — |
| `Gimbal B210` | 万向节：两段锥 + 球头 + M5 螺柱 | 14.702 + 2.853 cm³ | 需支撑 |
| `Stand v5` | 桌面支架本体 | 313.7 cm³ | 与底座合并打印 |
| `Stand v5 + bottom` | 派生合并后的**实际打印件** | **329.763 cm³ / 389 g** | 0.2mm 层高 |
| `WindowBox` | 窗户挂盒 · **实心版** | **179.728 cm³ / 222.9 g** | 4.9mm 壁 |
| `WindowBoxHex` | 窗户挂盒 · **蜂窝版** | **149.353 cm³ / 185.2 g** | 4.9mm 壁 |
| `Assembly B210` | 桌面整机装配（只用来验重心） | — | 不打印 |

---

## 关键尺寸

### 摄像机（`Camera B210`，一切配合的基准）

- 半球 **Ø100 / R50**，球心即质心
- 后部 Ø5 螺孔；前方 27mm 球面收锥 Ø100 → Ø90
- 补光灯区域 8mm、传感器区域 5mm、镜头为平面
- 质量 **456 g**

### 万向节（`Gimbal B210`）

- 第 1 段 15mm：Ø53 → Ø50；第 2 段 15mm：Ø50 → Ø23
- 内孔 Ø41，壁厚 2.0mm，开口 R6.75
- 螺纹 **M42×1**（`ThreadInfo.create` 的 `isTapered` 必须为 `False`）
- 球头 Ø17 凸出 4mm，接 18mm M5 螺柱

### 窗户挂盒

- 前段外柱 R55.5、内腔 R50.6，y = 0…45；后段外球面 R55.5
- 内腔为 R50.6 球面 → 正好托住 R50 的球机（单边 0.6mm 间隙）
- 尾部 Ø60 收口孔（y 85.75…91.69），法兰 r54 → r80、厚 3mm、360° 整圈
- 球机**从前方装入**（前方开口 Ø101.2），靠玻璃压住；取出即向前抽出
- 挂耳：Ø6 眼孔，宽 15、厚 10
- 壁厚 **4.9mm**（用户要求"支柱厚一点"；改回 3.4mm 可减重约 50g）

`WindowBoxHex` 额外有 **3 圈 × 30 = 90 个六边形通孔**：

- 正六边形外接圆 R5，标准蜂窝节距 —— 方位向 √3R ≈ 11.7mm（每圈 30 孔）、轴向 1.5R ≈ 10mm
- 圈位 y = 12 / 24 / 36，覆盖 y 约 7…41（圆柱段 10…45 的绝大部分）
- 孔间留约 3mm 筋，行间错开半格
- 另有两道 **0.3mm 浅环槽**（y = 18 / 30），落在两圈孔之间的缝里，肉眼基本看不见

### 装配与平衡（`Assembly B210`）

- 支架 identity；底座 y₀ = 6；万向节 y₀ = 4；摄像机 y₀ = **−91**
- 质量：摄像机 456 g、万向节 45 g
- 整机重心 **(0, −48.24, 72.17)**；前缘余量 **71.8mm**；倾倒角 **44.8°**

---

## 脚本

全部用桥执行（`<本文件>` 换成脚本路径）：

```powershell
python fusion\bridge_client.py exec --file fusion\noorio-b310\noorio_camera_body.py --timeout 600
```

| 脚本 | 做什么 |
|---|---|
| `noorio_camera_body.py` | 建摄像机几何 |
| `noorio_camera_materials.py` | 给摄像机各区域上材质外观 |
| `noorio_bottom_thread.py` | 球头底座（维护者原有文件的脚本化） |
| `noorio_b310_stand.py` | 桌面支架 `Stand v5`（可原地重建） |
| `noorio_gimbal_mount.py` | 万向节 `Gimbal B210` |
| `noorio_window_box.py` | 挂盒基础脚本（参数化：圈位 / 节距 / 要不要挂耳 / 环槽） |
| `noorio_window_box_hex.py` | **蜂窝版包装**：换一组参数 exec 基础脚本，几何只有一份 |
| `noorio_window_fit.py` | 挂盒与球机的干涉检查（会新建一个临时文档） |
| `noorio_assemble_base.py` | 把底座派生进支架并合并成**一个打印件** |
| `noorio_assembly.py` | 桌面整机装配 + 重心/倾倒角计算 |
| `noorio_export_stl.py` | 导出 STL 到仓库根 `exports/`（文档没打开会明确报出来） |
| `shoot_views.py` | 批量出渲染图 |

> `WindowBox`（实心）和 `WindowBoxHex`（蜂窝）是**同一份几何代码的两个参数值**：
> 基础脚本的 `HEX_ROW_Y` 留空即实心。改一处两边都不会分叉。

---

## 打印建议

- **摄像机模型只是量具**：5% 填充 + 2 圈墙就够，实心会白烧约 450g
- 关键配合是**内腔 Ø101.2 对球机 Ø100**（单边 0.6mm）。先打这一件试，能顺畅塞进去再打挂盒
- 万向节的两段锥与 M5 螺柱需要支撑；球头 Ø17 建议 0.12mm 层高
- 挂盒竖着打（开口朝上）不需要支撑
- 4.9mm 壁的挂盒重 222.9g（实心）/ 185.2g（蜂窝）；**蜂窝版还能改善内部散热**

---

## 踩过的坑（改脚本前先看这里）

这些都是实测撞出来的，不是文档抄的。踩一次就够了。

### 坐标与草图

- **模型坐标 → 草图坐标必须用 `sketch.modelToSketchSpace(pt)`。**
  草图原点**不是** `plane.geometry.origin`，而是"世界原点在该平面上的投影"。
  自己用 `(pt-origin)·uDirection` 换算，会让图形沿某轴**整体平移几十毫米**，
  而且**不报错**——本项目因此在 `WindowBoxHex` 上浪费了十几轮，
  孔被切到贴胶布的法兰上才发现。
- `sketchPoints.add()` 收的是**草图坐标**，不是模型坐标；喂模型坐标会把图形扔到几十毫米外。
- `sketchLines.addByTwoPoints()` 要**草图坐标**；喂模型坐标会生成"3D 轮廓"，
  轮廓数仍是 1，但拉伸时报"未找到要剪切或相交的目标实体"。

### 文档与线程

- **绝不用 `app.activeProduct` / `wait_active()`** —— 桥里的 `activate()` 是延迟的，
  会拿到**错误的文档**（本项目曾因此把维护者的 `Stand v5` 整份覆盖掉）。
  只用 `Design.cast(doc.products.itemByProductType("DesignProductType"))` + 校验 `doc.name`。
- API 只能在**主线程**调用；从工作线程碰它不是抛异常，而是 Fusion 进程直接消失。
- `fireCustomEvent` **永远返回 False 但确实投递了**，别用返回值判断成功。
- 内部单位是 **cm 与弧度**（mm × 0.1）。
- 跨文档重绘：`activate()` + 约 6 秒 `doEvents()`/`refresh()` 才会真的重绘。

### 几何特征

- `setByThreePoints` 在本版本**完全不可用**（平凡三点也报 InternalValidationError）。
- `setByPlane` → `Environment is not supported`。
- `setByTangent(face, angle, refPlane)` 的 `face` **必须是圆柱面**，参考平面**必须 XY**
  （XZ 与柱轴平行，被拒）。
- `setByTangentAtPoint(face, point)` **忽略给定点的位置**（要 +X 侧却给 +Z 侧）。
- `setByAngleOnCurvedFace` 只收**圆柱/圆锥**面 —— 球面全部堵死。
  **结论：本版本做不出"球面切平面"**，所以蜂窝只能做在圆柱段，半球尾部做不了。
- 切平面**必须在切第一个孔之前全部建好**：切过之后圆柱面会被重建，角度基准会漂。
- 切平面的"有效半边"很窄：分段（每段一个平面、孔打在该段中高附近）才稳。
  `WindowBoxHex` 用两道 0.3mm 环槽把外柱面分成 10…18 / 18…30 / 30…45 三段。
- **`setDistanceExtent(False, d)`** 单向可用；`setDistanceExtent(True, d)` 与
  `setAllExtent(SymmetricExtentDirection)` 会**在对侧再切一个洞**。
- `RevolveFeatureInput` **没有 `setFullExtent`** —— 整圈用
  `setAngleExtent(False, ValueInput.createByReal(2*pi))`。
- `ThreadInfo.create(isTapered, ...)` 里 `isTapered` 必须 `False`，否则报
  "cannot get specific size"；规格匹配要用**全等**（`startswith("M42x1")` 会误配 M42x1.5）。
- `derive_input.sourceEntities` 必须是 **Python list**。
- `MoveFeatureInput` 没有 `defineAsTransform` —— 直接给 `mi.transform` 赋值。
- 面属性枚举**必须先按 `objectType` 筛**：`Plane` 面没有 `.radius`，直接取会 AttributeError。
- `ConstructionPlane.isVisible` 是**只读**的；隐藏构造几何要用
  `root.isConstructionFolderLightBulbOn` / `isSketchFolderLightBulbOn` / `isOriginFolderLightBulbOn`。
- `exportManager` 挂在 **`Design`** 上，不是 `Application`。

### 定位问题的顺序

**先量，再改。** `WindowBoxHex` 那轮如果一开始就查一下孔的实际坐标
（一次面包围盒查询就够），能省掉十几轮对着渲图猜"拉伸方向""法线朝向""有效半边"。
渲图角度**会被法兰挡住外柱面**，从正面开口看进去有孔就以为成了 —— 要**从侧后方看**。
