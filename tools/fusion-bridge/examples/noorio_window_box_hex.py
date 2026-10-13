# -*- coding: utf-8 -*-
"""WindowBox 的蜂窝变体 —— 另存为独立的 `WindowBoxHex`。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

用户要求：

    第一圈（靠窗那半）不要，那里实心
    从第二圈开始、按同样间距一直排到尾部
    挂耳不要
    单独存成 WindowBoxHex（不动原来的 WindowBox）

# 实现方式：给基础脚本套一层参数

几何只有一份（`noorio_window_box.py`），变体只差三件事 —— 哪几圈打蜂窝、
要不要挂耳、存成哪个文件。所以这里设 `WINDOWBOX_OVERRIDES` 再 exec 基础脚本。
⚠️ 覆盖必须在 exec **之前**写进 globals：基础脚本第一件事就是读它。

# 蜂窝行距

外接圆 R=5 的正六边形，标准蜂窝节距是：
    方位向孔距 = √3R ≈ 11.7mm   -> 每圈 30 孔（r=55.5 处）
    轴向行距   = 1.5R ≈ 10mm    -> y = 14 / 24 / 34 三圈
孔间留约 3mm 筋。这铺满了圆柱中段（y 约 9..39），只在前端
（法兰 + 过渡段，y<9）和赤道附近（y>39，紧接着就是半球段）留实心。

⚠️ 半球尾部仍然做不了：本版本 Fusion 没有任何构造能给出球面切平面
（六条路的实测结果见 noorio_window_box.py 的文件头注释）。
要打通尾部必须把外壳尾部由半球改成圆锥。
"""

import io

BASE = r"C:\Users\WANGZ\Documents\GitHub\dsh-app\tools\fusion-bridge\examples\noorio_window_box.py"

WINDOWBOX_OVERRIDES = {
    "file_name": "WindowBoxHex",
    # 铺满圆柱段。真正的蜂窝节距 —— 外接圆 R=5 时
    #   方位向孔距 = √3R ≈ 11.7mm -> 每圈 30 孔
    #   轴向行距   = 1.5R ≈ 10mm   -> y = 14 / 24 / 34 三圈（覆盖 y 约 9..39）
    # 孔间留约 3mm 筋，行间错开半格。
    "hex_row_y": [24.0],
    "hex_pitch": 11.7,
    # ⚠️ 两道 0.3mm 浅环槽，把外柱面分成 10..20 / 20..30 / 30..45 三段。
    #    必须这样：实测切平面只在**它原点以下**的半边有效，而 setByTangent 的
    #    原点落在该段柱面的中高处。不分段的话整根柱面（中高 27.5）只有 y<27.5
    #    能打孔 —— y=30 只切到 −1.1 cm3，y=34 起直接报错。
    #    分段后各段中点为 15 / 25 / 37.5，三圈 14 / 24 / 34 都落在下半部。
    #    槽线落在蜂窝孔内部区域，基本看不见。
    "hook": False,
}

exec(compile(io.open(BASE, encoding="utf-8").read(), BASE, "exec"))

